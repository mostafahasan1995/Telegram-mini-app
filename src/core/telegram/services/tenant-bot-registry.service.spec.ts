/**
 * TenantBotRegistry without a database or Redis: a map stands in for `tenants`, another for the
 * cache, and the Bot API is the offline fake from test/setup/telegram-fixtures. The Bots themselves
 * are real grammY Bots, so the transformers and the handler composition are the production ones.
 *
 * What it pins:
 *  - no getMe until an operator is first used, one getMe per token, and none when a cached identity
 *    was fetched with that exact token;
 *  - the cache key is per operator and per bot, and a stale identity never vouches for another token;
 *  - an unset, unreadable, malformed or rejected token is that operator's typed, non-retryable
 *    failure, remembered so Telegram is not asked again, and a changed token is tried at once;
 *  - a network failure is retryable and not remembered;
 *  - a token revoked while its Bot is cached is dropped at the first 401;
 *  - a token changed elsewhere is picked up after the recheck window, and `invalidate()` at once.
 */
import { Logger } from '@nestjs/common';
import { Composer, type Context } from 'grammy';
import { type Update } from 'grammy/types';

import {
  createFakeTelegram,
  testBotInfo,
  type FakeTelegram,
} from '../../../../test/setup/telegram-fixtures';
import { type CacheService } from '../../cache/cache.service';
import { type PrismaService } from '../../prisma/prisma.service';
import { TenantSecretService } from '../../tenant/services/tenant-secret.service';
import {
  TENANT_BOT_FAILURE_MEMO_SECONDS,
  TENANT_BOT_RECHECK_SECONDS,
  telegramBotInfoCacheKey,
} from '../telegram.constants';
import { TenantBotErrorCodes, TenantBotUnavailableError } from '../tenant-bot.errors';
import { fingerprintBotToken } from './bot.factory';
import { type TelegramHandlerRegistrar } from './handler-registrar.service';
import { TenantBotRegistry } from './tenant-bot-registry.service';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const MISSING = '33333333-3333-4333-8333-333333333333';

const BOT_A = 7_000_000_001;
const TOKEN_A = `${BOT_A}:AAtenantA_token_0123456789abcdefghij`;
const TOKEN_A_ROTATED = `${BOT_A}:AAtenantA_rotated_0123456789abcdefgh`;
const BOT_A2 = 7_000_000_002;
const TOKEN_A_OTHER_BOT = `${BOT_A2}:AAtenantA_otherbot_0123456789abcdef`;
const BOT_B = 7_000_000_003;
const TOKEN_B = `${BOT_B}:AAtenantB_token_0123456789abcdefghij`;

/** A JSON round trip, like the real CacheService, so nothing passes by reference. */
class MemoryCache {
  readonly store = new Map<string, string>();

  get<T>(key: string): Promise<T | null> {
    const raw = this.store.get(key);
    return Promise.resolve(raw === undefined ? null : (JSON.parse(raw) as T));
  }

  set<T>(key: string, value: T, _ttlSeconds: number): Promise<void> {
    this.store.set(key, JSON.stringify(value));
    return Promise.resolve();
  }

  del(...keys: string[]): Promise<void> {
    for (const key of keys) this.store.delete(key);
    return Promise.resolve();
  }
}

const startUpdate = (updateId: number): Update =>
  ({
    update_id: updateId,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: 555, type: 'private', first_name: 'Player' },
      from: { id: 555, is_bot: false, first_name: 'Player' },
      text: '/start',
      entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    },
  }) as unknown as Update;

