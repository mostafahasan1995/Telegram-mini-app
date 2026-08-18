/**
 * WHY this file is the ONLY writer of DepositRequest.status:
 *
 * A deposit is decided by four independent actors — a player in the mini-app, an admin tapping a
 * Telegram button, a BullMQ worker calling Ichancy, and a cron reaping expiries. All four can act on
 * the same row in the same second. If any of them writes `status` with a plain UPDATE, the last
 * writer wins and the loser's side effects (a ledger posting, an Ichancy credit, a player
 * notification) have already happened. So there is exactly one entry point, and it is a
 * COMPARE-AND-SWAP:
 *
 *     UPDATE deposit_requests SET status = $to, ... WHERE id = $id AND status IN ($from…)
 *
 * ZERO ROWS IS A RESULT, NOT AN ERROR. `alreadyHandled` is returned, never thrown. This is the
 * single most important decision in the module: a Telegram callback that Telegram re-delivered, an
 * outbox message published twice, and a cron racing an admin are all NORMAL, and the correct
 * response to every one of them is "somebody else got there first, carry on". Throwing would turn
 * routine concurrency into failed jobs and retried side effects.
 *
 * ON `RETURNING *`: the brief asked for `UPDATE … RETURNING *`. Prisma's `updateMany` emits exactly
 * that UPDATE with exactly that WHERE clause; only RETURNING is missing, and it is recovered by a
 * read inside the SAME transaction, which is safe precisely because the UPDATE holds the row lock
 * until commit — no other writer can slip between them. The alternative (hand-mapping forty
 * snake_case columns out of $queryRaw) buys nothing and drifts the first time a column is added.
 *
 * Every successful transition also writes a DepositTransition row. That table is the history an
 * auditor reads; a status change without one would be a state we cannot explain later.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  DepositStatus,
  type CreditVerifiedBy,
  type DepositRequest,
  type Prisma,
  type RejectionCode,
} from '@prisma/client';

import type { Actor } from '@common/types/actor.type';
import { toNullableJson } from '@core/queue/json.util';
import type { Tx } from '@core/prisma/tx.type';

/**
 * Which statuses may follow which. This is the product's rulebook, and it is enforced as a
 * PROGRAMMING error (a thrown Error, not a business exception): an illegal edge means the code is
 * wrong, not that the user did something we must explain politely.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<DepositStatus, readonly DepositStatus[]>> =
  Object.freeze({
    [DepositStatus.DRAFT]: [
      DepositStatus.AWAITING_PROOF,
      DepositStatus.SUBMITTED,
      DepositStatus.EXPIRED,
      DepositStatus.REJECTED,
    ],
    [DepositStatus.AWAITING_PROOF]: [
      DepositStatus.SUBMITTED,
      DepositStatus.EXPIRED,
      DepositStatus.REJECTED,
    ],
    [DepositStatus.SUBMITTED]: [
      DepositStatus.UNDER_REVIEW,
      DepositStatus.PENDING_SECOND_APPROVAL,
      DepositStatus.APPROVED,
      DepositStatus.REJECTED,
      DepositStatus.EXPIRED,
    ],
    [DepositStatus.UNDER_REVIEW]: [
      // Back to SUBMITTED when a claim is released or expires.
      DepositStatus.SUBMITTED,
      // SELF-EDGE, and it is load-bearing. `DepositReviewService.claim` declares
      // `from: [SUBMITTED, UNDER_REVIEW] -> to: UNDER_REVIEW`, and `transition()` asserts EVERY
      // declared `from` up front, before touching the row. Without this entry the assertion threw
      // on the UNDER_REVIEW leg of every single call, so claim was a guaranteed 500 — over HTTP and
      // from the bot's Claim button alike — no matter what state the deposit was actually in.
      // The re-claim is not a no-op either: the CAS guard lets the SAME admin refresh their hold,
      // and lets another admin take over one that has gone stale.
      DepositStatus.UNDER_REVIEW,
      DepositStatus.PENDING_SECOND_APPROVAL,
      DepositStatus.APPROVED,
      DepositStatus.REJECTED,
      DepositStatus.EXPIRED,
    ],
    [DepositStatus.PENDING_SECOND_APPROVAL]: [
      DepositStatus.APPROVED,
      DepositStatus.REJECTED,
      DepositStatus.EXPIRED,
    ],
    [DepositStatus.APPROVED]: [DepositStatus.CREDITING, DepositStatus.REVERSED],
    [DepositStatus.CREDITING]: [
      DepositStatus.CREDITED,
      DepositStatus.CREDIT_FAILED,
      DepositStatus.NEEDS_RECONCILIATION,
      // The expiry cron pushes a worker-orphaned CREDITING row back to APPROVED to be retried.
      DepositStatus.APPROVED,
    ],
    [DepositStatus.CREDITED]: [DepositStatus.REVERSED],
    [DepositStatus.CREDIT_FAILED]: [
      // A deliberate operator retry bumps creditKeyEpoch and re-enters the credit path.
      DepositStatus.APPROVED,
      DepositStatus.NEEDS_RECONCILIATION,
      DepositStatus.REVERSED,
    ],
    [DepositStatus.NEEDS_RECONCILIATION]: [
      DepositStatus.CREDITED,
      DepositStatus.CREDIT_FAILED,
      // Same defect as the UNDER_REVIEW self-edge above: `DepositRetryService` declares
      // `from: [CREDIT_FAILED, NEEDS_RECONCILIATION] -> to: APPROVED`, CREDIT_FAILED had the edge
      // and this one did not, so the up-front assertion threw on every retry attempt. A human who
      // has checked Ichancy and confirmed the credit never landed must be able to re-run it; that
      // is the entire purpose of the operator retry, and it bumps creditKeyEpoch on the way.
      DepositStatus.APPROVED,
      DepositStatus.REVERSED,
    ],
    [DepositStatus.REJECTED]: [],
    [DepositStatus.EXPIRED]: [],
    [DepositStatus.REVERSED]: [],
  });

/** Statuses from which nothing further can happen. */
export const TERMINAL_STATUSES: readonly DepositStatus[] = Object.freeze([
  DepositStatus.REJECTED,
  DepositStatus.EXPIRED,
  DepositStatus.REVERSED,
  DepositStatus.CREDITED,
]);

