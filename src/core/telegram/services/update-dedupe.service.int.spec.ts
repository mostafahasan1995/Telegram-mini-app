/**
 * Integration tests for webhook deduplication. The whole point of this service is a database
 * guarantee (`UNIQUE(update_id)` + `ON CONFLICT DO NOTHING`) layered under a Redis fast path, and
 * neither half can be verified with mocks — a mock would happily "dedupe" whatever we told it to.
 *
 * What is being protected: a replayed `callback_query` carrying `dep:approve:<shortId>` must be
 * processed exactly once, no matter how many times Telegram redelivers it.
 *
 * Run with `npm run test:int` (docker compose up postgres redis first).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { type Update } from 'grammy/types';
import { LockService } from '../../cache/lock.service';
import { type RedisService } from '../../cache/redis.service';
import { UpdateDedupeService } from './update-dedupe.service';
import { type PrismaService } from '../../prisma/prisma.service';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/9';
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://ichancy:ichancy@localhost:55432/ichancy';

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

describe('UpdateDedupeService (integration)', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let service: UpdateDedupeService;
  const createdIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    await redis.ping();

    const locks = new LockService(redis as unknown as RedisService);
    service = new UpdateDedupeService(prisma as unknown as PrismaService, locks);
  });

  afterEach(async () => {
    // Only rows this suite created; never a blanket delete.
    if (createdIds.length > 0) {
      await prisma.telegramUpdate.deleteMany({ where: { id: { in: createdIds } } });
      createdIds.length = 0;
    }
    await redis.flushdb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await redis.quit();
  });

  const track = (id: string | null): string => {
    if (id !== null) createdIds.push(id);
    return id as string;
  };

  it('records a new update and returns its row id', async () => {
    const update = messageUpdate(freshUpdateId());
    const result = await service.record(update);

    expect(result.isNew).toBe(true);
    expect(typeof result.id).toBe('string');
    track(result.id);
  });

  it('preserves 64-bit chat and user ids as bigint', async () => {
    // A JS number would round these; the columns are BigInt for exactly this reason.
    const update = messageUpdate(freshUpdateId());
    const result = await service.record(update);
    track(result.id);

    const row = await prisma.telegramUpdate.findUnique({ where: { id: result.id as string } });
    expect(row?.chatId).toBe(-1001234567890n);
    expect(row?.fromUserId).toBe(7123456789012345n);
    expect(row?.kind).toBe('message');
    expect(row?.processedAt).toBeNull();
  });

  it('rejects a redelivery on the Redis fast path', async () => {
    const update = messageUpdate(freshUpdateId());
    const first = await service.record(update);
    track(first.id);

    const second = await service.record(update);
    expect(second.isNew).toBe(false);
    expect(second.id).toBeNull();
  });

  it('still rejects a redelivery after Redis is flushed — the database is the real guarantee', async () => {
    const update = messageUpdate(freshUpdateId());
    const first = await service.record(update);
    track(first.id);

    // Simulate a Redis restart / eviction between Telegram's delivery attempts.
    await redis.flushdb();

    const second = await service.record(update);
    expect(second.isNew).toBe(false);
    expect(second.id).toBeNull();
  });

  it('accepts the retry after rollback, so a failed enqueue does not lose the update', async () => {
    // This is the scenario the rollback exists for: row inserted, enqueue failed, 500 returned,
    // Telegram retries. Without rollback both dedupe layers would swallow the retry forever.
    const update = messageUpdate(freshUpdateId());
    const first = await service.record(update);
    expect(first.isNew).toBe(true);

    await service.rollback(first.id as string, update.update_id);

    const retry = await service.record(update);
    expect(retry.isNew).toBe(true);
    expect(retry.id).not.toBeNull();
    track(retry.id);
  });

  it('stores a callback_query with a null chat when the message is absent', async () => {
    // Telegram omits `message` for callbacks on messages that are too old.
    const update = callbackUpdateWithoutMessage(freshUpdateId());
    const result = await service.record(update);
    track(result.id);

    const row = await prisma.telegramUpdate.findUnique({ where: { id: result.id as string } });
    expect(row?.kind).toBe('callback_query');
    expect(row?.chatId).toBeNull();
    expect(row?.fromUserId).toBe(42n);
  });

  it('persists the full payload as jsonb', async () => {
    const update = callbackUpdateWithoutMessage(freshUpdateId());
    const result = await service.record(update);
    track(result.id);

    const row = await prisma.telegramUpdate.findUnique({ where: { id: result.id as string } });
    const payload = row?.payload as unknown as Update;
    expect(payload.callback_query?.data).toBe('dep:approve:K7Q2ZP9V3M');
  });

  it('markProcessed stamps processedAt and the handler', async () => {
    const result = await service.record(messageUpdate(freshUpdateId()));
    track(result.id);

    await service.markProcessed(result.id as string, 'DepositHandler.onApprove');

    const row = await prisma.telegramUpdate.findUnique({ where: { id: result.id as string } });
    expect(row?.processedAt).toBeInstanceOf(Date);
    expect(row?.handler).toBe('DepositHandler.onApprove');
    expect(row?.processingError).toBeNull();
  });

  it('markFailed records the error but leaves processedAt null so the row stays visible', async () => {
    const result = await service.record(messageUpdate(freshUpdateId()));
    track(result.id);

    await service.markFailed(result.id as string, new Error('ichancy timed out'));

    const row = await prisma.telegramUpdate.findUnique({ where: { id: result.id as string } });
    expect(row?.processingError).toBe('ichancy timed out');
    expect(row?.processedAt).toBeNull();
  });

  it('truncates a huge error message instead of storing an entire query', async () => {
    const result = await service.record(messageUpdate(freshUpdateId()));
    track(result.id);

    await service.markFailed(result.id as string, new Error('x'.repeat(5_000)));

    const row = await prisma.telegramUpdate.findUnique({ where: { id: result.id as string } });
    expect(row?.processingError?.length).toBe(2_000);
  });

  it('deduplicates a burst of concurrent redeliveries down to one row', async () => {
    // Telegram can have several delivery attempts in flight at once.
    const update = messageUpdate(freshUpdateId());
    const results = await Promise.all(Array.from({ length: 6 }, () => service.record(update)));

    const accepted = results.filter((r) => r.isNew);
    expect(accepted).toHaveLength(1);
    track(accepted[0]?.id ?? null);

    const rows = await prisma.telegramUpdate.count({
      where: { updateId: BigInt(update.update_id) },
    });
    expect(rows).toBe(1);
  });
});
