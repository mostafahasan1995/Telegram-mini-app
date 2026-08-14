/**
 * WHY `botInfo` is preset rather than letting grammY call getMe() during `bot.init()`:
 *  - `bot.handleUpdate()` throws unless the Bot is initialized, so a webhook-driven process would
 *    otherwise have to await a network round trip before it could answer its first update.
 *  - Every container restart would hit Telegram before becoming useful, which during a Telegram
 *    outage means the pod never becomes ready — for a service whose job is mostly talking to
 *    Postgres.
 * So getMe() runs at most once per BOT_INFO_TTL_SECONDS and the answer is shared through Redis.
 *
 * The failure policy differs by role, deliberately:
 *  - worker  : dispatches handlers, needs `ctx.me` for command matching in groups -> hard failure.
 *  - api     : only persists and enqueues updates, and uses `bot.api.*` for outbound calls (which
 *              does not require init) -> boots without botInfo and logs a warning.
 */
import { Logger } from '@nestjs/common';
import { autoRetry } from '@grammyjs/auto-retry';
import { Api, Bot } from 'grammy';
import { type UserFromGetMe } from 'grammy/types';
import { type AppConfigService } from '../../config/config.service';
import { type CacheService } from '../../cache/cache.service';
import { BOT_INFO_CACHE_KEY, BOT_INFO_TTL_SECONDS } from '../telegram.constants';

const logger = new Logger('TelegramBotFactory');

export async function createTelegramBot(
  config: AppConfigService,
  cache: CacheService,
): Promise<Bot> {
  const token = config.telegram.botToken;
  const botInfo = await resolveBotInfo(token, config, cache);

  const bot = botInfo === undefined ? new Bot(token) : new Bot(token, { botInfo });

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

  return bot;
}

async function resolveBotInfo(
  token: string,
  config: AppConfigService,
  cache: CacheService,
): Promise<UserFromGetMe | undefined> {
  const cached = await cache.get<UserFromGetMe>(BOT_INFO_CACHE_KEY).catch(() => null);
  if (cached && typeof cached.id === 'number' && typeof cached.username === 'string') {
    return cached;
  }

  try {
    // A bare Api instance avoids constructing a throwaway Bot just to ask who we are.
    const botInfo = await new Api(token).getMe();
    await cache.set(BOT_INFO_CACHE_KEY, botInfo, BOT_INFO_TTL_SECONDS).catch(() => undefined);
    logger.log(`Telegram bot identified as @${botInfo.username} (${botInfo.id})`);
    return botInfo;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    if (config.app.isWorker) {
      // The worker cannot match commands or populate ctx.me without this. Failing at boot is
      // honest; starting and mis-handling every group command is not.
      throw new Error(`Unable to resolve Telegram bot identity (getMe failed): ${message}`);
    }

    logger.warn(
      `getMe() failed (${message}); starting without botInfo. ` +
        'Inbound updates are still persisted and queued; only outbound API calls are affected.',
    );
    return undefined;
  }
}
