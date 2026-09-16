/**
 * How ONE tenant's grammY Bot is assembled. TenantBotRegistry decides when; this file decides how,
 * so every tenant's bot is built the same way.
 *
 * WHY THERE IS NO BOT AT BOOT ANY MORE: the old factory built a single Bot from a global env token
 * and called getMe while Nest was constructing providers. The worker hard-failed when that call
 * failed, so one revoked token put the whole worker, and every other operator's money path with it,
 * into a crash loop. Each operator now has its own token in `tenants.bot_token_enc`, and a Bot is
 * built on first use for that operator only. A broken token is that operator's problem.
 *
 * WHY `botInfo` IS ALWAYS PRESET: `bot.handleUpdate()` throws unless the Bot is initialized, and
 * `bot.init()` is a getMe round trip. The registry supplies the identity (from its cache, or from
 * one getMe) before the Bot exists, so dispatching an update never waits on Telegram.
 */
import { autoRetry } from '@grammyjs/auto-retry';
import { createHash } from 'node:crypto';
import { Bot, type ApiClientOptions, type Composer, type Context, GrammyError } from 'grammy';
import { type UserFromGetMe } from 'grammy/types';

export interface TenantBotOptions {
  token: string;
  botInfo: UserFromGetMe;
  /** Test seam (a `fetch` stub). Undefined in production. */
  clientOptions?: ApiClientOptions;
  /** The discovered handler composition. Null in the api role, which never dispatches updates. */
  middleware?: Composer<Context> | null;
  /**
   * Called when Telegram answers ANY call made with this token with 401 or 404, including calls a
   * handler makes through `ctx.api`, whose errors the handler wrappers swallow. This is how a cached
   * Bot learns its token was revoked.
   */
  onTokenRejected?: () => void;
}

/**
 * Telegram's answers for a token it will not accept: 401 for a revoked or wrong secret, 404 for a
 * bot id that does not exist. No other failure means the token itself is bad.
 */
const TOKEN_REJECTION_CODES: ReadonlySet<number> = new Set([401, 404]);

export function isTokenRejection(error: unknown): error is GrammyError {
  return error instanceof GrammyError && TOKEN_REJECTION_CODES.has(error.error_code);
}

/**
 * The numeric bot id a token starts with, or null when the value is not shaped like a token at all.
 * The id is public (it is the bot's user id), so it may appear in a cache key. The secret part after
 * the colon may not.
 */
export function botIdFromToken(token: string): string | null {
  const match = /^(\d+):[A-Za-z0-9_-]+$/.exec(token);
  return match?.[1] ?? null;
}

/**
 * Binds a cached identity to the exact token it was fetched with. SHA-256 of a high-entropy secret
 * cannot be reversed, and the raw token must never be written to Redis.
 */
export function fingerprintBotToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function buildTenantBot(options: TenantBotOptions): Bot {
  const bot = new Bot(options.token, {
    botInfo: options.botInfo,
    ...(options.clientOptions === undefined ? {} : { client: options.clientOptions }),
  });

  // autoRetry handles the two failures that are guaranteed to happen in production and are not
  // our fault: 429 (Telegram's own flood limits, honouring their `retry_after`) and transient 5xx.
  // Bounded on purpose — an unbounded retry inside a queue job would hold a per-player mutex open.
  bot.api.config.use(
    autoRetry({
      maxRetryAttempts: 3,
      // Telegram can ask for a very long wait; past a minute, failing the job and letting BullMQ
      // reschedule it is better than pinning a worker slot.
      maxDelaySeconds: 60,
      rethrowInternalServerErrors: false,
      rethrowHttpErrors: false,
    }),
  );

  const onTokenRejected = options.onTokenRejected;
  if (onTokenRejected !== undefined) {
    // Installed after autoRetry, so it sees the final answer. It only observes: the caller still
    // gets Telegram's error exactly as before. grammY copies these transformers onto the `ctx.api`
    // of every update it dispatches, so a handler's rejected reply is seen here too.
    bot.api.config.use(async (prev, method, payload, signal) => {
      const response = await prev(method, payload, signal);
      if (!response.ok && TOKEN_REJECTION_CODES.has(response.error_code)) onTokenRejected();
      return response;
    });
  }

  if (options.middleware !== undefined && options.middleware !== null) {
    bot.use(options.middleware);
  }

  return bot;
}
