/**
 * THE CREDIT WORKER. This is the sharpest edge in the product.
 *
 * The Ichancy API has no idempotency key, no transaction lookup, and no reference search. A timeout
 * on `depositToPlayer` is therefore genuinely UNKNOWN: the money may have moved. The only oracles we
 * have are `getPlayerBalanceById` and `getAgentAllWallets`. Everything below follows from that.
 *
 * ── THE PROTOCOL (spec section A) ─────────────────────────────────────────────────────────────
 *   1. read the player's balance                                  -> b0   (recorded on the row)
 *   2. POST depositToPlayer, comment = our shortId                        (the only breadcrumb a
 *                                                                          human can find in their
 *                                                                          panel)
 *   3. ok        -> post T2, status CREDITED, verifiedBy = API_OK
 *      rejected  -> NO ledger movement, status CREDIT_FAILED
 *      ambiguous -> wait, re-read the balance -> b1.
 *                   (b1 - b0) >= amount  -> it landed. CREDITED, verifiedBy = BALANCE_DELTA
 *                   otherwise            -> retry the POST **exactly once**, then re-verify
 *                   still unresolved     -> NEEDS_RECONCILIATION. A human opens their panel.
 *
 * ── WHY T2 IS POSTED ONLY ON CONFIRMED SUCCESS ────────────────────────────────────────────────
 * T2 (PLAYER_LIABILITY +A / ICHANCY_AGENT_FLOAT -A) is the statement "the player has their chips
 * and our float paid for them". We post it only when we have PROVEN that — an explicit ok, or a
 * balance delta that accounts for the full amount. An ambiguous outcome therefore needs NO
 * compensating entry: nothing was ever posted to compensate. The deposit sits in
 * NEEDS_RECONCILIATION with b0 recorded, and the ledger still says "we owe this player" — which is
 * exactly the truth while we do not know. Posting T2 optimistically and reversing it later would
 * mean the books briefly asserted something we could not support, and a reversal is visible forever.
 *
 * ── WHY THE PER-PLAYER MUTEX ──────────────────────────────────────────────────────────────────
 * The balance delta is only interpretable if NOTHING else moves that player's Ichancy balance while
 * we measure it. A second credit landing between b0 and b1 makes the delta look sufficient when our
 * own call failed — a double credit that verifies as a success. So the mutex is held across the
 * WHOLE window (call + wait + re-read + retry), extended rather than set long, and it is keyed on
 * the player ALONE. Putting creditKeyEpoch in the key (as the schema comment suggests) would let a
 * deliberate re-run execute concurrently with a first attempt and destroy the property the lock
 * exists for; staleness is handled separately, by re-reading the epoch from the row.
 *
 * ── WHY AGENT_FLOAT_INSUFFICIENT IS NOT RETRIED ───────────────────────────────────────────────
 * Retrying cannot succeed until a human tops up the agent wallet. A blind retry would burn the
 * BullMQ attempt budget, produce N identical alerts, and delay the deposit by the full backoff after
 * the float IS topped up. So it goes straight to CREDIT_FAILED with that code plus an operator
 * alert, and an operator re-runs it deliberately (which bumps creditKeyEpoch).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CreditVerifiedBy, DepositStatus, type DepositRequest } from '@prisma/client';

import { formatMinorToDecimal } from '@common/helpers/money.util';
import { SYSTEM_ACTOR } from '@common/types/actor.type';
import { AuditService } from '@core/audit/audit.service';
import { LockService, type LockHandle } from '@core/cache/lock.service';
import {
  ICHANCY_PORT,
  IchancyRejectionCodes,
  type IchancyPort,
  type IchancyResult,
  type PlayerMoveOutcome,
} from '@core/ichancy';
import {
  AccountRegistryService,
  ichancyAgentFloatCode,
  ichancyCredited,
  isLedgerError,
  LedgerService,
} from '@core/ledger';
import { OutboxService } from '@core/outbox/outbox.service';
import { PrismaService } from '@core/prisma/prisma.service';
import type { Tx } from '@core/prisma/tx.type';

import {
  BALANCE_VERIFY_DELAY_MS,
  BALANCE_VERIFY_RETRY_DELAY_MS,
  CREDIT_LOCK_EXTEND_MS,
  CREDIT_LOCK_RETRIES,
  CREDIT_LOCK_RETRY_DELAY_MS,
  CREDIT_LOCK_TTL_MS,
  DEPOSIT_AGGREGATE,
  DEPOSIT_TOPICS,
  playerCreditLockKey,
} from '../deposit.constants';
import { DepositStateMachine } from '../deposit-state.machine';
import { DepositErrorCodes } from '../enums/deposit-error-code.enum';
import { PLAYER_LINK_PORT, type PlayerLinkPort } from '../ports';

export interface CreditTask {
  depositRequestId: string;
  shortId: string;
  creditKeyEpoch: number;
  /** Decimal string of minor units, as it travelled on the queue. */
  amountMinor: string;
  correlationId?: string;
}

