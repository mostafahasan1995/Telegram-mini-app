/**
 * The admin half: claim, reject, approve.
 *
 * ══ approve() IS ONE TRANSACTION AND THE ORDER IS THE DESIGN ══════════════════════════════════
 *
 *   1. CAS transition            SUBMITTED|UNDER_REVIEW|PENDING_SECOND_APPROVAL -> APPROVED
 *   2. evaluate the admin limit
 *   3. ledger.post(T1 depositApproved)
 *   4. set verifiedAmountMinor   (a SEPARATE column from claimedAmountMinor, which is never touched)
 *   5. audit.write
 *   6. outbox.enqueue('deposit.credit_requested')
 *   COMMIT.  NO HTTP ANYWHERE INSIDE.
 *
 * Why that order and not another:
 *
 *  - The CAS comes FIRST because it is the mutual exclusion. Two admins tapping Approve on the same
 *    Telegram card in the same second both reach this method; the loser's UPDATE matches zero rows
 *    and returns `alreadyHandled` before it can evaluate a limit, post to the ledger, or enqueue a
 *    credit. Doing the limit check first would mean both admins pass it and both post T1 — one of
 *    which the partial unique index would then reject, aborting a transaction that had already
 *    written an audit row.
 *
 *  - The limit check comes BEFORE the posting because exceeding it must abort the whole transaction,
 *    and it is cheaper to find out before touching the ledger's account locks.
 *
 *  - verifiedAmountMinor is written AFTER the posting so the two can never disagree: if the posting
 *    throws (an insufficient agent float trips the NON_NEGATIVE sign guard on ICHANCY_AGENT_FLOAT),
 *    the whole transaction rolls back and the deposit is still SUBMITTED, not "approved for an
 *    amount we could not fund".
 *
 *  - The outbox row is LAST and is inside the transaction, so "the credit worker must run" is
 *    committed by the same COMMIT that approved the money. It is the only thing that leaves this
 *    transaction, exactly as the layering rule requires.
 *
 * ══ FOUR EYES ════════════════════════════════════════════════════════════════════════════════
 * "May this admin release this amount alone?" is answered by APPROVAL_LIMIT_PORT, which the admin
 * module owns — the per-admin ceilings, the daily budget and the dual-approval threshold all live in
 * `admin_approval_limits` and a second implementation here would be a second answer.
 *
 * NEEDS_SECOND moves the deposit to PENDING_SECOND_APPROVAL and posts NOTHING. The second approval
 * must come from a DIFFERENT admin, which is enforced three times over: as a CAS predicate (so the
 * race between two taps cannot slip past it), as an explicit check (so the error message is useful),
 * and as a CHECK constraint in prisma/sql/005 (so no future endpoint can bypass it).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AdminRole, DepositStatus, type DepositRequest, type RejectionCode } from '@prisma/client';

import { BusinessRuleError, ForbiddenError, NotFoundError } from '@common/exceptions/app.exception';
import { formatMinorToDecimal } from '@common/helpers/money.util';
import type { AuthenticatedAdmin } from '@common/decorators/auth.types';
import { adminActor } from '@common/types/actor.type';
import { AuditService } from '@core/audit/audit.service';
import { AppConfigService } from '@core/config/config.service';
import {
  AccountRegistryService,
  depositApproved,
  ichancyAgentFloatCode,
  LedgerService,
} from '@core/ledger';
import { OutboxService } from '@core/outbox/outbox.service';
import { PrismaService } from '@core/prisma/prisma.service';
import type { Tx } from '@core/prisma/tx.type';

import {
  DEPOSIT_AGGREGATE,
  DEPOSIT_TOPICS,
  REVIEW_CLAIM_MINUTES,
  creditJobId,
} from '../deposit.constants';
import { DepositStateMachine, REVIEWABLE_STATUSES } from '../deposit-state.machine';
import { DepositErrorCodes } from '../enums/deposit-error-code.enum';
import { APPROVAL_LIMIT_PORT, type ApprovalDecisionValue, type ApprovalLimitPort } from '../ports';
import { DepositRepository } from '../repositories/deposit.repository';

export interface ApproveInput {
  depositRequestId: string;
  admin: AuthenticatedAdmin;
  /** What the admin actually confirmed. Omit to accept the player's claim verbatim. */
  verifiedAmountMinor?: bigint;
  note?: string;
}