/** Lets a fire-and-forget eviction finish. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('TenantBotRegistry', () => {
  let secrets: TenantSecretService;
  let telegram: FakeTelegram;
  let cache: MemoryCache;
  let rows: Map<string, { botTokenEnc: string }>;
  let findUnique: jest.Mock;
  let handled: Array<{ botId: number; updateId: number }>;
  let composer: Composer<Context>;
  let now: number;

  const makeRegistry = (): TenantBotRegistry =>
    new TenantBotRegistry(
      { tenant: { findUnique } } as unknown as PrismaService,
      cache as unknown as CacheService,
      secrets,
      { middleware: () => composer } as unknown as TelegramHandlerRegistrar,
      telegram.clientOptions,
    );

  const setToken = (tenantId: string, token: string): void => {
    rows.set(tenantId, { botTokenEnc: secrets.sealBotToken(token) });
  };

  const failureOf = async (call: Promise<unknown>): Promise<TenantBotUnavailableError> => {
    const outcome = await call.then(
      () => null,
      (error: unknown) => error,
    );
    if (!(outcome instanceof TenantBotUnavailableError)) {
      throw new Error(`Expected TenantBotUnavailableError, got ${String(outcome)}`);
    }
    return outcome;
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    secrets = new TenantSecretService('registry_unit_spec_root_secret_0123456789');
    telegram = createFakeTelegram();
    telegram.accept(TOKEN_A, testBotInfo(BOT_A, 'operator_a_bot'));
    telegram.accept(TOKEN_A_ROTATED, testBotInfo(BOT_A, 'operator_a_bot'));
    telegram.accept(TOKEN_A_OTHER_BOT, testBotInfo(BOT_A2, 'operator_a_new_bot'));
    cache = new MemoryCache();
    rows = new Map();
    findUnique = jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(rows.get(where.id) ?? null),
    );
    handled = [];
    composer = new Composer<Context>();
    composer.command('start', (ctx) => {
      handled.push({ botId: ctx.me.id, updateId: ctx.update.update_id });
    });
    setToken(TENANT_A, TOKEN_A);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('building an operator’s bot', () => {
    it('calls nothing until first use, then one getMe, and caches the identity per operator and bot', async () => {
      const registry = makeRegistry();
      expect(telegram.calls).toHaveLength(0);

      const bot = await registry.get(TENANT_A);

      expect(bot.token).toBe(TOKEN_A);
      expect(bot.botInfo.id).toBe(BOT_A);
      expect(telegram.callsFor(TOKEN_A, 'getMe')).toHaveLength(1);

      const key = telegramBotInfoCacheKey(TENANT_A, String(BOT_A));
      expect(key).toBe(`telegram:botinfo:${TENANT_A}:${BOT_A}`);
      const cached = cache.store.get(key) ?? '';
      expect(JSON.parse(cached)).toMatchObject({
        tokenFingerprint: fingerprintBotToken(TOKEN_A),
        botInfo: { id: BOT_A },
      });
      // The old single global key is gone, and no cached value carries the token.
      expect(cache.store.has('telegram:botinfo')).toBe(false);
      for (const value of cache.store.values()) expect(value).not.toContain(TOKEN_A);
    });

    it('dispatches updates through the discovered handler composition with its own identity', async () => {
      const bot = await makeRegistry().get(TENANT_A);

      await bot.handleUpdate(startUpdate(41));

      expect(handled).toEqual([{ botId: BOT_A, updateId: 41 }]);
    });

    it('returns the same bot within the recheck window without reading the row or calling Telegram', async () => {
      const registry = makeRegistry();
      const first = await registry.get(TENANT_A);
      findUnique.mockClear();

      now += (TENANT_BOT_RECHECK_SECONDS - 1) * 1_000;
      const second = await registry.get(TENANT_A);

      expect(second).toBe(first);
      expect(findUnique).not.toHaveBeenCalled();
      expect(telegram.callsFor(TOKEN_A, 'getMe')).toHaveLength(1);
    });

    it('shares one load between concurrent callers', async () => {
      const registry = makeRegistry();

      const bots = await Promise.all([1, 2, 3, 4, 5].map(() => registry.get(TENANT_A)));

      expect(new Set(bots).size).toBe(1);
      expect(findUnique).toHaveBeenCalledTimes(1);
      expect(telegram.callsFor(TOKEN_A, 'getMe')).toHaveLength(1);
    });

    it('presets the identity from the cache in a new process, without getMe', async () => {
      await makeRegistry().get(TENANT_A);

      const bot = await makeRegistry().get(TENANT_A);

      expect(bot.botInfo.id).toBe(BOT_A);
      expect(telegram.callsFor(TOKEN_A, 'getMe')).toHaveLength(1);
    });

    it('ignores a cached identity that was fetched with a different token for the same bot', async () => {
      await makeRegistry().get(TENANT_A);
      setToken(TENANT_A, TOKEN_A_ROTATED);

      await makeRegistry().get(TENANT_A);

      expect(telegram.callsFor(TOKEN_A_ROTATED, 'getMe')).toHaveLength(1);
      const cached = JSON.parse(
        cache.store.get(telegramBotInfoCacheKey(TENANT_A, String(BOT_A))) ?? '{}',
      ) as { tokenFingerprint?: string };
      expect(cached.tokenFingerprint).toBe(fingerprintBotToken(TOKEN_A_ROTATED));
    });

    it('never lets a stale cached identity make a revoked token look valid', async () => {
      // A worker restart with a warm cache presets the identity, so the revoke is only discovered
      // on the first real call. That call must drop the bot and the cached identity.
      await makeRegistry().get(TENANT_A);
      telegram.revoke(TOKEN_A);

      const registry = makeRegistry();
      const bot = await registry.get(TENANT_A);
      await expect(bot.api.sendMessage(555, 'hello')).rejects.toThrow('Unauthorized');
      await settle();

      expect(cache.store.has(telegramBotInfoCacheKey(TENANT_A, String(BOT_A)))).toBe(false);
      const failure = await failureOf(registry.get(TENANT_A));
      expect(failure.code).toBe(TenantBotErrorCodes.TENANT_BOT_TOKEN_REJECTED);
      expect(failure.retryable).toBe(false);
    });
  });

  describe('an operator whose bot cannot work', () => {
    it('is UNCONFIGURED for a placeholder token, without calling Telegram', async () => {
      rows.set(TENANT_B, { botTokenEnc: 'REPLACE-ME-BOT-TOKEN' });

      const failure = await failureOf(makeRegistry().get(TENANT_B));

      expect(failure).toMatchObject({
        code: TenantBotErrorCodes.TENANT_BOT_UNCONFIGURED,
        tenantId: TENANT_B,
        retryable: false,
      });
      expect(telegram.calls).toHaveLength(0);
    });

    it('is UNREADABLE for a value that does not open', async () => {
      const other = new TenantSecretService('a_different_root_secret_0123456789abcdef');
      rows.set(TENANT_B, { botTokenEnc: other.sealBotToken(TOKEN_B) });

      const failure = await failureOf(makeRegistry().get(TENANT_B));

      expect(failure.code).toBe(TenantBotErrorCodes.TENANT_BOT_UNREADABLE);
      expect(failure.retryable).toBe(false);
      expect(failure.message).not.toContain(TOKEN_B);
      expect(telegram.calls).toHaveLength(0);
    });

    it('is REJECTED for a value not shaped like a token, without calling Telegram', async () => {
      setToken(TENANT_B, 'not-a-telegram-token');

      const failure = await failureOf(makeRegistry().get(TENANT_B));

      expect(failure.code).toBe(TenantBotErrorCodes.TENANT_BOT_TOKEN_REJECTED);
      expect(telegram.calls).toHaveLength(0);
    });

    it('is REJECTED when Telegram refuses the token, remembers it, and retries at once when the token changes', async () => {
      setToken(TENANT_B, TOKEN_B);
      const registry = makeRegistry();

      const first = await failureOf(registry.get(TENANT_B));
      const second = await failureOf(registry.get(TENANT_B));

      expect(first.code).toBe(TenantBotErrorCodes.TENANT_BOT_TOKEN_REJECTED);
      expect(first.retryable).toBe(false);
      expect(first.message).not.toContain(TOKEN_B);
      expect(second).toBe(first);
      expect(telegram.callsFor(TOKEN_B, 'getMe')).toHaveLength(1);

      // After the memo expires Telegram is asked again.
      now += (TENANT_BOT_FAILURE_MEMO_SECONDS + 1) * 1_000;
      await failureOf(registry.get(TENANT_B));
      expect(telegram.callsFor(TOKEN_B, 'getMe')).toHaveLength(2);

      // A new token from the dashboard does not wait for the memo.
      telegram.accept(TOKEN_B, testBotInfo(BOT_B, 'operator_b_bot'));
      const replacement = `${BOT_B}:AAtenantB_replacement_0123456789abcd`;
      telegram.accept(replacement, testBotInfo(BOT_B, 'operator_b_bot'));
      telegram.revoke(TOKEN_B);
      setToken(TENANT_B, replacement);
      await expect(registry.get(TENANT_B)).resolves.toMatchObject({ token: replacement });
    });

    it('is UNREACHABLE and retryable when getMe fails on the network, and is not remembered', async () => {
      setToken(TENANT_B, TOKEN_B);
      telegram.accept(TOKEN_B, testBotInfo(BOT_B, 'operator_b_bot'));
      telegram.makeUnreachable(TOKEN_B);
      const registry = makeRegistry();

      const failure = await failureOf(registry.get(TENANT_B));
      expect(failure.code).toBe(TenantBotErrorCodes.TENANT_BOT_UNREACHABLE);
      expect(failure.retryable).toBe(true);

      telegram.restore(TOKEN_B);
      await expect(registry.get(TENANT_B)).resolves.toMatchObject({ token: TOKEN_B });
    });

    it('is TENANT_NOT_FOUND for an unknown operator, and for a malformed id without a query', async () => {
      const registry = makeRegistry();

      expect((await failureOf(registry.get(MISSING))).code).toBe(
        TenantBotErrorCodes.TENANT_BOT_TENANT_NOT_FOUND,
      );
      findUnique.mockClear();
      expect((await failureOf(registry.get('not-a-uuid'))).code).toBe(
        TenantBotErrorCodes.TENANT_BOT_TENANT_NOT_FOUND,
      );
      expect(findUnique).not.toHaveBeenCalled();
    });

    it('does not affect another operator', async () => {
      setToken(TENANT_B, TOKEN_B);
      const registry = makeRegistry();

      await failureOf(registry.get(TENANT_B));
      const bot = await registry.get(TENANT_A);
      await bot.handleUpdate(startUpdate(7));

      expect(handled).toEqual([{ botId: BOT_A, updateId: 7 }]);
    });
  });

  describe('when the token changes', () => {
    it('rebuilds after the recheck window when another process changed the token', async () => {
      const registry = makeRegistry();
      const before = await registry.get(TENANT_A);
      setToken(TENANT_A, TOKEN_A_OTHER_BOT);

      // Inside the window the old bot is still served...
      expect(await registry.get(TENANT_A)).toBe(before);

      // ...and after it the row is re-read, the new bot built, and the old bot's identity dropped.
      now += (TENANT_BOT_RECHECK_SECONDS + 1) * 1_000;
      const after = await registry.get(TENANT_A);

      expect(after).not.toBe(before);
      expect(after.token).toBe(TOKEN_A_OTHER_BOT);
      expect(after.botInfo.id).toBe(BOT_A2);
      expect(cache.store.has(telegramBotInfoCacheKey(TENANT_A, String(BOT_A)))).toBe(false);
      expect(cache.store.has(telegramBotInfoCacheKey(TENANT_A, String(BOT_A2)))).toBe(true);
    });

    it('keeps the same bot after the recheck window when the token is unchanged', async () => {
      const registry = makeRegistry();
      const before = await registry.get(TENANT_A);

      now += (TENANT_BOT_RECHECK_SECONDS + 1) * 1_000;

      expect(await registry.get(TENANT_A)).toBe(before);
      expect(findUnique).toHaveBeenCalledTimes(2);
      expect(telegram.callsFor(TOKEN_A, 'getMe')).toHaveLength(1);
    });

    it('invalidate() drops the bot and its cached identity at once', async () => {
      const registry = makeRegistry();
      const before = await registry.get(TENANT_A);
      setToken(TENANT_A, TOKEN_A_OTHER_BOT);

      await registry.invalidate(TENANT_A);

      expect(cache.store.has(telegramBotInfoCacheKey(TENANT_A, String(BOT_A)))).toBe(false);
      const after = await registry.get(TENANT_A);
      expect(after).not.toBe(before);
      expect(after.token).toBe(TOKEN_A_OTHER_BOT);
    });

    it('does not keep a bot built from a token that was invalidated while it loaded', async () => {
      const registry = makeRegistry();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      findUnique.mockImplementationOnce(async ({ where }: { where: { id: string } }) => {
        const row = rows.get(where.id) ?? null;
        await gate;
        return row;
      });

      const loading = registry.get(TENANT_A);
      await registry.invalidate(TENANT_A);
      setToken(TENANT_A, TOKEN_A_OTHER_BOT);
      release();

      expect((await loading).token).toBe(TOKEN_A);
      expect((await registry.get(TENANT_A)).token).toBe(TOKEN_A_OTHER_BOT);
    });
  });
});