/** Statuses that still occupy a player's "open deposits" budget and the review queue. */
export const OPEN_STATUSES: readonly DepositStatus[] = Object.freeze([
  DepositStatus.DRAFT,
  DepositStatus.AWAITING_PROOF,
  DepositStatus.SUBMITTED,
  DepositStatus.UNDER_REVIEW,
  DepositStatus.PENDING_SECOND_APPROVAL,
  DepositStatus.APPROVED,
  DepositStatus.CREDITING,
]);

/** Statuses an admin can still act on. Drives the default admin queue filter. */
export const REVIEWABLE_STATUSES: readonly DepositStatus[] = Object.freeze([
  DepositStatus.SUBMITTED,
  DepositStatus.UNDER_REVIEW,
  DepositStatus.PENDING_SECOND_APPROVAL,
]);

export const isTerminal = (status: DepositStatus): boolean => TERMINAL_STATUSES.includes(status);

/**
 * Columns a transition is allowed to write alongside `status`, so the CAS and the bookkeeping it
 * implies commit as one statement. Deliberately narrow: `claimedAmountMinor` is NOT here, because
 * what a player claimed is never rewritten by a state change.
 */
export interface TransitionPatch {
  verifiedAmountMinor?: bigint | null;
  creditedAmountMinor?: bigint | null;
  feeMinor?: bigint;
  expiresAt?: Date | null;
  submittedAt?: Date | null;
  reviewStartedAt?: Date | null;
  decidedAt?: Date | null;
  secondApprovedAt?: Date | null;
  creditedAt?: Date | null;
  decidedByAdminId?: string | null;
  secondApproverAdminId?: string | null;
  rejectionCode?: RejectionCode | null;
  rejectionNote?: string | null;
  creditKeyEpoch?: number;
  creditAttempts?: number;
  creditVerifiedBy?: CreditVerifiedBy | null;
  balanceBeforeMinor?: bigint | null;
  balanceAfterMinor?: bigint | null;
  ledgerClaimTxId?: string | null;
  ledgerCreditTxId?: string | null;
  adminChatId?: bigint | null;
  adminMessageId?: bigint | null;
  adminThreadId?: bigint | null;
  externalReference?: string | null;
  senderAccount?: string | null;
  paymentDestinationId?: string | null;
}

export interface TransitionInput {
  depositRequestId: string;
  /** Every status the caller is willing to move FROM. Zero matches means somebody else acted. */
  from: DepositStatus | readonly DepositStatus[];
  to: DepositStatus;
  actor: Actor;
  /** Free text stored on the transition row; say WHY. */
  reason?: string;
  /** Anything that explains the move: an Ichancy error code, a job id, the risk flags. */
  metadata?: Record<string, unknown>;
  patch?: TransitionPatch;
  /**
   * Extra CAS predicates ANDed into the WHERE clause. Used by the review path to require that the
   * deposit is still claimed by this admin, without a second read that a race could invalidate.
   */
  guard?: Prisma.DepositRequestWhereInput;
}

export type TransitionOutcome =
  | { kind: 'transitioned'; deposit: DepositRequest; from: DepositStatus }
  /**
   * Nothing was written. `current` is the status the row actually holds (null when the row is
   * gone). Callers switch on this and return success, not an error — see the header.
   */
  | { kind: 'alreadyHandled'; current: DepositStatus | null; reason: AlreadyHandledReason };

export type AlreadyHandledReason = 'NOT_FOUND' | 'STATUS_MISMATCH' | 'GUARD_FAILED';

