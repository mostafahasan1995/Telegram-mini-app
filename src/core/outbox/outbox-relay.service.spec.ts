/**
 * WHY these particular cases: the relay is only correct if it is boring under failure. Each test
 * below is a production incident in miniature — Redis unreachable, a pod killed mid-publish, two
 * ticks overlapping, the api pod accidentally scheduled — and each has a specific wrong behaviour
 * (double delivery, lost message, infinite retry) that the assertion pins down.
 */
import type { AppConfigService } from '@core/config/config.service';
import type { PrismaService } from '@core/prisma/prisma.service';
import { TASKS } from '@core/queue/queue.types';
import type { TypedQueueService } from '@core/queue/typed-queue.service';

import { OutboxRelayService } from './outbox-relay.service';
import { OUTBOX_MAX_PUBLISH_ATTEMPTS } from './outbox.constants';
import type { ClaimedOutboxRow } from './outbox.types';

interface UpdateManyCall {
  where: { id: { in: string[] } };
  data: Record<string, unknown>;
}

function row(id: string, attempts = 1): ClaimedOutboxRow {
  return {
    id,
    aggregateType: 'DepositRequest',
    aggregateId: `agg-${id}`,
    topic: 'deposit.credit.requested',
    payload: { shortId: 'K7Q2ZP9V3M' },
    attempts,
    availableAt: new Date('2026-08-12T00:00:00.000Z'),
    createdAt: new Date('2026-08-12T00:00:00.000Z'),
  };
}

function createHarness(options: { isWorker?: boolean; claim?: ClaimedOutboxRow[] } = {}) {
  const updates: UpdateManyCall[] = [];
  const queryRaw = jest.fn().mockResolvedValue(options.claim ?? []);
  const executeRaw = jest.fn().mockResolvedValue(0);

  const prisma = {
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
    outboxMessage: {
      updateMany: jest.fn((call: UpdateManyCall) => {
        updates.push(call);
        return Promise.resolve({ count: call.where.id.in.length });
      }),
    },
  };

  const addBulk = jest.fn().mockResolvedValue([]);
  const queue = { addBulk };
  const config = { app: { isWorker: options.isWorker ?? true } };

  const service = new OutboxRelayService(
    prisma as unknown as PrismaService,
    queue as unknown as TypedQueueService,
    config as unknown as AppConfigService,
  );

  return { service, prisma, queryRaw, executeRaw, addBulk, updates };
}

describe('OutboxRelayService — the happy path', () => {
  it('publishes every claimed row and then marks it SENT', async () => {
    const { service, addBulk, updates } = createHarness({ claim: [row('a'), row('b')] });

    const result = await service.tick();

    expect(result).toEqual({ claimed: 2, published: 2, failed: 0, dead: 0 });
    expect(addBulk).toHaveBeenCalledTimes(1);
    expect(addBulk.mock.calls[0]?.[0]).toBe(TASKS.OUTBOX_DISPATCH);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.where.id.in).toEqual(['a', 'b']);
    expect(updates[0]?.data).toMatchObject({ status: 'SENT', lockedAt: null, lockedBy: null });
  });

  it('uses a jobId derived from the row id, so a re-publish is dropped by BullMQ', async () => {
    const { service, addBulk } = createHarness({ claim: [row('a')] });
    await service.tick();

    const entries = addBulk.mock.calls[0]?.[1] as {
      payload: Record<string, unknown>;
      options: Record<string, unknown>;
    }[];
    expect(entries[0]?.options).toMatchObject({
      jobId: 'outbox-a',
      attempts: 8,
      backoff: { type: 'exponential', delay: 2000 },
    });
  });

  it('hands the handler the topic and payload the producer committed', async () => {
    const { service, addBulk } = createHarness({ claim: [row('a', 3)] });
    await service.tick();

    const entries = addBulk.mock.calls[0]?.[1] as { payload: Record<string, unknown> }[];
    expect(entries[0]?.payload).toEqual({
      outboxId: 'a',
      topic: 'deposit.credit.requested',
      aggregateType: 'DepositRequest',
      aggregateId: 'agg-a',
      payload: { shortId: 'K7Q2ZP9V3M' },
      attempt: 3,
    });
  });

  it('does not touch the queue when there is nothing to publish', async () => {
    const { service, addBulk, updates } = createHarness({ claim: [] });
    await expect(service.tick()).resolves.toEqual({
      claimed: 0,
      published: 0,
      failed: 0,
      dead: 0,
    });
    expect(addBulk).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });
});

