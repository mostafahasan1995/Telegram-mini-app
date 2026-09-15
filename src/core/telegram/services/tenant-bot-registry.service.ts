/**
 * ONE grammY Bot PER OPERATOR, built when that operator first needs it and never at boot.
 *
 * WHY A REGISTRY AND NOT A SINGLETON: every operator pastes its own bot token in the dashboard, and
 * it is stored sealed in `tenants.bot_token_enc`. There is no global token any more. A process may
 * have to serve many bots, and must keep serving the rest when one of them is broken. So the Bot is
 * looked up by tenant, and every failure is that tenant's, carried as a TenantBotUnavailableError.
 *
 * HOW `get(tenantId)` ANSWERS:
 *  1. A Bot built less than TENANT_BOT_RECHECK_SECONDS ago is returned as is.
 *  2. Otherwise the sealed token is re-read (one primary-key lookup). If it is unchanged, the same
 *     Bot is kept; if it changed, the old Bot is dropped. This is how a token changed through ANOTHER
 *     process reaches this one, since `invalidate()` only reaches this process's memory.
 *  3. A new Bot needs the bot's identity. It comes from Redis under
 *     `telegram:botinfo:<tenantId>:<botId>` when the cached entry was fetched with this exact token
 *     (fingerprint match), and otherwise from one getMe, whose answer is cached for the next process.
 *
 * WHAT A STALE CACHE CAN AND CANNOT DO: a cached identity is never proof a token works. A different
 * bot has a different key, and a different token for the same bot has a different fingerprint, so
 * neither inherits it. A token revoked at BotFather keeps the same key and fingerprint, so it is
 * caught the moment Telegram answers any call with 401/404: `onTokenRejected` drops the Bot and
 * deletes the cached identity, and the next `get()` runs getMe and fails that tenant cleanly.
 *
 * CONCURRENCY: concurrent `get()`s for one tenant share one load, so five queued updates cause one
 * getMe, not five. A failure that retrying cannot fix is remembered for TENANT_BOT_FAILURE_MEMO_SECONDS
 * per sealed value, so a broken operator's backlog does not hammer Telegram with the same 401.
 *
 * NOTHING HERE LOGS OR THROWS A TOKEN. Messages carry the tenant id and the bot's public id only.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Api, type ApiClientOptions, type Bot } from 'grammy';
import { type UserFromGetMe } from 'grammy/types';

import { CacheService } from '../../cache/cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  TenantSecretErrorCodes,
  TenantSecretService,
  isTenantSecretError,
} from '../../tenant/services/tenant-secret.service';
import {
  BOT_INFO_TTL_SECONDS,
  TELEGRAM_API_CLIENT_OPTIONS,
  TENANT_BOT_FAILURE_MEMO_SECONDS,
  TENANT_BOT_RECHECK_SECONDS,
  telegramBotInfoCacheKey,
} from '../telegram.constants';
import {
  TenantBotErrorCodes,
  TenantBotUnavailableError,
  isTenantBotUnavailableError,
} from '../tenant-bot.errors';
import { verifyTelegramChat, type ChatVerification } from '../utils/chat-verification.util';
import {
  botIdFromToken,
  buildTenantBot,
  fingerprintBotToken,
  isTokenRejection,
} from './bot.factory';
import { TelegramHandlerRegistrar } from './handler-registrar.service';

/** What is written to Redis: the identity, and which token it belongs to. Never the token. */
interface CachedBotInfo {
  tokenFingerprint: string;
  botInfo: UserFromGetMe;
}

interface Entry {
  bot: Bot;
  /** The `bot_token_enc` value the Bot was built from; a different value means the token changed. */
  sealedToken: string;
  fingerprint: string;
  botId: string;
  /** Date.now() when the sealed token was last confirmed unchanged. */
  verifiedAt: number;
}

interface Failure {
  sealedToken: string;
  error: TenantBotUnavailableError;
  until: number;
}