export type CreditOutcome =
  | { kind: 'credited'; verifiedBy: CreditVerifiedBy; ledgerTransactionId: string }
  | { kind: 'failed'; code: string; message: string }
  | { kind: 'needs_reconciliation'; cause: string }
  /** The deposit was not in a creditable state — a redelivery, a reversal, or a stale epoch. */
  | { kind: 'skipped'; reason: string };

/** Thrown to make BullMQ retry the whole job later. Never used for a decided outcome. */
export class CreditRetryLaterError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CreditRetryLaterError';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class DepositCreditService {
  private readonly logger = new Logger(DepositCreditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stateMachine: DepositStateMachine,
    private readonly ledger: LedgerService,
    private readonly accounts: AccountRegistryService,
    private readonly locks: LockService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    @Inject(ICHANCY_PORT) private readonly ichancy: IchancyPort,
    @Inject(PLAYER_LINK_PORT) private readonly playerLink: PlayerLinkPort,
  ) {}

  async credit(task: CreditTask): Promise<CreditOutcome> {
    const deposit = await this.prisma.depositRequest.findUnique({
      where: { id: task.depositRequestId },
    });
    if (deposit === null) return { kind: 'skipped', reason: 'DEPOSIT_NOT_FOUND' };

    // Stale-epoch guard. An operator who re-ran this deposit bumped the epoch; a job carrying the
    // old one belongs to an attempt that has been superseded and must not credit anything.
    if (deposit.creditKeyEpoch !== task.creditKeyEpoch) {
      this.logger.warn(
        `ignoring stale credit job for ${deposit.shortId} (job epoch ${task.creditKeyEpoch}, row ${deposit.creditKeyEpoch})`,
      );
      return { kind: 'skipped', reason: 'STALE_EPOCH' };
    }

    if (deposit.status === DepositStatus.CREDITED) {
      return { kind: 'skipped', reason: 'ALREADY_CREDITED' };
    }
    if (deposit.status !== DepositStatus.APPROVED && deposit.status !== DepositStatus.CREDITING) {
      return { kind: 'skipped', reason: `NOT_CREDITABLE_${deposit.status}` };
    }

    // The mutex spans the ENTIRE verify window — see the header.
    const lockKey = playerCreditLockKey(deposit.playerId);
    const handle = await this.locks.acquire(lockKey, CREDIT_LOCK_TTL_MS, {
      retries: CREDIT_LOCK_RETRIES,
      retryDelayMs: CREDIT_LOCK_RETRY_DELAY_MS,
    });
    if (handle === null) {
      throw new CreditRetryLaterError(`another credit is in flight for player ${deposit.playerId}`);
    }

    try {
      return await this.creditUnderLock(deposit, task, handle);
    } finally {
      await this.locks.release(handle).catch(() => false);
    }
  }

  // ---------------------------------------------------------------------------------------------

  private async creditUnderLock(
    approved: DepositRequest,
    task: CreditTask,
    handle: LockHandle,
  ): Promise<CreditOutcome> {
    const amountMinor = BigInt(task.amountMinor);

    // Refuse before we call anyone if our own books say the float cannot pay. The ledger's sign
    // guard would refuse T2 anyway — but only AFTER the player had already been credited, which is
    // the worst possible moment to find out.
    const shortfall = await this.floatShortfall(approved.currencyCode, amountMinor);
    if (shortfall !== null) {
      return this.finishFailed(approved, {
        code: DepositErrorCodes.AGENT_FLOAT_INSUFFICIENT,
        message: `Agent float is short by ${formatMinorToDecimal(shortfall)} ${approved.currencyCode}`,
        alert: true,
      });
    }

    // Owned by the player module and reached through a string token — see ../ports. It is idempotent
    // and it either returns a fully linked account or throws; there is no half-linked outcome to
    // handle here. A 503 (ambiguous) propagates and BullMQ retries the job, which is correct: the
    // login it would re-register with is deterministic, so the retry is a lookup.
    const link = await this.playerLink.ensureLinked(approved.playerId, task.correlationId ?? null);

    // APPROVED -> CREDITING. A redelivery finds it already CREDITING and continues under the lock,
    // which is safe: the previous holder is provably gone (we hold the mutex) and the protocol below
    // starts by MEASURING, not by moving money.
    const deposit =
      (await this.prisma.runInTransaction((tx) =>
        this.stateMachine.tryTransition(tx, {
          depositRequestId: approved.id,
          from: DepositStatus.APPROVED,
          to: DepositStatus.CREDITING,
          actor: SYSTEM_ACTOR,
          reason: 'Credit worker took the deposit',
          metadata: { creditKeyEpoch: task.creditKeyEpoch, ichancyPlayerId: link.ichancyPlayerId },
        }),
      )) ?? approved;

    // Counted separately from the transition: a redelivery that finds the row already CREDITING
    // still made a real attempt, and creditAttempts is what tells an operator how many times we
    // have talked to Ichancy about this deposit.
    await this.bumpAttempts(deposit.id);

    const context = {
      depositRequestId: approved.id,
      playerId: approved.playerId,
      ...(task.correlationId === undefined ? {} : { correlationId: task.correlationId }),
    };

    // ── 1. b0 ──────────────────────────────────────────────────────────────────────────────────
    const before = await this.ichancy.getPlayerBalance(link.ichancyPlayerId, context);
    if (before.kind !== 'ok') {
      // No baseline means no delta verification is possible, so we must not send the money at all.
      // This is a transient condition: retry the whole job rather than guess.
      throw new CreditRetryLaterError(
        `could not read a baseline balance for ${deposit.shortId}: ` +
          (before.kind === 'rejected' ? `${before.code} ${before.message}` : before.cause),
      );
    }
    const b0 = before.data.balanceMinor;
    await this.recordBaseline(deposit.id, b0);

    // ── 2. the call ────────────────────────────────────────────────────────────────────────────
    const first = await this.ichancy.creditPlayer({
      ichancyPlayerId: link.ichancyPlayerId,
      amountMinor,
      // The shortId IS the cross-reference; there is no other way to find this movement later.
      comment: deposit.shortId,
      context,
    });

    if (first.kind === 'ok') {
      return this.finishCredited(deposit, amountMinor, CreditVerifiedBy.API_OK, b0, null);
    }
    if (first.kind === 'rejected') {
      return this.handleRejection(deposit, first.code, first.message);
    }

    // ── 3. ambiguous: measure, then at most ONE retry ──────────────────────────────────────────
    this.logger.warn(`credit for ${deposit.shortId} was ambiguous: ${first.cause}`);

    const afterFirst = await this.verifyByDelta(
      deposit,
      link.ichancyPlayerId,
      handle,
      b0,
      amountMinor,
      BALANCE_VERIFY_DELAY_MS,
      context,
    );
    if (afterFirst.landed) {
      return this.finishCredited(
        deposit,
        amountMinor,
        CreditVerifiedBy.BALANCE_DELTA,
        b0,
        afterFirst.balanceMinor,
      );
    }

    // The delta says it did NOT land. Retry once — and only once. Every path out of here is
    // terminal, so no amount of redelivery can turn this into a third POST.
    this.logger.warn(`retrying credit for ${deposit.shortId} once (delta showed no movement)`);
    await this.bumpAttempts(deposit.id);

    const second = await this.ichancy.creditPlayer({
      ichancyPlayerId: link.ichancyPlayerId,
      amountMinor,
      comment: deposit.shortId,
      context,
    });

    if (second.kind === 'ok') {
      return this.finishCredited(deposit, amountMinor, CreditVerifiedBy.API_OK, b0, null);
    }
    if (second.kind === 'rejected') {
      return this.handleRejection(deposit, second.code, second.message);
    }

    const afterRetry = await this.verifyByDelta(
      deposit,
      link.ichancyPlayerId,
      handle,
      b0,
      amountMinor,
      BALANCE_VERIFY_RETRY_DELAY_MS,
      context,
    );
    if (afterRetry.landed) {
      return this.finishCredited(
        deposit,
        amountMinor,
        CreditVerifiedBy.BALANCE_DELTA,
        b0,
        afterRetry.balanceMinor,
      );
    }

    return this.finishNeedsReconciliation(deposit, {
      cause: second.cause,
      b0,
      b1: afterRetry.balanceMinor,
      amountMinor,
    });
  }

  /**
   * Wait, then re-read. The lock is EXTENDED first: if we have lost it, our measurement is
   * meaningless (someone else may be moving this player's balance) and continuing would be worse
   * than stopping.
   */
  private async verifyByDelta(
    deposit: DepositRequest,
    ichancyPlayerId: string,
    handle: LockHandle,
    b0: bigint,
    amountMinor: bigint,
    delayMs: number,
    context: { depositRequestId: string; playerId: string; correlationId?: string },
  ): Promise<{ landed: boolean; balanceMinor: bigint | null }> {
    await sleep(delayMs);

    const stillOurs = await this.locks.extend(handle, CREDIT_LOCK_EXTEND_MS);
    if (!stillOurs) {
      throw new CreditRetryLaterError(
        `lost the credit mutex for player ${deposit.playerId} mid-verification`,
      );
    }

    const after = await this.ichancy.getPlayerBalance(ichancyPlayerId, context);
    if (after.kind !== 'ok') {
      // We could not measure. That is not "it did not land" — leave the judgement to the caller,
      // which will either retry once or stop at NEEDS_RECONCILIATION.
      this.logger.warn(
        `balance re-read for ${deposit.shortId} failed: ` +
          (after.kind === 'rejected' ? after.message : after.cause),
      );
      return { landed: false, balanceMinor: null };
    }

    const b1 = after.data.balanceMinor;
    await this.recordAfterBalance(deposit.id, b1);

    // `>=` and not `===`: another movement (a bet settling, a bonus) may have landed in the same
    // window. A delta that covers our amount is evidence ours landed; a smaller one is not.
    const landed = b1 - b0 >= amountMinor;
    this.logger.log(
      `balance delta for ${deposit.shortId}: ${b0.toString()} -> ${b1.toString()} ` +
        `(expected +${amountMinor.toString()}) => ${landed ? 'LANDED' : 'NO MOVEMENT'}`,
    );
    return { landed, balanceMinor: b1 };
  }

  // ---------------------------------------------------------------------------------------------
  // TERMINAL STATES
  // ---------------------------------------------------------------------------------------------

  /** Confirmed success: post T2 and mark CREDITED, in one transaction, with no HTTP inside. */
  private async finishCredited(
    deposit: DepositRequest,
    amountMinor: bigint,
    verifiedBy: CreditVerifiedBy,
    b0: bigint,
    b1: bigint | null,
  ): Promise<CreditOutcome> {
    const now = new Date();

    try {
      return await this.prisma.runInTransaction(async (tx) => {
        const outcome = await this.stateMachine.transition(tx, {
          depositRequestId: deposit.id,
          from: DepositStatus.CREDITING,
          to: DepositStatus.CREDITED,
          actor: SYSTEM_ACTOR,
          reason: `Credited in Ichancy (${verifiedBy})`,
          metadata: {
            verifiedBy,
            balanceBeforeMinor: b0.toString(),
            balanceAfterMinor: b1?.toString() ?? null,
          },
          patch: {
            creditedAt: now,
            creditVerifiedBy: verifiedBy,
            balanceBeforeMinor: b0,
            ...(b1 === null ? {} : { balanceAfterMinor: b1 }),
          },
        });

        if (outcome.kind === 'alreadyHandled') {
          // Another worker got here first. T2 is idempotent by ledger key anyway, but writing it
          // twice would be a second attempt to claim a movement we no longer own.
          return { kind: 'skipped', reason: `ALREADY_${outcome.current ?? 'GONE'}` };
        }

        const posted = await this.ledger.post(
          tx,
          ichancyCredited({
            depositId: deposit.id,
            shortId: deposit.shortId,
            playerId: deposit.playerId,
            amountMinor,
            currency: deposit.currencyCode,
            actor: SYSTEM_ACTOR,
            occurredAt: now,
            verifiedBy,
          }),
        );

        await tx.depositRequest.update({
          where: { id: deposit.id },
          data: { ledgerCreditTxId: posted.transactionId },
        });

        await this.audit.write(tx, {
          action: 'deposit.credited',
          actor: SYSTEM_ACTOR,
          subjectType: DEPOSIT_AGGREGATE,
          subjectId: deposit.id,
          before: { status: DepositStatus.CREDITING },
          after: {
            status: DepositStatus.CREDITED,
            creditVerifiedBy: verifiedBy,
            ledgerCreditTxId: posted.transactionId,
          },
          amountMinor,
          metadata: {
            balanceBeforeMinor: b0.toString(),
            balanceAfterMinor: b1?.toString() ?? null,
          },
        });

        await this.notify(tx, deposit, 'deposit.credited', {
          shortId: deposit.shortId,
          amountMinor: amountMinor.toString(),
        });

        // Redraw the review card to its terminal "Credited" state (strips the keyboard), exactly
        // like the credit-failed and needs-reconciliation paths do.
        await this.outbox.enqueue(tx, {
          aggregateType: DEPOSIT_AGGREGATE,
          aggregateId: deposit.id,
          topic: DEPOSIT_TOPICS.CARD_UPDATE,
          payload: { depositRequestId: deposit.id, reason: 'credited' },
          dedupeKey: `${DEPOSIT_TOPICS.CARD_UPDATE}:${deposit.id}:credited:${deposit.creditKeyEpoch}`,
        });

        // The dedicated ops card for the admin group (float before/after, dual amounts). Committed
        // WITH T2 so it rides the same at-least-once outbox machinery as every other side effect —
        // never a direct send from inside money logic. The dedupe key carries no epoch on purpose:
        // like T2 itself, one deposit gets one ops card, forever.
        await this.outbox.enqueue(tx, {
          aggregateType: DEPOSIT_AGGREGATE,
          aggregateId: deposit.id,
          topic: DEPOSIT_TOPICS.OPS_CARD,
          payload: { depositRequestId: deposit.id, ledgerCreditTxId: posted.transactionId },
          dedupeKey: `${DEPOSIT_TOPICS.OPS_CARD}:${deposit.id}`,
        });

        this.logger.log(
          `deposit ${deposit.shortId} CREDITED (${verifiedBy}, T2 ${posted.transactionId})`,
        );
        return {
          kind: 'credited',
          verifiedBy,
          ledgerTransactionId: posted.transactionId,
        };
      });
    } catch (cause) {
      // The money IS with the player and our books cannot record it — almost always the agent float
      // sign guard. This must never look like a failed credit: it is a reconciliation break with a
      // known cause, and it needs a human now.
      if (isLedgerError(cause)) {
        this.logger.error(
          `T2 for ${deposit.shortId} was refused by the ledger AFTER a confirmed credit: ${cause.message}`,
        );
        return this.finishNeedsReconciliation(deposit, {
          cause: `LEDGER_REFUSED_T2:${cause.code}`,
          b0,
          b1,
          amountMinor,
          creditLanded: true,
        });
      }
      throw cause;
    }
  }

  /** A definite "no" from Ichancy. NO ledger movement — nothing was ever posted for T2. */
  private async handleRejection(
    deposit: DepositRequest,
    code: string,
    message: string,
  ): Promise<CreditOutcome> {
    const floatEmpty = code === IchancyRejectionCodes.INSUFFICIENT_AGENT_FLOAT;
    if (floatEmpty) {
      this.logger.error(
        `credit for ${deposit.shortId} refused: the AGENT FLOAT is empty. ` +
          `NOT retrying — an operator must top up the agent wallet first.`,
      );
    }
    return this.finishFailed(deposit, {
      code: floatEmpty ? DepositErrorCodes.AGENT_FLOAT_INSUFFICIENT : code,
      message,
      alert: floatEmpty,
    });
  }

  private async finishFailed(
    deposit: DepositRequest,
    failure: { code: string; message: string; alert: boolean },
  ): Promise<CreditOutcome> {
    await this.prisma.runInTransaction(async (tx) => {
      const outcome = await this.stateMachine.transition(tx, {
        depositRequestId: deposit.id,
        from: [DepositStatus.CREDITING, DepositStatus.APPROVED],
        to: DepositStatus.CREDIT_FAILED,
        actor: SYSTEM_ACTOR,
        reason: `Ichancy refused the credit: ${failure.code}`,
        metadata: { code: failure.code, message: failure.message },
      });
      if (outcome.kind === 'alreadyHandled') return;

      await this.audit.write(tx, {
        action: 'deposit.credit.failed',
        actor: SYSTEM_ACTOR,
        subjectType: DEPOSIT_AGGREGATE,
        subjectId: deposit.id,
        after: { status: DepositStatus.CREDIT_FAILED, code: failure.code },
        amountMinor: deposit.creditedAmountMinor ?? deposit.claimedAmountMinor,
        metadata: { message: failure.message },
      });

      await this.notify(tx, deposit, 'deposit.credit_failed', { shortId: deposit.shortId });
      await this.outbox.enqueue(tx, {
        aggregateType: DEPOSIT_AGGREGATE,
        aggregateId: deposit.id,
        topic: DEPOSIT_TOPICS.CARD_UPDATE,
        payload: { depositRequestId: deposit.id, reason: 'credit-failed' },
        dedupeKey: `${DEPOSIT_TOPICS.CARD_UPDATE}:${deposit.id}:credit-failed:${deposit.creditKeyEpoch}`,
      });

      if (failure.alert) {
        await this.outbox.enqueue(tx, {
          aggregateType: DEPOSIT_AGGREGATE,
          aggregateId: deposit.id,
          topic: DEPOSIT_TOPICS.ALERT,
          payload: {
            depositRequestId: deposit.id,
            shortId: deposit.shortId,
            severity: 'critical',
            code: failure.code,
            message: failure.message,
            hint: 'Top up the Ichancy agent wallet, then re-run this deposit from the admin panel.',
          },
          dedupeKey: `${DEPOSIT_TOPICS.ALERT}:${deposit.id}:${failure.code}:${deposit.creditKeyEpoch}`,
        });
      }
    });

    return { kind: 'failed', code: failure.code, message: failure.message };
  }

  /**
   * We do not know. b0 (and b1, if we got one) are on the row, so a human can reproduce our
   * reasoning against the Ichancy panel using the shortId as the search term.
   */
  private async finishNeedsReconciliation(
    deposit: DepositRequest,
    detail: {
      cause: string;
      b0: bigint;
      b1: bigint | null;
      amountMinor: bigint;
      creditLanded?: boolean;
    },
  ): Promise<CreditOutcome> {
    await this.prisma.runInTransaction(async (tx) => {
      const outcome = await this.stateMachine.transition(tx, {
        depositRequestId: deposit.id,
        from: DepositStatus.CREDITING,
        to: DepositStatus.NEEDS_RECONCILIATION,
        actor: SYSTEM_ACTOR,
        reason: `Unresolved credit outcome: ${detail.cause}`,
        metadata: {
          cause: detail.cause,
          balanceBeforeMinor: detail.b0.toString(),
          balanceAfterMinor: detail.b1?.toString() ?? null,
          expectedDeltaMinor: detail.amountMinor.toString(),
          creditLanded: detail.creditLanded ?? null,
        },
        patch: {
          balanceBeforeMinor: detail.b0,
          ...(detail.b1 === null ? {} : { balanceAfterMinor: detail.b1 }),
        },
      });
      if (outcome.kind === 'alreadyHandled') return;

      await this.audit.write(tx, {
        action: 'deposit.credit.unresolved',
        actor: SYSTEM_ACTOR,
        subjectType: DEPOSIT_AGGREGATE,
        subjectId: deposit.id,
        after: { status: DepositStatus.NEEDS_RECONCILIATION },
        amountMinor: detail.amountMinor,
        metadata: {
          cause: detail.cause,
          balanceBeforeMinor: detail.b0.toString(),
          balanceAfterMinor: detail.b1?.toString() ?? null,
        },
      });

      await this.outbox.enqueueMany(tx, [
        {
          aggregateType: DEPOSIT_AGGREGATE,
          aggregateId: deposit.id,
          topic: DEPOSIT_TOPICS.ALERT,
          payload: {
            depositRequestId: deposit.id,
            shortId: deposit.shortId,
            severity: 'critical',
            code: 'CREDIT_UNRESOLVED',
            message:
              `Credit outcome unknown for ${deposit.shortId}. ` +
              `Balance ${detail.b0.toString()} -> ${detail.b1?.toString() ?? 'unread'}, ` +
              `expected +${detail.amountMinor.toString()}.`,
            hint: `Search the Ichancy panel for comment "${deposit.shortId}" before re-running.`,
          },
          dedupeKey: `${DEPOSIT_TOPICS.ALERT}:${deposit.id}:unresolved:${deposit.creditKeyEpoch}`,
        },
        {
          aggregateType: DEPOSIT_AGGREGATE,
          aggregateId: deposit.id,
          topic: DEPOSIT_TOPICS.CARD_UPDATE,
          payload: { depositRequestId: deposit.id, reason: 'needs-reconciliation' },
          dedupeKey: `${DEPOSIT_TOPICS.CARD_UPDATE}:${deposit.id}:unresolved:${deposit.creditKeyEpoch}`,
        },
      ]);
    });

    return { kind: 'needs_reconciliation', cause: detail.cause };
  }

  // ---------------------------------------------------------------------------------------------
  // SMALL WRITES
  // ---------------------------------------------------------------------------------------------

  /** How short the float is, or null when it can cover the amount. Read from the entries. */
  private async floatShortfall(currencyCode: string, amountMinor: bigint): Promise<bigint | null> {
    const account = await this.accounts.findByCode(
      this.prisma,
      ichancyAgentFloatCode(currencyCode),
    );
    // No account yet means no float has ever been recorded; the sign guard will refuse T2 anyway,
    // and refusing here would block the very first credit of a fresh deployment before a top-up.
    if (account === null) return null;

    const balance = await this.accounts.computeBalanceFromEntries(this.prisma, account.id);
    return balance >= amountMinor ? null : amountMinor - balance;
  }

  private async recordBaseline(depositRequestId: string, b0: bigint): Promise<void> {
    await this.prisma.depositRequest.update({
      where: { id: depositRequestId },
      data: { balanceBeforeMinor: b0 },
    });
  }

  private async recordAfterBalance(depositRequestId: string, b1: bigint): Promise<void> {
    await this.prisma.depositRequest.update({
      where: { id: depositRequestId },
      data: { balanceAfterMinor: b1 },
    });
  }

  private async bumpAttempts(depositRequestId: string): Promise<void> {
    await this.prisma.depositRequest.update({
      where: { id: depositRequestId },
      data: { creditAttempts: { increment: 1 } },
    });
  }

  private async notify(
    tx: Tx,
    deposit: DepositRequest,
    template: string,
    params: Record<string, string>,
  ): Promise<void> {
    await this.outbox.enqueue(tx, {
      aggregateType: DEPOSIT_AGGREGATE,
      aggregateId: deposit.id,
      topic: DEPOSIT_TOPICS.NOTIFY_PLAYER,
      payload: {
        depositRequestId: deposit.id,
        playerId: deposit.playerId,
        template,
        params,
      },
      dedupeKey: `${DEPOSIT_TOPICS.NOTIFY_PLAYER}:${deposit.id}:${template}:${deposit.creditKeyEpoch}`,
    });
  }
}

/** Re-exported so the processor can narrow an Ichancy answer without importing the core barrel. */
export type PlayerMoveResult = IchancyResult<PlayerMoveOutcome>;
