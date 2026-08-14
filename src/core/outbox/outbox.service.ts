/**
 * WHY the Tx parameter is required and first:
 *
 * A side effect must be registered by the same COMMIT that caused it. If `enqueue` could be called
 * without a transaction, this would compile:
 *
 *     await prisma.$transaction(...)      // credit the player
 *     await outbox.enqueue({ topic: 'deposit.credited' })   // <- separate commit
 *
 * and a crash between the two lines silently loses the notification, while a rollback after the
 * second line sends a "you were credited" message for money that never moved. Taking `Tx` as the
 * first argument makes both bugs unrepresentable: the row can only be written inside the caller's
 * transaction, so it is committed if and only if the business change is.
 *
 * This is also why nothing here talks to Redis. The whole point of the pattern is that the ONLY
 * thing leaving a money transaction is a database row; the relay publishes it afterwards.
 */
import { Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';

import { toJsonObject } from '@core/queue/json.util';
import type { Tx } from '@core/prisma/tx.type';
import type { OutboxEnqueueInput, OutboxEnqueueResult } from './outbox.types';

@Injectable()
export class OutboxService {
  /**
   * Registers one side effect. Returns the row id so the caller can correlate logs.
   *
   * The id is generated here with UUIDv7 rather than by the database default, for two reasons:
   *  - it is time-ordered, which is what makes the relay's `ORDER BY id` an actual FIFO claim
   *    (`gen_random_uuid()` would order rows at random);
   *  - the caller learns the id without a RETURNING round trip, so a batch insert stays one query.
   */
  async enqueue(tx: Tx, input: OutboxEnqueueInput): Promise<OutboxEnqueueResult> {
    const [result] = await this.enqueueMany(tx, [input]);
    /* c8 ignore next */
    if (!result) throw new Error('OUTBOX_ENQUEUE_RETURNED_NOTHING');
    return result;
  }

  /**
   * `createMany({ skipDuplicates })` compiles to INSERT ... ON CONFLICT DO NOTHING, which matters:
   * catching a P2002 inside an interactive transaction would leave PostgreSQL in "current
   * transaction is aborted" and poison the caller's money write. The conflict must be handled by
   * the database, not by a try/catch.
   */
  async enqueueMany(tx: Tx, inputs: readonly OutboxEnqueueInput[]): Promise<OutboxEnqueueResult[]> {
    if (inputs.length === 0) return [];

    const rows = inputs.map((input) => ({
      id: uuidv7(),
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      topic: input.topic,
      payload: toJsonObject(input.payload),
      dedupeKey: input.dedupeKey ?? null,
      availableAt: input.availableAt ?? new Date(),
    }));

    const { count } = await tx.outboxMessage.createMany({ data: rows, skipDuplicates: true });
    if (count === rows.length) {
      return rows.map((row) => ({ id: row.id, deduplicated: false }));
    }

    // At least one dedupeKey already existed. Resolve the real ids so callers still get something
    // they can correlate; a SELECT after ON CONFLICT DO NOTHING is safe (nothing was aborted).
    const dedupeKeys = rows
      .map((row) => row.dedupeKey)
      .filter((key): key is string => typeof key === 'string');

    const existing =
      dedupeKeys.length > 0
        ? await tx.outboxMessage.findMany({
            where: { dedupeKey: { in: dedupeKeys } },
            select: { id: true, dedupeKey: true },
          })
        : [];

    const byDedupeKey = new Map(
      existing
        .filter((row): row is { id: string; dedupeKey: string } => row.dedupeKey !== null)
        .map((row) => [row.dedupeKey, row.id] as const),
    );

    return rows.map((row) => {
      const alreadyThere = row.dedupeKey !== null ? byDedupeKey.get(row.dedupeKey) : undefined;
      return alreadyThere !== undefined && alreadyThere !== row.id
        ? { id: alreadyThere, deduplicated: true }
        : { id: row.id, deduplicated: false };
    });
  }
}