/** `deposit_transitions.actor_id` is a uuid column; anything else must not abort a money write. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class IllegalDepositTransitionError extends Error {
  readonly code = 'DEPOSIT_ILLEGAL_TRANSITION';

  constructor(
    readonly from: DepositStatus,
    readonly to: DepositStatus,
  ) {
    super(`${from} -> ${to} is not a legal deposit transition`);
    this.name = 'IllegalDepositTransitionError';
  }
}

@Injectable()
export class DepositStateMachine {
  private readonly logger = new Logger(DepositStateMachine.name);

  /**
   * Compare-and-swap the status, write the history row, return the fresh deposit.
   * Takes `tx` first, like every service that writes money: the transition and whatever it
   * authorises (a ledger posting, an outbox row) must commit together or not at all.
   */
  async transition(tx: Tx, input: TransitionInput): Promise<TransitionOutcome> {
    // `Array.isArray` widens a readonly tuple to `any[]` under the type-checked lint rules, so the
    // narrowing is done on the declared type instead of on the runtime check.
    const fromStatuses: DepositStatus[] =
      typeof input.from === 'string' ? [input.from] : [...input.from];
    for (const from of fromStatuses) this.assertLegal(from, input.to);

    const { count } = await tx.depositRequest.updateMany({
      where: {
        id: input.depositRequestId,
        status: { in: fromStatuses },
        ...(input.guard ?? {}),
      },
      data: {
        status: input.to,
        ...this.toPrismaPatch(input.patch),
      },
    });

    if (count === 0) return this.explainMiss(tx, input, fromStatuses);

    // Safe read: the UPDATE above holds this row's lock until COMMIT, so nothing can change it
    // between the two statements. This is the RETURNING * the CAS conceptually asks for.
    const deposit = await tx.depositRequest.findUniqueOrThrow({
      where: { id: input.depositRequestId },
    });

    // `from` is recorded as the status that actually matched. With a single-element `from` that is
    // exact; with several, the row we just read can no longer tell us which one it was, so we log
    // the candidate set instead of guessing.
    const from = fromStatuses.length === 1 ? (fromStatuses[0] as DepositStatus) : null;

    await tx.depositTransition.create({
      data: {
        depositRequestId: input.depositRequestId,
        fromStatus: from,
        toStatus: input.to,
        actorType: input.actor.type,
        actorId: this.normalizeActorId(input.actor.id),
        reason: input.reason ?? null,
        metadata: toNullableJson(
          input.metadata === undefined && from !== null
            ? undefined
            : {
                ...(input.metadata ?? {}),
                ...(from === null ? { fromCandidates: fromStatuses } : {}),
              },
        ),
      },
      select: { id: true },
    });

    return { kind: 'transitioned', deposit, from: from ?? deposit.status };
  }

  /**
   * Convenience wrapper for callers that only want to know whether they own the next step.
   * Returns the deposit or null; never throws on contention.
   */
  async tryTransition(tx: Tx, input: TransitionInput): Promise<DepositRequest | null> {
    const outcome = await this.transition(tx, input);
    if (outcome.kind === 'transitioned') return outcome.deposit;
    this.logger.debug(
      `deposit ${input.depositRequestId} -> ${input.to} skipped (${outcome.reason}, now ${
        outcome.current ?? 'gone'
      })`,
    );
    return null;
  }

  private assertLegal(from: DepositStatus, to: DepositStatus): void {
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
      throw new IllegalDepositTransitionError(from, to);
    }
  }

  /**
   * Why the miss happened, for the caller's log line and for `alreadyHandled.current`. This read is
   * outside any lock, so `current` is advisory — it is never used to make a second decision.
   */
  private async explainMiss(
    tx: Tx,
    input: TransitionInput,
    fromStatuses: readonly DepositStatus[],
  ): Promise<TransitionOutcome> {
    const row = await tx.depositRequest.findUnique({
      where: { id: input.depositRequestId },
      select: { status: true },
    });
    if (row === null) return { kind: 'alreadyHandled', current: null, reason: 'NOT_FOUND' };
    const reason: AlreadyHandledReason = fromStatuses.includes(row.status)
      ? 'GUARD_FAILED'
      : 'STATUS_MISMATCH';
    return { kind: 'alreadyHandled', current: row.status, reason };
  }

  /**
   * Only keys the caller actually set are forwarded. Spreading the patch wholesale would turn an
   * absent optional into an explicit `undefined`, which Prisma ignores — harmless today, but it
   * would silently swallow a future `null` meaning "clear this column".
   */
  private toPrismaPatch(
    patch: TransitionPatch | undefined,
  ): Prisma.DepositRequestUncheckedUpdateManyInput {
    if (patch === undefined) return {};
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) data[key] = value;
    }
    return data;
  }

  private normalizeActorId(actorId: string | null): string | null {
    if (actorId === null) return null;
    if (UUID_PATTERN.test(actorId)) return actorId;
    this.logger.warn(`Transition actor id "${actorId}" is not a uuid; recording without an actor`);
    return null;
  }
}
