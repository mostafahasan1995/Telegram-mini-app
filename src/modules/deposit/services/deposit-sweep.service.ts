/**
 * The sweeper. Three jobs, all of them repairs for something that stopped halfway:
 *
 *  1. EXPIRE  — a deposit opened, the player never paid, the TTL passed. Only DRAFT and
 *               AWAITING_PROOF are ever expired: once a proof exists, the player has parted with
 *               real money and voiding their claim on a clock would destroy it.
 *  2. RELEASE — an admin claimed a deposit and walked away. The claim is advisory (the CAS in
 *               approve() is the real lock), so releasing it is safe at any time; it just puts the
 *               row back in front of the next reviewer.
 *  3. REAP    — a deposit stuck in CREDITING. Its worker died between "I took this" and any terminal
 *               state. It goes back to APPROVED so the credit path can run again — and that is safe
 *               ONLY because the credit path starts by MEASURING the balance, never by moving money:
 *               if the dead worker's call actually landed, the delta check sees it and the deposit
 *               lands on CREDITED rather than being credited twice.
 *
 * WHY every row is transitioned individually instead of one bulk UPDATE: each transition must write
 * its own DepositTransition row and may need its own outbox message. A bulk update would produce a
 * status change nobody can explain later, which is exactly what the state machine exists to prevent.
 *
 * WHY THE LOGIC LIVES HERE AND THE SCHEDULE LIVES IN deposit-expiry.cron.ts:
 *
 * The cron is worker-only — a `@Interval` fires wherever ScheduleModule is imported, so it must not
 * exist in the api composition. But the admin panel has a "run the sweep now" button, and that
 * endpoint is served by the API. Keeping both in one class made the api's DepositAdminController
 * depend on a provider the api role deliberately does not have, which is a BOOT-TIME crash on the
 * whole deposit admin surface. (Found by deposit.di.int.spec.ts, which exists for exactly this.)
 *
 * So: this service is present in both roles and owns the work; the cron is a thin, worker-only
 * wrapper that owns only the schedule and the leader lock.
 */
import { Injectable, Logger } from '@nestjs/common';
import { DepositStatus } from '@prisma/client';

import { SYSTEM_ACTOR } from '@common/types/actor.type';
import { AuditService } from '@core/audit/audit.service';
import { AppConfigService } from '@core/config/config.service';
import { OutboxService } from '@core/outbox/outbox.service';
import { PrismaService } from '@core/prisma/prisma.service';

import {
  CREDITING_STUCK_MINUTES,
  DEPOSIT_AGGREGATE,
  DEPOSIT_TOPICS,
  REVIEW_CLAIM_MINUTES,
} from '../deposit.constants';
import { DepositStateMachine } from '../deposit-state.machine';
import { DepositRepository } from '../repositories/deposit.repository';

/** Bounded per pass so one sweep cannot hold connections for minutes on a backlog. */
const BATCH_SIZE = 100;
const MINUTE_MS = 60_000;

export interface SweepReport {
  expired: number;
  released: number;
  reaped: number;
}

