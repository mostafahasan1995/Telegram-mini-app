/**
 * The two identity doors and their cache keys, against an in-memory cache and a stubbed Prisma.
 * The database half of "a NULL never matches a Telegram lookup" is proven against real Postgres in
 * admin-identity.service.int.spec.ts; this file pins the service's own logic.
 */
import { AdminRole } from '@prisma/client';

import { ForbiddenError } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';

import type { CacheService } from '../../cache/cache.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { adminIdentityByIdKey, adminIdentityByTelegramKey } from '../auth.constants';
import { AdminIdentityService } from './admin-identity.service';

const TENANT_A = '00000000-0000-0000-0000-000000000001';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';
const CONSOLE_ADMIN_ID = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const BOT_ADMIN_ID = '9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b';

interface Row {
  id: string;
  telegramUserId: bigint | null;
  tenantId: string;
  role: AdminRole;
  displayName: string;
  isActive: boolean;
}

/** Stores JSON exactly as Redis would, so the bigint/null round trip is really exercised. */
class MemoryCache {
  readonly store = new Map<string, string>();

  async getOrSet<T>(
    key: string,
    _ttl: number,
    factory: () => Promise<T>,
    options: { cacheNull?: boolean } = {},
  ): Promise<T> {
    const hit = this.store.get(key);
    if (hit !== undefined) return JSON.parse(hit) as T;
    const value = await factory();
    if (value !== null || options.cacheNull === true) this.store.set(key, JSON.stringify(value));
    return value;
  }

  del(...keys: string[]): Promise<void> {
    for (const key of keys) this.store.delete(key);
    return Promise.resolve();
  }
}

function build(rows: Row[]): {
  service: AdminIdentityService;
  cache: MemoryCache;
  findUnique: jest.Mock;
} {
  const findUnique = jest.fn(
    (args: {
      where: { id?: string; tenantId_telegramUserId?: { tenantId: string; telegramUserId: bigint } };
    }) => {
      const { id, tenantId_telegramUserId: compound } = args.where;
      const row = rows.find((candidate) =>
        id !== undefined
          ? candidate.id === id
          : compound !== undefined &&
            candidate.tenantId === compound.tenantId &&
            // Mirrors SQL: NULL = x is never true.
            candidate.telegramUserId !== null &&
            candidate.telegramUserId === compound.telegramUserId,
      );
      return Promise.resolve(row ?? null);
    },
  );
  const prisma = { adminUser: { findUnique } } as unknown as PrismaService;
  const cache = new MemoryCache();
  return {
    service: new AdminIdentityService(prisma, cache as unknown as CacheService),
    cache,
    findUnique,
  };
}

const consoleAdmin: Row = {
  id: CONSOLE_ADMIN_ID,
  telegramUserId: null,
  tenantId: TENANT_A,
  role: AdminRole.SUPER_ADMIN,
  displayName: 'Console only',
  isActive: true,
};

const botAdmin: Row = {
  id: BOT_ADMIN_ID,
  telegramUserId: 7_123_456_789_012_345n,
  tenantId: TENANT_A,
  role: AdminRole.REVIEWER,
  displayName: 'Has Telegram',
  isActive: true,
};

