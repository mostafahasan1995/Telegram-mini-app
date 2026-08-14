/**
 * WHY insert-first, never check-then-insert:
 *
 *   const existing = await find(scope, key);      // both requests see nothing
 *   if (!existing) await create(scope, key);      // both create -> two deposits
 *
 * Two concurrent retries of the same POST hit that window every time a phone switches from wifi to
 * mobile data. The ONLY component that can serialize them is the UNIQUE(scope,key) index, so this
 * service always writes first and treats the unique violation as the answer. Everything else here
 * (fencing, stale-lock takeover, response replay) is built on top of that single decision.
 *
 * WHY it never takes a Tx: the record has to survive the business transaction's rollback. If
 * `begin` were part of the caller's transaction, a failed handler would roll the record back and the
 * "recovery point" would vanish exactly when it is needed. `completeWithin` is the one deliberate
 * exception, for callers that want the response committed atomically with their own write.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { Prisma } from '@prisma/client';

import { fromDbJson, stableStringify, toNullableJson } from '@core/queue/json.util';
import { PrismaService } from '@core/prisma/prisma.service';
import { isUniqueConstraintError, mapPrismaError } from '@core/prisma/prisma-errors';
import type { Tx } from '@core/prisma/tx.type';

import {
  DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  IDEMPOTENCY_BEGIN_MAX_ROUNDS,
  IDEMPOTENCY_REAP_BATCH,
  IDEMPOTENCY_REAP_MAX_BATCHES,
  IDEMPOTENCY_STALE_LOCK_MS,
  IDEMPOTENCY_STATE,
} from './idempotency.constants';
import type {
  IdempotencyBeginInput,
  IdempotencyBeginResult,
  IdempotencyCompleteInput,
  IdempotencyLease,
} from './idempotency.types';

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Digest of whatever identifies the request. Key order is normalized first, so a client that
   * serializes its JSON differently on a retry still hashes to the same value.
   */
  hashRequest(value: unknown): string {
    return createHash('sha256').update(stableStringify(value)).digest('hex');
  }

  async begin(input: IdempotencyBeginInput): Promise<IdempotencyBeginResult> {
    const { scope, key, requestHash } = input;
    const ttlSeconds = input.ttlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS;

    for (let round = 0; round < IDEMPOTENCY_BEGIN_MAX_ROUNDS; round += 1) {
      // lockedAt is set from JS rather than left to the column default: the fence compares it for
      // exact equality later, and a DB-side now() has microsecond precision that a JS Date cannot
      // round-trip — the comparison would never match again.
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000);

      try {
        const created = await this.prisma.idempotencyKey.create({
          data: {
            scope,
            key,
            requestHash,
            state: IDEMPOTENCY_STATE.IN_FLIGHT,
            lockedAt: now,
            expiresAt,
          },
          select: { id: true },
        });
        return { kind: 'proceed', lease: { recordId: created.id, scope, key, fencedAt: now } };
      } catch (cause) {
        const mapped = mapPrismaError(cause, {
          model: 'IdempotencyKey',
          operation: 'create',
        });
        // Anything other than "the key already exists" is a real failure and must not be swallowed.
        if (!isUniqueConstraintError(mapped)) throw mapped;
      }

      const existing = await this.prisma.idempotencyKey.findUnique({
        where: { scope_key: { scope, key } },
      });
      // Reaped between our INSERT and our SELECT. Rare, but the retry is free.
      if (existing === null) continue;

      if (existing.requestHash !== requestHash) return { kind: 'mismatch' };

      if (existing.state === IDEMPOTENCY_STATE.COMPLETED) {
        return {
          kind: 'replay',
          response: fromDbJson(existing.responseBody),
          resultRef: existing.resultRef,
          completedAt: existing.completedAt,
        };
      }

      const staleBefore = now.getTime() - IDEMPOTENCY_STALE_LOCK_MS;
      if (existing.lockedAt.getTime() > staleBefore) {
        return { kind: 'in_flight', since: existing.lockedAt };
      }

      // The owner died. Take it over with a compare-and-swap on lockedAt so that out of N waiters
      // exactly one wins and the other N-1 loop and observe the new lock.
      //
      // The new value is forced strictly past the old one. lockedAt IS the fence, and a fence that
      // can repeat is not a fence: a wall clock dragged backwards by NTP (or simply a takeover
      // landing in the same millisecond) would hand the thief a lease indistinguishable from the
      // zombie's, and the zombie's late complete() would be accepted as if it still owned the key.
      const nextLock = new Date(Math.max(now.getTime(), existing.lockedAt.getTime() + 1));

      const stolen = await this.prisma.idempotencyKey.updateMany({
        where: {
          id: existing.id,
          state: IDEMPOTENCY_STATE.IN_FLIGHT,
          lockedAt: existing.lockedAt,
        },
        data: { lockedAt: nextLock, expiresAt },
      });

      if (stolen.count === 1) {
        this.logger.warn(
          `Recovered a stale idempotency lock for ${scope}/${key} (held since ${existing.lockedAt.toISOString()})`,
        );
        return {
          kind: 'proceed',
          lease: { recordId: existing.id, scope, key, fencedAt: nextLock },
          recoveredFrom: existing.lockedAt,
        };
      }
    }

    // Contention we could not resolve in three rounds: tell the client to retry rather than guess.
    return { kind: 'in_flight', since: new Date() };
  }

  /** Publishes the response for replay. Returns false when the lease had already been taken away. */
  async complete(lease: IdempotencyLease, input: IdempotencyCompleteInput): Promise<boolean> {
    return this.completeOn(this.prisma, lease, input);
  }

  /**
   * Same, inside the caller's transaction, for handlers that want "the deposit exists" and "the
   * response is replayable" to commit together. Costs the ability to record a response for a
   * handler that succeeded but whose transaction later failed — which is the correct trade here,
   * because in that case there is nothing to replay.
   */
  async completeWithin(
    tx: Tx,
    lease: IdempotencyLease,
    input: IdempotencyCompleteInput,
  ): Promise<boolean> {
    return this.completeOn(tx, lease, input);
  }

  /**
   * Drops the record so the SAME key may be retried from scratch. A failed attempt must not lock a
   * client out: the alternative (a FAILED state) would either answer future retries with a stale
   * error or need a fourth state nobody reads.
   */
  async release(lease: IdempotencyLease, reason?: string): Promise<boolean> {
    const { count } = await this.prisma.idempotencyKey.deleteMany({
      where: {
        id: lease.recordId,
        state: IDEMPOTENCY_STATE.IN_FLIGHT,
        lockedAt: lease.fencedAt,
      },
    });
    if (count === 0) {
      this.logger.warn(
        `Idempotency lease ${lease.scope}/${lease.key} was already taken over; release ignored`,
      );
    } else if (reason !== undefined) {
      this.logger.debug(`Released idempotency lease ${lease.scope}/${lease.key}: ${reason}`);
    }
    return count === 1;
  }

  /** Deletes expired records in bounded batches. Returns how many rows went away. */
  async reap(now: Date = new Date()): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < IDEMPOTENCY_REAP_MAX_BATCHES; batch += 1) {
      const deleted = await this.prisma.$executeRaw(buildReapQuery(now, IDEMPOTENCY_REAP_BATCH));
      total += deleted;
      if (deleted < IDEMPOTENCY_REAP_BATCH) break;
    }
    return total;
  }

  private async completeOn(
    client: Tx,
    lease: IdempotencyLease,
    input: IdempotencyCompleteInput,
  ): Promise<boolean> {
    const { count } = await client.idempotencyKey.updateMany({
      where: {
        id: lease.recordId,
        state: IDEMPOTENCY_STATE.IN_FLIGHT,
        lockedAt: lease.fencedAt,
      },
      data: {
        state: IDEMPOTENCY_STATE.COMPLETED,
        completedAt: new Date(),
        responseBody: toNullableJson(input.response),
        resultRef: input.resultRef ?? null,
      },
    });
    if (count === 0) {
      this.logger.warn(
        `Idempotency lease ${lease.scope}/${lease.key} was taken over before completion; response not stored`,
      );
    }
    return count === 1;
  }
}

/**
 * SKIP LOCKED so two workers reaping at once do not wait on each other, and a LIMIT so one sweep
 * cannot take a long lock on a table that also serves live requests.
 */
export function buildReapQuery(now: Date, limit: number): Prisma.Sql {
  return Prisma.sql`
    WITH doomed AS (
      SELECT id
        FROM idempotency_keys
       WHERE expires_at < ${now}::timestamptz
       ORDER BY expires_at
         FOR UPDATE SKIP LOCKED
       LIMIT ${limit}
    )
    DELETE FROM idempotency_keys AS k
     USING doomed AS d
     WHERE k.id = d.id
  `;
}
