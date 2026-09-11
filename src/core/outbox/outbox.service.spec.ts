/**
 * WHY the fake honours skipDuplicates instead of just recording the call: the dedupe guarantee is
 * the only reason a retried business transaction cannot enqueue the same side effect twice, and a
 * mock that always inserts would let that regress unnoticed.
 *
 * That uniqueness is now UNIQUE(tenant_id, dedupe_key), so the fake enforces the PAIR. Enforcing
 * the key alone would make an operator's side effect disappear because a different operator had
 * already enqueued a key of the same shape — and the spec would call that dedupe working.
 *
 * Every act opens a tenant context because the row names the operator whose money write caused it,
 * which the service reads from the ambient context rather than guessing. On a request the
 * middleware opens it; here the spec does, exactly as a worker does with runWithTenant().
 */
import { runWithTenant } from '@core/tenant';
import type { Tx } from '@core/prisma/tx.type';

import { OutboxService } from './outbox.service';
import type { OutboxEnqueueInput, OutboxEnqueueResult } from './outbox.types';

/**
 * Two operators, because "the message was enqueued" and "the message was enqueued for the RIGHT
 * operator" are different claims. With one tenant, a service stamping a constant would look fine.
 */
const OPERATOR_A = 'b7e4c2a1-5d38-4f6e-9a20-1c3d5e7f9a11';
const OPERATOR_B = 'c8f5d3b2-6e49-4a7f-8b31-2d4e6f8a0b22';

interface FakeOutboxRow {
  id: string;
  tenantId: string;
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
          row.dedupeKey !== null &&
          rows.some(
            (existing) =>
              existing.tenantId === row.tenantId && existing.dedupeKey === row.dedupeKey,
          );
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
      where: { tenantId: string; dedupeKey: { in: string[] } };
    }): Promise<{ id: string; dedupeKey: string | null }[]> {
      return Promise.resolve(
        rows
          .filter(
            (row) =>
              row.tenantId === where.tenantId &&
              row.dedupeKey !== null &&
              where.dedupeKey.in.includes(row.dedupeKey),
          )
          .map((row) => ({ id: row.id, dedupeKey: row.dedupeKey })),
      );
    },
  };

  return { rows, outboxMessage };
}

type FakeTx = ReturnType<typeof createFakeTx>;

interface Harness {
  tx: FakeTx;
  /** Acts as OPERATOR_A, the operator whose money write is causing the side effect. */
  enqueue: (input: OutboxEnqueueInput) => Promise<OutboxEnqueueResult>;
  enqueueMany: (inputs: readonly OutboxEnqueueInput[]) => Promise<OutboxEnqueueResult[]>;
  /** For the tests whose whole point is that the dedupe index is per-operator. */
  enqueueAs: (tenantId: string, input: OutboxEnqueueInput) => Promise<OutboxEnqueueResult>;
}

function setup(): Harness {
  const service = new OutboxService();
  const tx = createFakeTx();
  const enqueueAs = (tenantId: string, input: OutboxEnqueueInput): Promise<OutboxEnqueueResult> =>
    runWithTenant(tenantId, () => service.enqueue(asTx(tx), input));
  return {
    tx,
    enqueueAs,
    enqueue: (input) => enqueueAs(OPERATOR_A, input),
    enqueueMany: (inputs) => runWithTenant(OPERATOR_A, () => service.enqueueMany(asTx(tx), inputs)),
  };
}

const asTx = (tx: FakeTx): Tx => tx as unknown as Tx;

describe('OutboxService.enqueue', () => {
  it('writes the message through the caller transaction and nowhere else', async () => {
    const { tx, enqueue } = setup();

    const result = await enqueue({
      aggregateType: 'DepositRequest',
      aggregateId: 'dep-1',
      topic: 'deposit.credit.requested',
      payload: { shortId: 'K7Q2ZP9V3M' },
    });

    expect(result.deduplicated).toBe(false);
    expect(tx.rows).toHaveLength(1);
    expect(tx.rows[0]).toMatchObject({
      id: result.id,
      tenantId: OPERATOR_A,
      aggregateType: 'DepositRequest',
      aggregateId: 'dep-1',
      topic: 'deposit.credit.requested',
      payload: { shortId: 'K7Q2ZP9V3M' },
      dedupeKey: null,
    });
  });

  it('mints time-ordered ids, which is what makes the relay ORDER BY id a FIFO claim', async () => {
    const { enqueue } = setup();
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const { id } = await enqueue({
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
    const { tx, enqueue } = setup();
    await enqueue({
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
    const { tx, enqueue } = setup();
    const later = new Date(Date.now() + 7_200_000);

    await enqueue({
      aggregateType: 'DepositRequest',
      aggregateId: 'dep-1',
      topic: 'deposit.expire',
      payload: {},
    });
    await enqueue({
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

describe('OutboxService — no operator, no row', () => {
  it('refuses to enqueue rather than guessing whose side effect it is', async () => {
    // A worker that forgot runWithTenant() lands here. Throwing takes the caller's transaction down
    // with it, which is right: a message with the wrong operator on it would be dispatched into
    // that operator's bot, and the player who gets the notification is not the one who deposited.
    const tx = createFakeTx();

    await expect(
      new OutboxService().enqueue(asTx(tx), {
        aggregateType: 'DepositRequest',
        aggregateId: 'dep-1',
        topic: 'deposit.credit.requested',
        payload: {},
      }),
    ).rejects.toThrow(/No tenant context/);
    expect(tx.rows).toHaveLength(0);
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
    const { tx, enqueue } = setup();

    const first = await enqueue(message);
    const second = await enqueue(message);

    expect(tx.rows).toHaveLength(1);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    // The caller gets the id that actually exists, not the one we speculatively generated.
    expect(second.id).toBe(first.id);
  });

  it('does not let one operator dedupe another operator out of its side effect', async () => {
    const { tx, enqueueAs } = setup();

    const mine = await enqueueAs(OPERATOR_A, message);
    const theirs = await enqueueAs(OPERATOR_B, message);

    // The dedupe key is built from a topic and a LOCAL aggregate id, so two operators colliding on
    // one is ordinary, not exotic. Deduping across the pair would drop B's notification for a
    // credit B really made — a lost side effect that no error anywhere would report.
    expect(theirs.deduplicated).toBe(false);
    expect(theirs.id).not.toBe(mine.id);
    expect(tx.rows.map((row) => row.tenantId)).toEqual([OPERATOR_A, OPERATOR_B]);
  });

  it('does not confuse two messages that only share a topic', async () => {
    const { tx, enqueue } = setup();
    await enqueue(message);
    const other = await enqueue({
      ...message,
      aggregateId: 'dep-2',
      dedupeKey: 'deposit.credit.requested:dep-2',
    });

    expect(tx.rows).toHaveLength(2);
    expect(other.deduplicated).toBe(false);
  });

  it('reports per-entry results for a mixed batch', async () => {
    const { tx, enqueue, enqueueMany } = setup();
    await enqueue(message);

    const results = await enqueueMany([
      message,
      { ...message, aggregateId: 'dep-3', dedupeKey: 'deposit.credit.requested:dep-3' },
      { ...message, aggregateId: 'dep-4', dedupeKey: null },
    ]);

    expect(results.map((result) => result.deduplicated)).toEqual([true, false, false]);
    expect(tx.rows).toHaveLength(3);
  });

  it('is a no-op for an empty batch', async () => {
    const { tx, enqueueMany } = setup();
    await expect(enqueueMany([])).resolves.toEqual([]);
    expect(tx.rows).toHaveLength(0);
  });
});