describe('AdminIdentityService', () => {
  describe('resolveById (the HTTP door)', () => {
    it('resolves a console-only admin, with a null Telegram id that survives the cache', async () => {
      const { service, cache, findUnique } = build([consoleAdmin]);

      const first = await service.resolveById(TENANT_A, CONSOLE_ADMIN_ID);
      const second = await service.resolveById(TENANT_A, CONSOLE_ADMIN_ID);

      const expected = {
        adminUserId: CONSOLE_ADMIN_ID,
        telegramUserId: null,
        tenantId: TENANT_A,
        role: AdminRole.SUPER_ADMIN,
        displayName: 'Console only',
      };
      expect(first).toEqual(expected);
      expect(second).toEqual(expected);
      expect(findUnique).toHaveBeenCalledTimes(1);
      expect(cache.store.has(adminIdentityByIdKey(TENANT_A, CONSOLE_ADMIN_ID))).toBe(true);
    });

    it('turns a cached Telegram id back into a bigint', async () => {
      const { service } = build([botAdmin]);

      await service.resolveById(TENANT_A, BOT_ADMIN_ID);
      const cached = await service.resolveById(TENANT_A, BOT_ADMIN_ID);

      expect(cached?.telegramUserId).toBe(7_123_456_789_012_345n);
    });

    it('refuses a row that lives in a different tenant than the token says', async () => {
      const { service } = build([consoleAdmin]);

      await expect(service.resolveById(TENANT_B, CONSOLE_ADMIN_ID)).resolves.toBeNull();
    });

    it('treats an inactive admin exactly like no admin', async () => {
      const { service } = build([{ ...consoleAdmin, isActive: false }]);

      await expect(service.resolveById(TENANT_A, CONSOLE_ADMIN_ID)).resolves.toBeNull();
      await expect(service.resolveByIdOrThrow(TENANT_A, CONSOLE_ADMIN_ID)).rejects.toMatchObject({
        errorCode: CommonErrorCodes.ADMIN_INACTIVE,
      });
      await expect(service.resolveByIdOrThrow(TENANT_A, CONSOLE_ADMIN_ID)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });

    it('answers a sub that is not a uuid with null, without querying', async () => {
      const { service, findUnique } = build([consoleAdmin]);

      await expect(service.resolveById(TENANT_A, '912911246')).resolves.toBeNull();
      expect(findUnique).not.toHaveBeenCalled();
    });
  });

  describe('resolveByTelegram (the bot door)', () => {
    it('finds an admin by Telegram id', async () => {
      const { service, cache } = build([botAdmin, consoleAdmin]);

      await expect(service.resolveByTelegram(TENANT_A, 7_123_456_789_012_345n)).resolves.toEqual({
        adminUserId: BOT_ADMIN_ID,
        telegramUserId: 7_123_456_789_012_345n,
        tenantId: TENANT_A,
        role: AdminRole.REVIEWER,
        displayName: 'Has Telegram',
      });
      expect(
        cache.store.has(adminIdentityByTelegramKey(TENANT_A, 7_123_456_789_012_345n)),
      ).toBe(true);
    });

    it('never reaches a console-only admin, whatever id is asked for', async () => {
      const { service } = build([consoleAdmin]);

      await expect(service.resolveByTelegram(TENANT_A, 0n)).resolves.toBeNull();
      await expect(service.isAdminByTelegram(TENANT_A, 1n)).resolves.toBe(false);
    });

    it('keeps the two doors in separate cache namespaces', () => {
      expect(adminIdentityByIdKey(TENANT_A, '1')).not.toBe(adminIdentityByTelegramKey(TENANT_A, 1n));
    });
  });

  describe('invalidate', () => {
    it('drops both cache entries for an admin with a Telegram id', async () => {
      const { service, cache, findUnique } = build([botAdmin]);
      await service.resolveById(TENANT_A, BOT_ADMIN_ID);
      await service.resolveByTelegram(TENANT_A, 7_123_456_789_012_345n);
      expect(cache.store.size).toBe(2);

      await service.invalidate({
        tenantId: TENANT_A,
        adminUserId: BOT_ADMIN_ID,
        telegramUserId: 7_123_456_789_012_345n,
      });

      expect(cache.store.size).toBe(0);
      findUnique.mockClear();
      await service.resolveById(TENANT_A, BOT_ADMIN_ID);
      expect(findUnique).toHaveBeenCalledTimes(1);
    });

    it('drops the id entry for a console-only admin', async () => {
      const { service, cache } = build([consoleAdmin]);
      await service.resolveById(TENANT_A, CONSOLE_ADMIN_ID);

      await service.invalidate({
        tenantId: TENANT_A,
        adminUserId: CONSOLE_ADMIN_ID,
        telegramUserId: null,
      });

      expect(cache.store.size).toBe(0);
    });
  });
});
