/**
 * WHY the fake honours skipDuplicates instead of just recording the call: the dedupe guarantee is
 * the only reason a retried business transaction cannot enqueue the same side effect twice, and a
 * mock that always inserts would let that regress unnoticed.
 */
import type { Tx } from '@core/prisma/tx.type';

import { OutboxService } from './outbox.service';

interface FakeOutboxRow {
  id: string;
  aggregateType: string;
  aggregateId: string;
  topic: string;
  payload: unknown;
  dedupeKey: string | null;
  availableAt: Date;
}

function createFakeTx() {
  const rows: FakeOutboxRow[] = [];

  const outboxMessage = {
    createMany({
      data,
      skipDuplicates,
    }: {
      data: FakeOutboxRow[];
      skipDuplicates?: boolean;
    }): Promise<{ count: number }> {
      let count = 0;
      for (const row of data) {
        const collides =
          row.dedupeKey !== null && rows.some((existing) => existing.dedupeKey === row.dedupeKey);
        if (collides) {
          // ON CONFLICT DO NOTHING: the row is dropped, and crucially nothing throws — a P2002
          // inside an interactive transaction would abort the caller's money write.
          if (skipDuplicates !== true) throw new Error('unique violation');
          continue;
        }
        rows.push(row);
        count += 1;
      }
      return Promise.resolve({ count });
    },

    findMany({
      where,
    }: {
      where: { dedupeKey: { in: string[] } };
    }): Promise<{ id: string; dedupeKey: string | null }[]> {
      return Promise.resolve(
        rows
          .filter((row) => row.dedupeKey !== null && where.dedupeKey.in.includes(row.dedupeKey))
          .map((row) => ({ id: row.id, dedupeKey: row.dedupeKey })),
      );
    },
  };

  return { rows, outboxMessage };
}

type FakeTx = ReturnType<typeof createFakeTx>;

function setup(): { service: OutboxService; tx: FakeTx } {
  const tx = createFakeTx();
  return { service: new OutboxService(), tx };
}

const asTx = (tx: FakeTx): Tx => tx as unknown as Tx;

describe('OutboxService.enqueue', () => {
  it('writes the message through the caller transaction and nowhere else', async () => {
    const { service, tx } = setup();

    const result = await service.enqueue(asTx(tx), {
      aggregateType: 'DepositRequest',
      aggregateId: 'dep-1',
      topic: 'deposit.credit.requested',
      payload: { shortId: 'K7Q2ZP9V3M' },
    });

    expect(result.deduplicated).toBe(false);
    expect(tx.rows).toHaveLength(1);
    expect(tx.rows[0]).toMatchObject({
      id: result.id,
      aggregateType: 'DepositRequest',
      aggregateId: 'dep-1',
      topic: 'deposit.credit.requested',
      payload: { shortId: 'K7Q2ZP9V3M' },
      dedupeKey: null,
    });
  });

  it('mints time-ordered ids, which is what makes the relay ORDER BY id a FIFO claim', async () => {
    const { service, tx } = setup();
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const { id } = await service.enqueue(asTx(tx), {
        aggregateType: 'DepositRequest',
        aggregateId: `dep-${index}`,
        topic: 'deposit.credit.requested',
        payload: {},
      });
      ids.push(id);
    }
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('renders bigint money as a decimal string instead of throwing', async () => {
    const { service, tx } = setup();
    await service.enqueue(asTx(tx), {
      aggregateType: 'DepositRequest',
      aggregateId: 'dep-1',
      topic: 'deposit.credited',
      payload: { amountMinor: 250000n, at: new Date('2026-08-12T00:00:00.000Z') },
    });

    expect(tx.rows[0]?.payload).toEqual({
      amountMinor: '250000',
      at: '2026-08-12T00:00:00.000Z',
    });
  });

  it('defaults availableAt to now and honours a deliberate delay', async () => {
    const { service, tx } = setup();
    const later = new Date(Date.now() + 7_200_000);

    await service.enqueue(asTx(tx), {
      aggregateType: 'DepositRequest',
      aggregateId: 'dep-1',
      topic: 'deposit.expire',
      payload: {},
    });
    await service.enqueue(asTx(tx), {
      aggregateType: 'DepositRequest',
      aggregateId: 'dep-2',
      topic: 'deposit.expire',
      payload: {},
      availableAt: later,
    });

    expect(tx.rows[0]?.availableAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(tx.rows[1]?.availableAt).toBe(later);
  });
});

describe('OutboxService — dedupeKey', () => {
  const message = {
    aggregateType: 'DepositRequest',
    aggregateId: 'dep-1',
    topic: 'deposit.credit.requested',
    payload: { attempt: 1 },
    dedupeKey: 'deposit.credit.requested:dep-1',
  };

  it('registers the side effect once when the transaction is retried', async () => {
    const { service, tx } = setup();

    const first = await service.enqueue(asTx(tx), message);
    const second = await service.enqueue(asTx(tx), message);

    expect(tx.rows).toHaveLength(1);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    // The caller gets the id that actually exists, not the one we speculatively generated.
    expect(second.id).toBe(first.id);
  });

  it('does not confuse two messages that only share a topic', async () => {
    const { service, tx } = setup();
    await service.enqueue(asTx(tx), message);
    const other = await service.enqueue(asTx(tx), {
      ...message,
      aggregateId: 'dep-2',
      dedupeKey: 'deposit.credit.requested:dep-2',
    });

    expect(tx.rows).toHaveLength(2);
    expect(other.deduplicated).toBe(false);
  });

  it('reports per-entry results for a mixed batch', async () => {
    const { service, tx } = setup();
    await service.enqueue(asTx(tx), message);

    const results = await service.enqueueMany(asTx(tx), [
      message,
      { ...message, aggregateId: 'dep-3', dedupeKey: 'deposit.credit.requested:dep-3' },
      { ...message, aggregateId: 'dep-4', dedupeKey: null },
    ]);

    expect(results.map((result) => result.deduplicated)).toEqual([true, false, false]);
    expect(tx.rows).toHaveLength(3);
  });

  it('is a no-op for an empty batch', async () => {
    const { service, tx } = setup();
    await expect(service.enqueueMany(asTx(tx), [])).resolves.toEqual([]);
    expect(tx.rows).toHaveLength(0);
  });
});
