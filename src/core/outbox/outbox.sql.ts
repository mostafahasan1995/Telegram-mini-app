/**
 * WHY raw SQL: the claim has to be one statement. Prisma cannot express
 * "lock N rows, skipping the ones another relay already locked, and flip their status in the same
 * breath". A findMany-then-updateMany would let two relay instances claim the same rows and publish
 * the same message twice at every tick.
 *
 * The shape is what matters, and each clause is load-bearing:
 *   FOR UPDATE      — take a row lock so a concurrent relay cannot select the same ids
 *   SKIP LOCKED     — and does not block waiting for them; it just takes the next 100
 *   LIMIT           — bounds the transaction so a backlog cannot produce a 10-minute lock
 *   ORDER BY id     — FIFO, because OutboxService mints UUIDv7 (time-ordered) ids
 *   attempts + 1    — incremented AT CLAIM, not at failure: a process that dies mid-publish must
 *                     still burn an attempt, otherwise a crash loop retries the same row forever
 *
 * Kept out of the service so the claim query can be asserted by a spec without a Nest container.
 */
import { Prisma } from '@prisma/client';

/**
 * Columns the relay needs, aliased to camelCase so the result maps straight onto ClaimedOutboxRow.
 * `m.*` is deliberately not used: an added column would silently change the row shape.
 */
const CLAIMED_COLUMNS = Prisma.sql`
      m.id,
      m.aggregate_type AS "aggregateType",
      m.aggregate_id   AS "aggregateId",
      m.topic,
      m.payload,
      m.attempts,
      m.available_at   AS "availableAt",
      m.created_at     AS "createdAt"`;

export function buildClaimQuery(limit: number, workerId: string): Prisma.Sql {
  return Prisma.sql`
    WITH claimed AS (
      SELECT id
        FROM outbox_messages
       WHERE status = 'PENDING'::outbox_status
         AND available_at <= now()
       ORDER BY id
         FOR UPDATE SKIP LOCKED
       LIMIT ${limit}
    )
    UPDATE outbox_messages AS m
       SET status    = 'IN_FLIGHT'::outbox_status,
           attempts  = m.attempts + 1,
           locked_at = now(),
           locked_by = ${workerId}
      FROM claimed AS c
     WHERE m.id = c.id
    RETURNING ${CLAIMED_COLUMNS}
  `;
}

/**
 * Takes back rows whose owner died between the claim and the mark. A row that has already burned
 * every publish attempt goes straight to DEAD instead of looping — the reaper is a recovery
 * mechanism, not a second retry budget.
 */
export function buildReaperQuery(staleBefore: Date, maxAttempts: number, note: string): Prisma.Sql {
  return Prisma.sql`
    UPDATE outbox_messages
       SET status       = CASE
                            WHEN attempts >= ${maxAttempts} THEN 'DEAD'::outbox_status
                            ELSE 'PENDING'::outbox_status
                          END,
           locked_at    = NULL,
           locked_by    = NULL,
           available_at = now(),
           last_error   = ${note}
     WHERE status = 'IN_FLIGHT'::outbox_status
       AND locked_at < ${staleBefore}::timestamptz
  `;
}

/** Status histogram for health endpoints; one scan instead of five counts. */
export function buildStatusCountQuery(): Prisma.Sql {
  return Prisma.sql`
    SELECT status::text AS status, count(*)::int AS count
      FROM outbox_messages
     GROUP BY status
  `;
}