export interface RejectInput {
  depositRequestId: string;
  admin: AuthenticatedAdmin;
  rejectionCode: RejectionCode;
  rejectionNote?: string;
}

export type ReviewOutcome =
  | { kind: 'approved'; deposit: DepositRequest; ledgerTransactionId: string }
  | { kind: 'awaiting_second_approval'; deposit: DepositRequest }
  | { kind: 'rejected'; deposit: DepositRequest }
  | { kind: 'claimed'; deposit: DepositRequest }
  | { kind: 'released'; deposit: DepositRequest }
  /** Somebody else already decided. NOT an error — see DepositStateMachine's header. */
  | { kind: 'alreadyHandled'; status: DepositStatus | null };

/** Roles allowed to decide money. VIEWER and SUPPORT can look; they cannot approve. */
const DECIDING_ROLES: readonly AdminRole[] = Object.freeze([
  AdminRole.SUPER_ADMIN,
  AdminRole.FINANCE_ADMIN,
  AdminRole.REVIEWER,
]);

const MINUTE_MS = 60_000;

@Injectable()
export class DepositReviewService {
  private readonly logger = new Logger(DepositReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deposits: DepositRepository,
    private readonly stateMachine: DepositStateMachine,
    private readonly ledger: LedgerService,
    private readonly accounts: AccountRegistryService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    // Owned by the admin module; reached through a string token so no modules/A -> modules/B import
    // is needed. See ../ports.
    @Inject(APPROVAL_LIMIT_PORT) private readonly approvalLimits: ApprovalLimitPort,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // CLAIM / RELEASE
  // ---------------------------------------------------------------------------------------------

  /**
   * Soft lock for REVIEW_CLAIM_MINUTES. "Soft" is accurate: it is advisory UI state, not a
   * correctness mechanism — the CAS in approve()/reject() is what actually prevents a double
   * decision. Its job is to stop two reviewers wasting ten minutes on the same receipt.
   */
  async claim(input: {
    depositRequestId: string;
    admin: AuthenticatedAdmin;
  }): Promise<ReviewOutcome> {
    this.assertCanDecide(input.admin);
    const now = new Date();
    const staleBefore = new Date(now.getTime() - REVIEW_CLAIM_MINUTES * MINUTE_MS);

    return this.prisma.runInTransaction(async (tx) => {
      const outcome = await this.stateMachine.transition(tx, {
        depositRequestId: input.depositRequestId,
        from: [DepositStatus.SUBMITTED, DepositStatus.UNDER_REVIEW],
        to: DepositStatus.UNDER_REVIEW,
        actor: adminActor(input.admin.adminUserId),
        reason: `Claimed by ${input.admin.displayName}`,
        patch: { reviewStartedAt: now, decidedByAdminId: input.admin.adminUserId },
        // Take it only if nobody holds it, THIS admin already holds it, or the holder went stale.
        // Expressed as CAS predicates so the check and the take are one statement.
        guard: {
          OR: [
            { reviewStartedAt: null },
            { decidedByAdminId: input.admin.adminUserId },
            { reviewStartedAt: { lt: staleBefore } },
          ],
        },
      });

      if (outcome.kind === 'alreadyHandled') {
        if (outcome.reason === 'GUARD_FAILED') {
          throw new BusinessRuleError(
            DepositErrorCodes.DEPOSIT_CLAIMED_BY_OTHER,
            'Another reviewer is looking at this deposit.',
          );
        }
        return { kind: 'alreadyHandled', status: outcome.current };
      }

      await this.audit.write(tx, {
        action: 'deposit.claim',
        actor: adminActor(input.admin.adminUserId),
        subjectType: DEPOSIT_AGGREGATE,
        subjectId: input.depositRequestId,
        after: { status: DepositStatus.UNDER_REVIEW, reviewStartedAt: now.toISOString() },
      });

      return { kind: 'claimed', deposit: outcome.deposit };
    });
  }

  /** Give the deposit back to the queue. Also used by the expiry cron for stale claims. */
  async release(input: {
    depositRequestId: string;
    admin?: AuthenticatedAdmin;
    reason: string;
  }): Promise<ReviewOutcome> {
    const actor =
      input.admin === undefined
        ? { type: 'SYSTEM' as const, id: null }
        : adminActor(input.admin.adminUserId);

    return this.prisma.runInTransaction(async (tx) => {
      const outcome = await this.stateMachine.transition(tx, {
        depositRequestId: input.depositRequestId,
        from: DepositStatus.UNDER_REVIEW,
        to: DepositStatus.SUBMITTED,
        actor,
        reason: input.reason,
        patch: { reviewStartedAt: null, decidedByAdminId: null },
        ...(input.admin === undefined
          ? {}
          : { guard: { decidedByAdminId: input.admin.adminUserId } }),
      });

      if (outcome.kind === 'alreadyHandled') {
        return { kind: 'alreadyHandled', status: outcome.current };
      }
      return { kind: 'released', deposit: outcome.deposit };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // REJECT
  // ---------------------------------------------------------------------------------------------

  /**
   * A rejection posts NOTHING to the ledger. T1 is the moment we accept a claim; a claim we never
   * accepted has no ledger existence to undo. This is why rejecting is safe to do from a Telegram
   * button with no compensation logic behind it.
   */
  async reject(input: RejectInput): Promise<ReviewOutcome> {
    this.assertCanDecide(input.admin);
    const now = new Date();

    return this.prisma.runInTransaction(async (tx) => {
      const before = await this.requireDeposit(tx, input.depositRequestId);

      const outcome = await this.stateMachine.transition(tx, {
        depositRequestId: input.depositRequestId,
        from: [...REVIEWABLE_STATUSES],
        to: DepositStatus.REJECTED,
        actor: adminActor(input.admin.adminUserId),
        reason: `Rejected: ${input.rejectionCode}`,
        metadata: { rejectionCode: input.rejectionCode },
        patch: {
          rejectionCode: input.rejectionCode,
          rejectionNote: input.rejectionNote ?? null,
          decidedAt: now,
          decidedByAdminId: input.admin.adminUserId,
          reviewStartedAt: null,
        },
      });

      if (outcome.kind === 'alreadyHandled') {
        return { kind: 'alreadyHandled', status: outcome.current };
      }

      await this.audit.write(tx, {
        action: 'deposit.reject',
        actor: adminActor(input.admin.adminUserId),
        subjectType: DEPOSIT_AGGREGATE,
        subjectId: input.depositRequestId,
        before: { status: before.status },
        after: { status: DepositStatus.REJECTED, rejectionCode: input.rejectionCode },
        amountMinor: before.claimedAmountMinor,
        metadata: { rejectionNote: input.rejectionNote ?? null },
      });

      await this.outbox.enqueueMany(tx, [
        {
          aggregateType: DEPOSIT_AGGREGATE,
          aggregateId: input.depositRequestId,
          topic: DEPOSIT_TOPICS.NOTIFY_PLAYER,
          payload: {
            depositRequestId: input.depositRequestId,
            playerId: before.playerId,
            template: 'deposit.rejected',
            params: { shortId: before.shortId, rejectionCode: input.rejectionCode },
          },
          dedupeKey: `${DEPOSIT_TOPICS.NOTIFY_PLAYER}:${input.depositRequestId}:rejected`,
        },
        {
          aggregateType: DEPOSIT_AGGREGATE,
          aggregateId: input.depositRequestId,
          topic: DEPOSIT_TOPICS.CARD_UPDATE,
          payload: { depositRequestId: input.depositRequestId, reason: 'rejected' },
          dedupeKey: `${DEPOSIT_TOPICS.CARD_UPDATE}:${input.depositRequestId}:rejected`,
        },
      ]);

      return { kind: 'rejected', deposit: outcome.deposit };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // APPROVE
  // ---------------------------------------------------------------------------------------------

  async approve(input: ApproveInput): Promise<ReviewOutcome> {
    this.assertCanDecide(input.admin);

    return this.prisma.runInTransaction(async (tx) => {
      const before = await this.requireDeposit(tx, input.depositRequestId);
      const verifiedAmountMinor = input.verifiedAmountMinor ?? before.claimedAmountMinor;
      if (verifiedAmountMinor <= 0n) {
        throw new BusinessRuleError(
          DepositErrorCodes.VERIFIED_AMOUNT_REQUIRED,
          'The verified amount must be greater than zero.',
        );
      }

      // The admin module owns "may this person release this amount alone?". Asking it here decides
      // WHICH transition to attempt — you cannot compare-and-swap towards a state you have not
      // chosen yet — and a DENIED answer stops before any state changes at all, which is the right
      // outcome for an admin who was never authorised.
      const decision = await this.evaluateAuthority(
        tx,
        input,
        verifiedAmountMinor,
        before.currencyCode,
      );
      const needsSecond = decision === 'NEEDS_SECOND';

      if (needsSecond && before.status !== DepositStatus.PENDING_SECOND_APPROVAL) {
        return this.recordFirstApproval(tx, before, input, verifiedAmountMinor);
      }

      // Second (or only) approval. Four eyes: the CAS itself refuses when the first approver is the
      // one asking, so the race between two taps cannot slip past the check.
      if (needsSecond && before.decidedByAdminId === input.admin.adminUserId) {
        throw new ForbiddenError(
          DepositErrorCodes.SECOND_APPROVER_MUST_DIFFER,
          'A second, different administrator must approve this amount.',
        );
      }

      return this.finalizeApproval(tx, before, input, verifiedAmountMinor, needsSecond);
    });
  }

  /** Step 1 of four eyes: park it, tell the admin chat, post nothing. */
  private async recordFirstApproval(
    tx: Tx,
    before: DepositRequest,
    input: ApproveInput,
    verifiedAmountMinor: bigint,
  ): Promise<ReviewOutcome> {
    const now = new Date();
    const outcome = await this.stateMachine.transition(tx, {
      depositRequestId: before.id,
      from: [DepositStatus.SUBMITTED, DepositStatus.UNDER_REVIEW],
      to: DepositStatus.PENDING_SECOND_APPROVAL,
      actor: adminActor(input.admin.adminUserId),
      reason: `First approval by ${input.admin.displayName}; awaiting a second`,
      metadata: {
        decision: 'NEEDS_SECOND',
        verifiedAmountMinor: verifiedAmountMinor.toString(),
      },
      patch: {
        decidedByAdminId: input.admin.adminUserId,
        decidedAt: now,
        // Recorded now so the second approver sees the number they are confirming, not the claim.
        verifiedAmountMinor,
        reviewStartedAt: null,
      },
    });

    if (outcome.kind === 'alreadyHandled') {
      return { kind: 'alreadyHandled', status: outcome.current };
    }

    await this.audit.write(tx, {
      action: 'deposit.approve.first',
      actor: adminActor(input.admin.adminUserId),
      subjectType: DEPOSIT_AGGREGATE,
      subjectId: before.id,
      before: { status: before.status },
      after: { status: DepositStatus.PENDING_SECOND_APPROVAL },
      amountMinor: verifiedAmountMinor,
      metadata: { decision: 'NEEDS_SECOND', note: input.note ?? null },
    });

    await this.outbox.enqueue(tx, {
      aggregateType: DEPOSIT_AGGREGATE,
      aggregateId: before.id,
      topic: DEPOSIT_TOPICS.CARD_UPDATE,
      payload: { depositRequestId: before.id, reason: 'awaiting-second-approval' },
      dedupeKey: `${DEPOSIT_TOPICS.CARD_UPDATE}:${before.id}:second-approval`,
    });

    return { kind: 'awaiting_second_approval', deposit: outcome.deposit };
  }

  /** The real approval. Follows the six-step order in this file's header, exactly. */
  private async finalizeApproval(
    tx: Tx,
    before: DepositRequest,
    input: ApproveInput,
    verifiedAmountMinor: bigint,
    wasSecondApproval: boolean,
  ): Promise<ReviewOutcome> {
    const now = new Date();
    const creditAmountMinor = verifiedAmountMinor - before.feeMinor;
    if (creditAmountMinor <= 0n) {
      throw new BusinessRuleError(
        DepositErrorCodes.VERIFIED_AMOUNT_REQUIRED,
        'The verified amount does not cover the fee on this payment method.',
        {
          verifiedAmountMinor: verifiedAmountMinor.toString(),
          feeMinor: before.feeMinor.toString(),
        },
      );
    }

    // ── 1. CAS transition ────────────────────────────────────────────────────────────────────
    const outcome = await this.stateMachine.transition(tx, {
      depositRequestId: before.id,
      from: [...REVIEWABLE_STATUSES],
      to: DepositStatus.APPROVED,
      actor: adminActor(input.admin.adminUserId),
      reason: wasSecondApproval
        ? `Second approval by ${input.admin.displayName}`
        : `Approved by ${input.admin.displayName}`,
      metadata: {
        verifiedAmountMinor: verifiedAmountMinor.toString(),
        creditAmountMinor: creditAmountMinor.toString(),
        wasSecondApproval,
      },
      patch: {
        ...(wasSecondApproval
          ? { secondApproverAdminId: input.admin.adminUserId, secondApprovedAt: now }
          : { decidedByAdminId: input.admin.adminUserId }),
        decidedAt: now,
        reviewStartedAt: null,
      },
      // Four eyes as a CAS predicate, not a read-then-check: a second approver who IS the first is
      // filtered out by the UPDATE itself.
      ...(wasSecondApproval
        ? { guard: { decidedByAdminId: { not: input.admin.adminUserId } } }
        : {}),
    });

    if (outcome.kind === 'alreadyHandled') {
      if (outcome.reason === 'GUARD_FAILED') {
        throw new ForbiddenError(
          DepositErrorCodes.SECOND_APPROVER_MUST_DIFFER,
          'A second, different administrator must approve this amount.',
        );
      }
      return { kind: 'alreadyHandled', status: outcome.current };
    }

    // ── 2. admin limit ───────────────────────────────────────────────────────────────────────
    // Re-evaluated AFTER the CAS, in the order the design mandates. It ran once before, to choose
    // which transition to attempt; running it again here is cheap and is what enforces the ceiling
    // against the same snapshot as the posting it authorises. A DENIED answer rolls the whole
    // transaction back, including the transition above.
    await this.evaluateAuthority(tx, input, verifiedAmountMinor, before.currencyCode);

    // Advisory, not a gate: the ledger's NON_NEGATIVE sign guard on ICHANCY_AGENT_FLOAT is what
    // actually refuses an unfundable credit, and it does so at T2. Warning here means an operator
    // learns about it while approving rather than when the credit fails.
    await this.warnOnLowFloat(tx, before.currencyCode, creditAmountMinor);

    // ── 3. T1 ────────────────────────────────────────────────────────────────────────────────
    const posted = await this.ledger.post(
      tx,
      depositApproved({
        depositId: before.id,
        shortId: before.shortId,
        playerId: before.playerId,
        paymentMethodId: before.paymentMethodId,
        amountMinor: creditAmountMinor,
        currency: before.currencyCode,
        actor: adminActor(input.admin.adminUserId),
        occurredAt: before.submittedAt ?? now,
      }),
    );

    // ── 4. verified/credited amounts, kept separate from the claim ───────────────────────────
    const deposit = await tx.depositRequest.update({
      where: { id: before.id },
      data: {
        verifiedAmountMinor,
        creditedAmountMinor: creditAmountMinor,
        ledgerClaimTxId: posted.transactionId,
      },
    });

    // ── 5. audit ─────────────────────────────────────────────────────────────────────────────
    await this.audit.write(tx, {
      action: wasSecondApproval ? 'deposit.approve.second' : 'deposit.approve',
      actor: adminActor(input.admin.adminUserId),
      subjectType: DEPOSIT_AGGREGATE,
      subjectId: before.id,
      before: {
        status: before.status,
        claimedAmountMinor: before.claimedAmountMinor.toString(),
        verifiedAmountMinor: before.verifiedAmountMinor?.toString() ?? null,
      },
      after: {
        status: DepositStatus.APPROVED,
        verifiedAmountMinor: verifiedAmountMinor.toString(),
        creditedAmountMinor: creditAmountMinor.toString(),
        ledgerClaimTxId: posted.transactionId,
      },
      amountMinor: verifiedAmountMinor,
      metadata: {
        note: input.note ?? null,
        wasSecondApproval,
        claimAcceptedVerbatim: input.verifiedAmountMinor === undefined,
      },
    });

    // ── 6. outbox: the ONLY thing that leaves this transaction ───────────────────────────────
    await this.outbox.enqueueMany(tx, [
      {
        aggregateType: DEPOSIT_AGGREGATE,
        aggregateId: before.id,
        topic: DEPOSIT_TOPICS.CREDIT_REQUESTED,
        payload: {
          depositRequestId: before.id,
          shortId: before.shortId,
          playerId: before.playerId,
          creditKeyEpoch: before.creditKeyEpoch,
          // Money on a queue is a decimal string of MINOR units — never a bigint, never a float.
          amountMinor: creditAmountMinor.toString(),
        },
        // The epoch is in the key: an operator-triggered re-run is a NEW event, a redelivery is not.
        dedupeKey: `${DEPOSIT_TOPICS.CREDIT_REQUESTED}:${before.id}:${before.creditKeyEpoch}`,
      },
      {
        aggregateType: DEPOSIT_AGGREGATE,
        aggregateId: before.id,
        topic: DEPOSIT_TOPICS.CARD_UPDATE,
        payload: { depositRequestId: before.id, reason: 'approved' },
        dedupeKey: `${DEPOSIT_TOPICS.CARD_UPDATE}:${before.id}:approved`,
      },
    ]);

    this.logger.log(
      `deposit ${before.shortId} approved by ${input.admin.displayName} ` +
        `(${formatMinorToDecimal(creditAmountMinor)} ${before.currencyCode}, T1 ${posted.transactionId}); ` +
        `credit job ${creditJobId(before.id, before.creditKeyEpoch)}`,
    );

    return { kind: 'approved', deposit, ledgerTransactionId: posted.transactionId };
  }

  // ---------------------------------------------------------------------------------------------
  // LIMITS
  // ---------------------------------------------------------------------------------------------

  /**
   * Ask the admin module whether this person may release this amount alone.
   *
   * WHY it is not implemented here: the versioned per-admin ceilings, the daily budget and the
   * dual-approval threshold all live in `admin_approval_limits`, which the admin module owns and
   * maintains. A second implementation of "how much may this admin approve?" would be a second
   * answer, and the two would drift the first time someone adds a rule to one of them.
   *
   * DENIED is a 403, never a silent downgrade to "needs a second approval": an admin who is not
   * authorised must be told so, not routed into a slower path that might still release the money.
   */
  private async evaluateAuthority(
    tx: Tx,
    input: ApproveInput,
    amountMinor: bigint,
    currencyCode: string,
  ): Promise<ApprovalDecisionValue> {
    const decision = await this.approvalLimits.evaluate(
      tx,
      { adminUserId: input.admin.adminUserId, role: input.admin.role },
      amountMinor,
      currencyCode,
    );

    if (decision === 'DENIED') {
      throw new ForbiddenError(
        DepositErrorCodes.ADMIN_LIMIT_EXCEEDED,
        'This amount is above your approval authority.',
        { amountMinor: amountMinor.toString(), currencyCode },
      );
    }
    return decision;
  }

  /**
   * Compare the amount about to be promised against the agent float we actually hold. Read from the
   * ENTRIES, not the advisory cache: this number decides whether an operator gets a warning while
   * they still have a choice.
   */
  private async warnOnLowFloat(tx: Tx, currencyCode: string, amountMinor: bigint): Promise<void> {
    const account = await this.accounts.findByCode(tx, ichancyAgentFloatCode(currencyCode));
    if (account === null) return;

    const balance = await this.accounts.computeBalanceFromEntries(tx, account.id);
    if (balance - amountMinor < 0n) {
      this.logger.error(
        `agent float ${formatMinorToDecimal(balance)} ${currencyCode} cannot cover a ` +
          `${formatMinorToDecimal(amountMinor)} credit; the T2 posting will refuse it`,
      );
      return;
    }
    if (balance - amountMinor < this.config.limits.agentFloatLowWatermarkMinor) {
      this.logger.warn(
        `agent float will drop to ${formatMinorToDecimal(balance - amountMinor)} ${currencyCode}, ` +
          `below the low watermark`,
      );
    }
  }

  private async requireDeposit(tx: Tx, id: string): Promise<DepositRequest> {
    const deposit = await this.deposits.findById(tx, id);
    if (deposit === null) {
      throw new NotFoundError(DepositErrorCodes.DEPOSIT_NOT_FOUND, 'Deposit not found.');
    }
    return deposit;
  }

  private assertCanDecide(admin: AuthenticatedAdmin): void {
    if (!DECIDING_ROLES.includes(admin.role)) {
      throw new ForbiddenError(
        DepositErrorCodes.ADMIN_NO_APPROVAL_LIMIT,
        'Your role cannot decide deposits.',
        { role: admin.role },
      );
    }
  }
}