@Injectable()
export class DepositSweepService {
  private readonly logger = new Logger(DepositSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deposits: DepositRepository,
    private readonly stateMachine: DepositStateMachine,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  /** One full pass. Called by the cron on a schedule and by the admin endpoint on demand. */
  async runOnce(now: Date = new Date()): Promise<SweepReport> {
    return {
      expired: await this.expireUnpaid(now),
      released: await this.releaseStaleClaims(now),
      reaped: await this.reapStuckCredits(now),
    };
  }

  // ---------------------------------------------------------------------------------------------

  private async expireUnpaid(now: Date): Promise<number> {
    const candidates = await this.deposits.findExpiredOpenIds(this.prisma, now, BATCH_SIZE);
    let expired = 0;

    for (const candidate of candidates) {
      const done = await this.prisma.runInTransaction(async (tx) => {
        const outcome = await this.stateMachine.transition(tx, {
          depositRequestId: candidate.id,
          from: [DepositStatus.DRAFT, DepositStatus.AWAITING_PROOF],
          to: DepositStatus.EXPIRED,
          actor: SYSTEM_ACTOR,
          reason: `No proof within ${this.config.limits.depositExpiryMinutes} minutes`,
        });
        if (outcome.kind === 'alreadyHandled') return false;

        await this.audit.write(tx, {
          action: 'deposit.expire',
          actor: SYSTEM_ACTOR,
          subjectType: DEPOSIT_AGGREGATE,
          subjectId: candidate.id,
          after: { status: DepositStatus.EXPIRED },
        });

        await this.outbox.enqueue(tx, {
          aggregateType: DEPOSIT_AGGREGATE,
          aggregateId: candidate.id,
          topic: DEPOSIT_TOPICS.NOTIFY_PLAYER,
          payload: {
            depositRequestId: candidate.id,
            playerId: outcome.deposit.playerId,
            template: 'deposit.expired',
            params: { shortId: outcome.deposit.shortId },
          },
          dedupeKey: `${DEPOSIT_TOPICS.NOTIFY_PLAYER}:${candidate.id}:expired`,
        });

        return true;
      });
      if (done) expired += 1;
    }

    return expired;
  }

  private async releaseStaleClaims(now: Date): Promise<number> {
    const staleBefore = new Date(now.getTime() - REVIEW_CLAIM_MINUTES * MINUTE_MS);
    const candidates = await this.deposits.findStaleClaimIds(this.prisma, staleBefore, BATCH_SIZE);
    let released = 0;

    for (const candidate of candidates) {
      const done = await this.prisma.runInTransaction(async (tx) => {
        const outcome = await this.stateMachine.transition(tx, {
          depositRequestId: candidate.id,
          from: DepositStatus.UNDER_REVIEW,
          to: DepositStatus.SUBMITTED,
          actor: SYSTEM_ACTOR,
          reason: `Review claim went stale after ${REVIEW_CLAIM_MINUTES} minutes`,
          patch: { reviewStartedAt: null, decidedByAdminId: null },
          // Re-check staleness inside the CAS: the reviewer may have come back in the meantime.
          guard: { reviewStartedAt: { lt: staleBefore } },
        });
        if (outcome.kind === 'alreadyHandled') return false;

        await this.outbox.enqueue(tx, {
          aggregateType: DEPOSIT_AGGREGATE,
          aggregateId: candidate.id,
          topic: DEPOSIT_TOPICS.CARD_UPDATE,
          payload: { depositRequestId: candidate.id, reason: 'claim-released' },
          dedupeKey: `${DEPOSIT_TOPICS.CARD_UPDATE}:${candidate.id}:released:${staleBefore.getTime()}`,
        });
        return true;
      });
      if (done) released += 1;
    }

    return released;
  }

  /**
   * Put an orphaned CREDITING row back into APPROVED and re-request the credit. The epoch is NOT
   * bumped: this is the same logical attempt resuming, and the balance-delta protocol is what makes
   * resuming safe. Bumping it would be a claim that an operator deliberately re-ran the deposit.
   */
  private async reapStuckCredits(now: Date): Promise<number> {
    const staleBefore = new Date(now.getTime() - CREDITING_STUCK_MINUTES * MINUTE_MS);
    const candidates = await this.deposits.findStuckCreditingIds(
      this.prisma,
      staleBefore,
      BATCH_SIZE,
    );
    let reaped = 0;

    for (const candidate of candidates) {
      const done = await this.prisma.runInTransaction(async (tx) => {
        const outcome = await this.stateMachine.transition(tx, {
          depositRequestId: candidate.id,
          from: DepositStatus.CREDITING,
          to: DepositStatus.APPROVED,
          actor: SYSTEM_ACTOR,
          reason: `Credit worker went silent for ${CREDITING_STUCK_MINUTES} minutes`,
          metadata: { reapedAt: now.toISOString(), creditKeyEpoch: candidate.creditKeyEpoch },
          guard: { updatedAt: { lt: staleBefore } },
        });
        if (outcome.kind === 'alreadyHandled') return false;

        const deposit = outcome.deposit;
        await this.audit.write(tx, {
          action: 'deposit.credit.reaped',
          actor: SYSTEM_ACTOR,
          subjectType: DEPOSIT_AGGREGATE,
          subjectId: candidate.id,
          before: { status: DepositStatus.CREDITING },
          after: { status: DepositStatus.APPROVED },
          metadata: { stuckSinceBefore: staleBefore.toISOString() },
        });

        await this.outbox.enqueue(tx, {
          aggregateType: DEPOSIT_AGGREGATE,
          aggregateId: candidate.id,
          topic: DEPOSIT_TOPICS.CREDIT_REQUESTED,
          payload: {
            depositRequestId: candidate.id,
            shortId: deposit.shortId,
            playerId: deposit.playerId,
            creditKeyEpoch: deposit.creditKeyEpoch,
            amountMinor: (deposit.creditedAmountMinor ?? deposit.claimedAmountMinor).toString(),
          },
          // Distinct from the approval's key so the reap is not swallowed as a duplicate of it.
          dedupeKey:
            `${DEPOSIT_TOPICS.CREDIT_REQUESTED}:${candidate.id}:${deposit.creditKeyEpoch}:` +
            `reap:${staleBefore.getTime()}`,
        });

        return true;
      });
      if (done) reaped += 1;
    }

    return reaped;
  }
}
