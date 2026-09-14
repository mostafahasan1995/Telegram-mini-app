/**
 * Integration tests for webhook deduplication against the MULTI-TENANT schema. The guarantee is a
 * database one, `UNIQUE(tenant_id, update_id)` with `ON CONFLICT (tenant_id, update_id) DO NOTHING`,
 * layered under a Redis claim `tg:upd:<tenantId>:<updateId>`. Neither half can be verified with
 * mocks: a mock would happily "dedupe" whatever we told it to.
 *
 * What is being protected:
 *  - a replayed `callback_query` carrying `dep:approve:<shortId>` is processed exactly once for its
 *    operator, however many times Telegram redelivers it;
 *  - the same `update_id` from ANOTHER operator's bot is a different update and is never deduped
 *    away, because Telegram numbers updates per bot.
 *
 * The suite creates its own two operators (run-unique slugs under a fixed prefix) and deletes them
 * in afterAll; their `telegram_updates` rows go with them by cascade.
 *
 * Run with:  POSTGRES_TEST_URL=... REDIS_TEST_URL=... npx jest --config jest-int.config.cjs \
 *              --runInBand src/core/telegram/services/update-dedupe.service.int.spec.ts
 * against a THROWAWAY database and Redis.
 */
import { randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, TenantStatus } from '@prisma/client';
import { Redis } from 'ioredis';
import { type Update } from 'grammy/types';
import { LockService } from '../../cache/lock.service';
import { type RedisService } from '../../cache/redis.service';
import { type PrismaService } from '../../prisma/prisma.service';
import { telegramUpdateDedupeKey } from '../telegram.constants';
import { UpdateDedupeService } from './update-dedupe.service';

// No guessed default: localhost:55432 is also where a live cashier stack publishes Postgres on a
// developer machine. The harness-wide escape hatch is honoured next to this suite's own names.
const REDIS_URL = process.env.TEST_REDIS_URL ?? process.env.REDIS_TEST_URL ?? '';
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.POSTGRES_TEST_URL ?? '';
if (REDIS_URL === '' || DATABASE_URL === '') {
  throw new Error('Set POSTGRES_TEST_URL and REDIS_TEST_URL to a THROWAWAY database and Redis.');
}

const RUN = Date.now().toString(36);
/** Every operator this suite creates starts with it, so a crashed run's leftovers are found. */
const SLUG_PREFIX = 'p6-dedupe-';

/** Distinct per run so repeated local runs never collide on update_id. */
let nextUpdateId = Date.now();
const freshUpdateId = (): number => (nextUpdateId += 1);

function messageUpdate(updateId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      // Deliberately 64-bit: a supergroup id and a large user id, both beyond 2^32.
      chat: { id: -1001234567890, type: 'supergroup', title: 'Admins' },
      from: { id: 7123456789012345, is_bot: false, first_name: 'Ops' },
      text: '/deposits',
    },
  };
}

function callbackUpdateWithoutMessage(updateId: number): Update {
  return {
    update_id: updateId,
    callback_query: {
      id: 'cbq-1',
      from: { id: 42, is_bot: false, first_name: 'Admin' },
      chat_instance: 'ci',
      data: 'dep:approve:K7Q2ZP9V3M',
    },
  };
}