describe('OutboxRelayService — Redis is down', () => {
  it('returns rows to PENDING with a backoff instead of losing them', async () => {
    const { service, addBulk, updates } = createHarness({ claim: [row('a', 1), row('b', 1)] });
    addBulk.mockRejectedValue(new Error('ECONNREFUSED'));

    const before = Date.now();
    const result = await service.tick();

    expect(result).toMatchObject({ claimed: 2, published: 0, failed: 2, dead: 0 });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.data).toMatchObject({ status: 'PENDING', lockedAt: null, lockedBy: null });
    expect(updates[0]?.data.lastError).toContain('ECONNREFUSED');
    expect((updates[0]?.data.availableAt as Date).getTime()).toBeGreaterThan(before);
  });

  it('parks a row that has burned every attempt as DEAD rather than retrying forever', async () => {
    const { service, addBulk, updates } = createHarness({
      claim: [row('a', OUTBOX_MAX_PUBLISH_ATTEMPTS), row('b', 2)],
    });
    addBulk.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await service.tick();

    expect(result).toMatchObject({ published: 0, failed: 1, dead: 1 });
    const dead = updates.find((update) => update.data.status === 'DEAD');
    const retry = updates.find((update) => update.data.status === 'PENDING');
    expect(dead?.where.id.in).toEqual(['a']);
    expect(retry?.where.id.in).toEqual(['b']);
  });

  it('never marks a row SENT when the publish failed', async () => {
    const { service, addBulk, updates } = createHarness({ claim: [row('a')] });
    addBulk.mockRejectedValue(new Error('ECONNREFUSED'));
    await service.tick();
    expect(updates.some((update) => update.data.status === 'SENT')).toBe(false);
  });

  it('swallows a claim failure so the schedule keeps running', async () => {
    const { service, queryRaw } = createHarness();
    queryRaw.mockRejectedValue(new Error('database is starting up'));
    await expect(service.tick()).resolves.toEqual({
      claimed: 0,
      published: 0,
      failed: 0,
      dead: 0,
    });
  });
});

describe('OutboxRelayService — role and overlap guards', () => {
  it('does nothing at all in the api role', async () => {
    const { service, queryRaw, addBulk } = createHarness({
      isWorker: false,
      claim: [row('a')],
    });

    await expect(service.tick()).resolves.toEqual({
      claimed: 0,
      published: 0,
      failed: 0,
      dead: 0,
    });
    await expect(service.reap()).resolves.toBe(0);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(addBulk).not.toHaveBeenCalled();
  });

  it('skips a tick that would overlap a slow one already in progress', async () => {
    const { service, queryRaw } = createHarness();
    let release: (rows: ClaimedOutboxRow[]) => void = () => undefined;
    queryRaw.mockReturnValue(
      new Promise<ClaimedOutboxRow[]>((resolve) => {
        release = resolve;
      }),
    );

    const slow = service.tick();
    const overlapping = await service.tick();
    expect(overlapping).toEqual({ claimed: 0, published: 0, failed: 0, dead: 0 });
    expect(queryRaw).toHaveBeenCalledTimes(1);

    release([]);
    await slow;

    // The guard must release afterwards, otherwise the relay stops for good.
    await service.tick();
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});

describe('OutboxRelayService.reap', () => {
  it('reports how many abandoned rows it took back', async () => {
    const { service, executeRaw } = createHarness();
    executeRaw.mockResolvedValue(3);
    await expect(service.reap()).resolves.toBe(3);
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it('keeps the schedule alive when the reaper query fails', async () => {
    const { service, executeRaw } = createHarness();
    executeRaw.mockRejectedValue(new Error('deadlock detected'));
    await expect(service.reap()).resolves.toBe(0);
  });
});

describe('OutboxRelayService.statusCounts', () => {
  it('turns the histogram rows into a lookup for the health endpoint', async () => {
    const { service, queryRaw } = createHarness();
    queryRaw.mockResolvedValue([
      { status: 'PENDING', count: 4 },
      { status: 'DEAD', count: 1 },
    ]);
    await expect(service.statusCounts()).resolves.toEqual({ PENDING: 4, DEAD: 1 });
  });
});