/**
 * Who a token that is not stored anywhere yet belongs to, as Telegram answers getMe.
 *
 * `rejected` separates the two failures a caller must tell apart: a token Telegram refused (the
 * person typed it wrong, a 400 to them) from a Telegram that could not be asked (retry later).
 * `reason` never carries the token.
 */
export type TokenIdentity =
  | { ok: true; botInfo: UserFromGetMe }
  | { ok: false; rejected: boolean; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class TenantBotRegistry {
  private readonly logger = new Logger(TenantBotRegistry.name);

  private readonly entries = new Map<string, Entry>();
  private readonly loading = new Map<string, Promise<Bot>>();
  private readonly failures = new Map<string, Failure>();
  /**
   * Bumped by `invalidate()`. A load that started before the bump still answers its own caller,
   * but must not store what it built, or the token that was just replaced would come back.
   */
  private readonly generations = new Map<string, number>();
  /** tenantId -> the failure code already logged, so a broken operator's backlog logs once. */
  private readonly loggedFailures = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly secrets: TenantSecretService,
    private readonly registrar: TelegramHandlerRegistrar,
    @Optional()
    @Inject(TELEGRAM_API_CLIENT_OPTIONS)
    private readonly clientOptions?: ApiClientOptions,
  ) {}

  /**
   * The operator's Bot, with its identity preset and, in the worker, every discovered handler
   * attached. Throws TenantBotUnavailableError for anything that is this operator's problem; any
   * other error is infrastructure (the database is down) and surfaces unchanged.
   */
  async get(tenantId: string): Promise<Bot> {
    const entry = this.entries.get(tenantId);
    if (entry !== undefined && Date.now() - entry.verifiedAt < TENANT_BOT_RECHECK_SECONDS * 1_000) {
      return entry.bot;
    }

    const pending = this.loading.get(tenantId);
    if (pending !== undefined) return pending;

    const load = this.load(tenantId).finally(() => {
      this.loading.delete(tenantId);
    });
    this.loading.set(tenantId, load);
    return load;
  }

  /**
   * Forget this operator's Bot and its cached identity in THIS process. MUST be called by whatever
   * changes a tenant's bot token (or suspends it), so the next `get()` reads the row again. Other
   * processes notice within TENANT_BOT_RECHECK_SECONDS.
   */
  async invalidate(tenantId: string): Promise<void> {
    this.generations.set(tenantId, this.generationOf(tenantId) + 1);
    const entry = this.entries.get(tenantId);
    this.entries.delete(tenantId);
    this.failures.delete(tenantId);
    this.loggedFailures.delete(tenantId);
    if (entry !== undefined) {
      await this.forgetBotInfo(tenantId, entry.botId);
    }
  }

  /**
   * One getMe for a token that is not on any tenant row yet: the token pasted into "create operator"
   * or "replace bot", checked before it is sealed so a bad one never lands.
   *
   * WHY HERE AND NOT `new Api(token)` AT THE CALL SITE: the registry holds the client options every
   * tenant Bot is built with. A token verified through a different client than the one that will use
   * it verifies nothing about the path it will take, and in tests it would reach api.telegram.org.
   *
   * Nothing is cached or built: the token belongs to no operator until the caller stores it, and the
   * next `get()` for that operator identifies it again through the normal path.
   */
  async identifyToken(token: string): Promise<TokenIdentity> {
    if (botIdFromToken(token) === null) {
      return { ok: false, rejected: true, reason: 'it is not shaped like a Telegram bot token' };
    }
    try {
      return { ok: true, botInfo: await new Api(token, this.clientOptions).getMe() };
    } catch (error: unknown) {
      if (isTokenRejection(error)) {
        return {
          ok: false,
          rejected: true,
          reason: `Telegram answered ${error.error_code}: ${error.description}`,
        };
      }
      // grammY keeps the request URL, and so the token, out of its messages unless sensitiveLogs is
      // enabled, which nothing here does.
      return {
        ok: false,
        rejected: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * verifyTelegramChat for a token that is not on any tenant row yet: the chats named on the create
   * form are checked with the pasted token before anything is written. Same client options as every
   * tenant Bot, for the reason `identifyToken` gives. Telegram failures that say nothing about the
   * chat are thrown for the caller to map.
   */
  verifyChatWithToken(token: string, botId: number, chatId: bigint): Promise<ChatVerification> {
    return verifyTelegramChat(new Api(token, this.clientOptions), botId, chatId);
  }

  private async load(tenantId: string): Promise<Bot> {
    const generation = this.generationOf(tenantId);

    try {
      if (!UUID.test(tenantId)) throw this.notFound(tenantId);

      const row = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { botTokenEnc: true },
      });
      if (row === null) {
        this.entries.delete(tenantId);
        throw this.notFound(tenantId);
      }

      const current = this.entries.get(tenantId);
      if (current !== undefined) {
        if (current.sealedToken === row.botTokenEnc) {
          current.verifiedAt = Date.now();
          return current.bot;
        }
        this.logger.log(`Bot token of tenant ${tenantId} changed; rebuilding its Telegram bot`);
        this.entries.delete(tenantId);
        await this.forgetBotInfo(tenantId, current.botId);
      }

      const remembered = this.failures.get(tenantId);
      if (
        remembered !== undefined &&
        remembered.sealedToken === row.botTokenEnc &&
        Date.now() < remembered.until
      ) {
        throw remembered.error;
      }
      this.failures.delete(tenantId);

      const entry = await this.build(tenantId, row.botTokenEnc);
      if (this.generationOf(tenantId) === generation) {
        this.entries.set(tenantId, entry);
      }
      this.loggedFailures.delete(tenantId);
      return entry.bot;
    } catch (error: unknown) {
      if (isTenantBotUnavailableError(error)) this.noteFailure(error);
      throw error;
    }
  }

  private async build(tenantId: string, sealedToken: string): Promise<Entry> {
    const token = this.openToken(tenantId, sealedToken);

    const botId = botIdFromToken(token);
    if (botId === null) {
      throw this.remember(
        sealedToken,
        new TenantBotUnavailableError(
          TenantBotErrorCodes.TENANT_BOT_TOKEN_REJECTED,
          tenantId,
          false,
          `The bot token of tenant ${tenantId} is not shaped like a Telegram bot token`,
        ),
      );
    }

    const fingerprint = fingerprintBotToken(token);
    const cacheKey = telegramBotInfoCacheKey(tenantId, botId);
    const botInfo =
      (await this.readBotInfo(cacheKey, fingerprint, botId)) ??
      (await this.fetchBotInfo(tenantId, sealedToken, token, cacheKey, fingerprint));

    const bot = buildTenantBot({
      token,
      botInfo,
      ...(this.clientOptions === undefined ? {} : { clientOptions: this.clientOptions }),
      middleware: this.registrar.middleware(),
      onTokenRejected: () => {
        void this.onTokenRejected(tenantId, fingerprint);
      },
    });

    this.logger.log(`Telegram bot for tenant ${tenantId} is @${botInfo.username} (${botInfo.id})`);
    return { bot, sealedToken, fingerprint, botId, verifiedAt: Date.now() };
  }

  private openToken(tenantId: string, sealedToken: string): string {
    try {
      return this.secrets.openBotToken({ id: tenantId, botTokenEnc: sealedToken });
    } catch (error: unknown) {
      if (!isTenantSecretError(error)) throw error;
      const code =
        error.code === TenantSecretErrorCodes.TENANT_SECRET_UNCONFIGURED
          ? TenantBotErrorCodes.TENANT_BOT_UNCONFIGURED
          : TenantBotErrorCodes.TENANT_BOT_UNREADABLE;
      // TenantSecretError messages name the field and the tenant, never a value.
      throw this.remember(
        sealedToken,
        new TenantBotUnavailableError(code, tenantId, false, error.message),
      );
    }
  }

  /** The cached identity, only if it was fetched with this exact token for this exact bot. */
  private async readBotInfo(
    cacheKey: string,
    fingerprint: string,
    botId: string,
  ): Promise<UserFromGetMe | null> {
    const cached = await this.cache.get<CachedBotInfo>(cacheKey).catch(() => null);
    if (cached === null || cached.tokenFingerprint !== fingerprint) return null;
    const info = cached.botInfo;
    if (typeof info?.id !== 'number' || String(info.id) !== botId) return null;
    if (typeof info.username !== 'string') return null;
    return info;
  }

  private async fetchBotInfo(
    tenantId: string,
    sealedToken: string,
    token: string,
    cacheKey: string,
    fingerprint: string,
  ): Promise<UserFromGetMe> {
    let botInfo: UserFromGetMe;
    try {
      // A bare Api, not a Bot: there is nothing to build until we know the token is accepted.
      botInfo = await new Api(token, this.clientOptions).getMe();
    } catch (error: unknown) {
      if (isTokenRejection(error)) {
        throw this.remember(
          sealedToken,
          new TenantBotUnavailableError(
            TenantBotErrorCodes.TENANT_BOT_TOKEN_REJECTED,
            tenantId,
            false,
            `Telegram rejected the bot token of tenant ${tenantId} ` +
              `(${error.error_code}: ${error.description})`,
          ),
        );
      }
      // grammY keeps request URLs (and so the token) out of its error messages unless
      // `sensitiveLogs` is enabled, which nothing here does.
      throw new TenantBotUnavailableError(
        TenantBotErrorCodes.TENANT_BOT_UNREACHABLE,
        tenantId,
        true,
        `getMe for tenant ${tenantId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const value: CachedBotInfo = { tokenFingerprint: fingerprint, botInfo };
    await this.cache.set(cacheKey, value, BOT_INFO_TTL_SECONDS).catch((error: unknown) => {
      this.logger.warn(
        `Could not cache the bot identity of tenant ${tenantId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    return botInfo;
  }

  /** Telegram refused a call made with a Bot we built. Drop it, unless it was already replaced. */
  private async onTokenRejected(tenantId: string, fingerprint: string): Promise<void> {
    const entry = this.entries.get(tenantId);
    if (entry === undefined || entry.fingerprint !== fingerprint) return;
    this.entries.delete(tenantId);
    this.logger.error(
      `Telegram rejected the bot token of tenant ${tenantId} (bot ${entry.botId}); the bot is ` +
        'dropped and its next update fails until a working token is set from the dashboard',
    );
    await this.forgetBotInfo(tenantId, entry.botId);
  }

  private remember(
    sealedToken: string,
    error: TenantBotUnavailableError,
  ): TenantBotUnavailableError {
    this.failures.set(error.tenantId, {
      sealedToken,
      error,
      until: Date.now() + TENANT_BOT_FAILURE_MEMO_SECONDS * 1_000,
    });
    return error;
  }

  private noteFailure(error: TenantBotUnavailableError): void {
    if (this.loggedFailures.get(error.tenantId) === error.code) return;
    this.loggedFailures.set(error.tenantId, error.code);
    this.logger.error(
      `Telegram bot of tenant ${error.tenantId} is unavailable (${error.code}): ${error.message}. ` +
        'Logged once until it changes.',
    );
  }

  private async forgetBotInfo(tenantId: string, botId: string): Promise<void> {
    await this.cache.del(telegramBotInfoCacheKey(tenantId, botId)).catch(() => undefined);
  }

  private notFound(tenantId: string): TenantBotUnavailableError {
    return new TenantBotUnavailableError(
      TenantBotErrorCodes.TENANT_BOT_TENANT_NOT_FOUND,
      tenantId,
      false,
      `There is no tenant ${tenantId}`,
    );
  }

  private generationOf(tenantId: string): number {
    return this.generations.get(tenantId) ?? 0;
  }
}