describe('UpdateDedupeService (integration, tenant-keyed)', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let service: UpdateDedupeService;
  let tenantA: string;
  let tenantB: string;

  const removeSuiteOperators = async (): Promise<void> => {
    // Tenant is not a scoped model, and telegram_updates cascade with their operator.
    await prisma.tenant.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
  };

  const createOperator = async (name: string): Promise<string> => {
    const tenant = await prisma.tenant.create({
      data: {
        slug: `${SLUG_PREFIX}${RUN}-${name}`,
        displayName: `P6 dedupe ${name}`,
        status: TenantStatus.ACTIVE,
        botTokenEnc: 'P6-INT-NO-BOT',
        adminChatId: 0n,
        ichancyBaseUrl: 'https://example.invalid',
        ichancyUsername: 'unused',
        ichancyPasswordEnc: 'P6-INT-NO-AGENT',
        ichancyAgentId: 'unused',
        currencyCode: 'NSP',
        dualApprovalThresholdMinor: 0n,
        agentFloatLowWatermarkMinor: 0n,
        depositExpiryMinutes: 30,
      },
      select: { id: true },
    });
    return tenant.id;
  };

  const rowCount = (tenantId: string, updateId: number): Promise<number> =>
    prisma.telegramUpdate.count({ where: { tenantId, updateId: BigInt(updateId) } });

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    await redis.ping();

    const locks = new LockService(redis as unknown as RedisService);
    service = new UpdateDedupeService(prisma as unknown as PrismaService, locks);

    await removeSuiteOperators();
    tenantA = await createOperator('a');
    tenantB = await createOperator('b');
  });

  afterEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await removeSuiteOperators();
    await prisma.$disconnect();
    await redis.quit();
  });

  describe('tenant keying', () => {
    it('records a new update under its operator and returns the row id', async () => {
      const update = messageUpdate(freshUpdateId());
      const result = await service.record(tenantA, update);

      expect(result.isNew).toBe(true);
      expect(typeof result.id).toBe('string');
      const row = await prisma.telegramUpdate.findUnique({ where: { id: result.id as string } });
      expect(row?.tenantId).toBe(tenantA);
      expect(row?.updateId).toBe(BigInt(update.update_id));
    });

    it('persists the same update_id from two operators as two rows', async () => {
      // Telegram numbers updates per bot, so this happens in production as a matter of course.
      const updateId = freshUpdateId();
      const fromA = await service.record(tenantA, messageUpdate(updateId));
      const fromB = await service.record(tenantB, messageUpdate(updateId));

      expect(fromA.isNew).toBe(true);
      expect(fromB.isNew).toBe(true);
      expect(fromA.id).not.toBe(fromB.id);
      expect(await rowCount(tenantA, updateId)).toBe(1);
      expect(await rowCount(tenantB, updateId)).toBe(1);
    });

    it('still persists both after a Redis flush, where only the database decides', async () => {
      const updateId = freshUpdateId();
      await service.record(tenantA, messageUpdate(updateId));
      await redis.flushdb();

      const fromB = await service.record(tenantB, messageUpdate(updateId));
      expect(fromB.isNew).toBe(true);
    });

    it('namespaces the Redis claim by tenant', async () => {
      const updateId = freshUpdateId();
      await service.record(tenantA, messageUpdate(updateId));

      expect(await redis.exists(telegramUpdateDedupeKey(tenantA, updateId))).toBe(1);
      expect(await redis.exists(telegramUpdateDedupeKey(tenantB, updateId))).toBe(0);
      // The pre-tenant key shape must not come back by accident.
      expect(await redis.exists(`tg:upd:${updateId}`)).toBe(0);
    });

    it('dedupes a concurrent burst per operator, never across operators', async () => {
      // Telegram can have several delivery attempts in flight at once, for both bots.
      const updateId = freshUpdateId();
      const results = await Promise.all(
        [tenantA, tenantB].flatMap((tenantId) =>
          Array.from({ length: 6 }, async () => ({
            tenantId,
            result: await service.record(tenantId, messageUpdate(updateId)),
          })),
        ),
      );

      for (const tenantId of [tenantA, tenantB]) {
        const accepted = results.filter((r) => r.tenantId === tenantId && r.result.isNew);
        expect(accepted).toHaveLength(1);
        expect(await rowCount(tenantId, updateId)).toBe(1);
      }
    });

    it('releases the claim when the insert fails, so the retry is not swallowed', async () => {
      // An operator id with no row fails the foreign key: the catch path under test.
      const ghost = randomUUID();
      const updateId = freshUpdateId();

      await expect(service.record(ghost, messageUpdate(updateId))).rejects.toThrow();
      expect(await redis.exists(telegramUpdateDedupeKey(ghost, updateId))).toBe(0);
    });
  });

  describe('replay', () => {
    it('rejects a redelivery for the same operator on the Redis fast path', async () => {
      const update = messageUpdate(freshUpdateId());
      const first = await service.record(tenantA, update);
      expect(first.isNew).toBe(true);

      const second = await service.record(tenantA, update);
      expect(second.isNew).toBe(false);
      expect(second.id).toBeNull();
    });

    it('still rejects a redelivery after Redis is flushed — the database is the real guarantee', async () => {
      const update = messageUpdate(freshUpdateId());
      await service.record(tenantA, update);

      // Simulate a Redis restart / eviction between Telegram's delivery attempts.
      await redis.flushdb();

      const second = await service.record(tenantA, update);
      expect(second.isNew).toBe(false);
      expect(second.id).toBeNull();
    });

    it('accepts the retry after rollback, so a failed enqueue does not lose the update', async () => {
      // Row inserted, enqueue failed, 500 returned, Telegram retries. Without rollback both dedupe
      // layers would swallow the retry forever.
      const update = messageUpdate(freshUpdateId());
      const first = await service.record(tenantA, update);
      expect(first.isNew).toBe(true);

      await service.rollback(tenantA, first.id as string, update.update_id);

      const retry = await service.record(tenantA, update);
      expect(retry.isNew).toBe(true);
      expect(retry.id).not.toBeNull();
    });

    it("rolling back one operator's update leaves the other operator's row and claim alone", async () => {
      const updateId = freshUpdateId();
      const fromA = await service.record(tenantA, messageUpdate(updateId));
      const fromB = await service.record(tenantB, messageUpdate(updateId));

      await service.rollback(tenantA, fromA.id as string, updateId);

      expect(await rowCount(tenantA, updateId)).toBe(0);
      expect(await rowCount(tenantB, updateId)).toBe(1);
      const replayB = await service.record(tenantB, messageUpdate(updateId));
      expect(replayB.isNew).toBe(false);
      expect(fromB.id).not.toBeNull();
    });

    it('deletes nothing when the row id belongs to another operator', async () => {
      const updateId = freshUpdateId();
      const fromA = await service.record(tenantA, messageUpdate(updateId));

      await service.rollback(tenantB, fromA.id as string, updateId);

      expect(await rowCount(tenantA, updateId)).toBe(1);
    });
  });

  describe('row contents', () => {
    it('preserves 64-bit chat and user ids as bigint', async () => {
      // A JS number would round these; the columns are BigInt for exactly this reason.
      const result = await service.record(tenantA, messageUpdate(freshUpdateId()));

      const row = await prisma.telegramUpdate.findUnique({ where: { id: result.id as string } });
      expect(row?.chatId).toBe(-1001234567890n);
      expect(row?.fromUserId).toBe(7123456789012345n);
      expect(row?.kind).toBe('message');
      expect(row?.processedAt).toBeNull();
    });

    it('stores a callback_query with a null chat when the message is absent', async () => {
      // Telegram omits `message` for callbacks on messages that are too old.
      const result = await service.record(tenantA, callbackUpdateWithoutMessage(freshUpdateId()));

      const row = await prisma.telegramUpdate.findUnique({ where: { id: result.id as string } });
      expect(row?.kind).toBe('callback_query');
      expect(row?.chatId).toBeNull();
      expect(row?.fromUserId).toBe(42n);
    });

    it('persists the full payload as jsonb', async () => {
      const result = await service.record(tenantA, callbackUpdateWithoutMessage(freshUpdateId()));

      const row = await prisma.telegramUpdate.findUnique({ where: { id: result.id as string } });
      const payload = row?.payload as unknown as Update;
      expect(payload.callback_query?.data).toBe('dep:approve:K7Q2ZP9V3M');
    });

    it('markProcessed stamps processedAt and the handler', async () => {
      const result = await service.record(tenantA, messageUpdate(freshUpdateId()));

      await service.markProcessed(result.id as string, 'DepositHandler.onApprove');

      const row = await prisma.telegramUpdate.findUnique({ where: { id: result.id as string } });
      expect(row?.processedAt).toBeInstanceOf(Date);
      expect(row?.handler).toBe('DepositHandler.onApprove');
      expect(row?.processingError).toBeNull();
    });

    it('markFailed records the error but leaves processedAt null so the row stays visible', async () => {
      const result = await service.record(tenantA, messageUpdate(freshUpdateId()));

      await service.markFailed(result.id as string, new Error('ichancy timed out'));

      const row = await prisma.telegramUpdate.findUnique({ where: { id: result.id as string } });
      expect(row?.processingError).toBe('ichancy timed out');
      expect(row?.processedAt).toBeNull();
    });

    it('truncates a huge error message instead of storing an entire query', async () => {
      const result = await service.record(tenantA, messageUpdate(freshUpdateId()));

      await service.markFailed(result.id as string, new Error('x'.repeat(5_000)));

      const row = await prisma.telegramUpdate.findUnique({ where: { id: result.id as string } });
      expect(row?.processingError?.length).toBe(2_000);
    });
  });
});
