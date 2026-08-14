/**
 * WHY pure functions: these four rules ARE the business model. Keeping them free of Prisma, Nest and
 * IO means the question "what does approving a deposit do to our books?" is answered by reading one
 * function and one unit test, not by running a container.
 *
 * ── SIGN CONVENTION ─────────────────────────────────────────────────────────────────────────────
 * A ledger entry is signed minor units: POSITIVE = debit, NEGATIVE = credit. Every posting's entries
 * sum to exactly 0n.
 *
 *   ASSETS rest positive.      Things we have or are owed: RAIL_CLEARING, HOUSE_CASH,
 *                              ICHANCY_AGENT_FLOAT, CASINO_MIRROR.
 *   LIABILITIES rest negative. Things we owe: PLAYER_LIABILITY, SUSPENSE_UNIDENTIFIED.
 *
 * So "+A to an asset" means we gained A, and "-A to a liability" means we now owe A more. A player
 * who has paid us but has not been credited yet shows as PLAYER_LIABILITY = -A: money we are holding
 * that is not ours.
 *
 * ── THE MONEY'S JOURNEY ─────────────────────────────────────────────────────────────────────────
 *   T1 depositApproved   RAIL_CLEARING       +A     we believe A is on its way to us
 *                        PLAYER_LIABILITY    -A     …and we owe the player A
 *   T2 ichancyCredited   PLAYER_LIABILITY    +A     debt discharged, the player has their chips
 *                        ICHANCY_AGENT_FLOAT -A     paid for out of our finite float
 *      railSettled       HOUSE_CASH          +A     the bank statement confirmed it
 *                        RAIL_CLEARING       -A     …so it is no longer in transit
 *      reversal          every entry negated        the original is never edited
 *
 * Note T1 and T2 are two SEPARATE transactions posted at different times: T1 when an admin approves,
 * T2 only once Ichancy has actually confirmed the credit. Between them the player's liability sits
 * open, which is exactly the number the reconciliation job reports as "owed but not credited".
 */
import { LedgerTxKind } from '@prisma/client';

import type { Actor } from '@common/types/actor.type';
import { assertPositive } from '@common/helpers/money.util';

import {
  houseCashCode,
  ichancyAgentFloatCode,
  playerLiabilityCode,
  railClearingCode,
} from './account-codes';
import { LedgerError } from './ledger.errors';
import type { Posting, PostingEntry } from './ledger.types';

function requirePositive(amountMinor: bigint, label: string): bigint {
  if (amountMinor <= 0n) {
    throw new LedgerError(
      'LEDGER_INVALID_AMOUNT',
      `${label} must be greater than zero, got ${amountMinor.toString()}`,
      { amountMinor: amountMinor.toString() },
    );
  }
  return assertPositive(amountMinor, label);
}

export interface DepositApprovedInput {
  readonly depositId: string;
  /** Crockford short id — also the Ichancy `comment`, so a human can join our books to their panel. */
  readonly shortId: string;
  readonly playerId: string;
  readonly paymentMethodId: string;
  /** What we actually accepted (verified amount minus fee), never the raw claim. */
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly actor: Actor;
  readonly occurredAt?: Date;
}

/**
 * T1 — an admin approved the claim. We now believe money is coming in on a rail, and we owe the
 * player that much. Nothing has been sent to Ichancy yet.
 *
 * The idempotency key deliberately omits any attempt counter: there is exactly one claim posting per
 * deposit for all time, which prisma/sql/004 also enforces with a partial unique index.
 */
export function depositApproved(input: DepositApprovedInput): Posting {
  const amount = requirePositive(input.amountMinor, 'deposit amount');
  const entries: PostingEntry[] = [
    {
      accountCode: railClearingCode(input.paymentMethodId, input.currency),
      amountMinor: amount,
      memo: `Claim ${input.shortId} in transit`,
    },
    {
      accountCode: playerLiabilityCode(input.playerId, input.currency),
      amountMinor: -amount,
      memo: `Owed to player for ${input.shortId}`,
    },
  ];

  return {
    idempotencyKey: `ledger:deposit:${input.depositId}:claim`,
    kind: LedgerTxKind.DEPOSIT_CLAIM,
    refType: 'DEPOSIT',
    refId: input.depositId,
    currency: input.currency,
    entries,
    description: `Deposit ${input.shortId} approved`,
    actor: input.actor,
    occurredAt: input.occurredAt,
    externalRef: input.shortId,
    metadata: { shortId: input.shortId, playerId: input.playerId },
  };
}

export interface IchancyCreditedInput {
  readonly depositId: string;
  readonly shortId: string;
  readonly playerId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly actor: Actor;
  readonly occurredAt?: Date;
  /** API_OK or BALANCE_DELTA — how we became convinced the credit landed. Recorded for audit. */
  readonly verifiedBy?: string;
  /** ichancy_calls.id of the call that proved it, so a break can be traced back to one attempt. */
  readonly ichancyCallId?: string;
}

/**
 * T2 — Ichancy confirmed the credit. Our debt to the player is discharged and our finite agent float
 * pays for it. If the float cannot cover the amount the repository refuses the posting outright
 * (ICHANCY_AGENT_FLOAT is NON_NEGATIVE), which is the ledger telling us what the API would have told
 * us a second later, only without the ambiguity.
 *
 * The key carries no creditKeyEpoch on purpose: bumping the epoch re-runs the Ichancy CALL, it never
 * authorises a second ledger credit. One deposit, one T2, forever.
 */
export function ichancyCredited(input: IchancyCreditedInput): Posting {
  const amount = requirePositive(input.amountMinor, 'credit amount');
  const entries: PostingEntry[] = [
    {
      accountCode: playerLiabilityCode(input.playerId, input.currency),
      amountMinor: amount,
      memo: `Credited ${input.shortId} to Ichancy`,
    },
    {
      accountCode: ichancyAgentFloatCode(input.currency),
      amountMinor: -amount,
      memo: `Agent float paid ${input.shortId}`,
    },
  ];

  return {
    idempotencyKey: `ledger:deposit:${input.depositId}:credit`,
    kind: LedgerTxKind.DEPOSIT_CREDIT,
    refType: 'DEPOSIT',
    refId: input.depositId,
    currency: input.currency,
    entries,
    description: `Deposit ${input.shortId} credited in Ichancy`,
    actor: input.actor,
    occurredAt: input.occurredAt,
    externalRef: input.shortId,
    metadata: {
      shortId: input.shortId,
      playerId: input.playerId,
      verifiedBy: input.verifiedBy ?? null,
      ichancyCallId: input.ichancyCallId ?? null,
    },
  };
}

export interface RailSettledInput {
  /** Statement line / batch id. It is the natural key, so re-importing a statement is harmless. */
  readonly settlementId: string;
  readonly paymentMethodId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly actor: Actor;
  readonly occurredAt?: Date;
  readonly externalRef?: string;
  /**
   * LedgerTxKind has no RAIL_SETTLEMENT member (see README deviations), so this defaults to
   * MANUAL_ADJUSTMENT and is overridable rather than silently mislabelling the movement.
   */
  readonly kind?: LedgerTxKind;
}

/**
 * The rail actually paid out: money stops being "in transit" and becomes our confirmed cash. This is
 * independent of whether the player was credited — T2 and settlement happen on different clocks, and
 * conflating them is how a clearing account quietly becomes a fiction.
 */
export function railSettled(input: RailSettledInput): Posting {
  const amount = requirePositive(input.amountMinor, 'settlement amount');
  const entries: PostingEntry[] = [
    {
      accountCode: houseCashCode(input.paymentMethodId, input.currency),
      amountMinor: amount,
      memo: `Rail settlement ${input.settlementId}`,
    },
    {
      accountCode: railClearingCode(input.paymentMethodId, input.currency),
      amountMinor: -amount,
      memo: `Cleared ${input.settlementId}`,
    },
  ];

  return {
    idempotencyKey: `ledger:rail-settlement:${input.settlementId}`,
    kind: input.kind ?? LedgerTxKind.MANUAL_ADJUSTMENT,
    refType: 'RAIL_SETTLEMENT',
    refId: input.settlementId,
    currency: input.currency,
    entries,
    description: `Rail settlement ${input.settlementId}`,
    actor: input.actor,
    occurredAt: input.occurredAt,
    externalRef: input.externalRef ?? input.settlementId,
    metadata: { settlementId: input.settlementId, paymentMethodId: input.paymentMethodId },
  };
}

/** The minimum an already-posted transaction must expose to be reversible. */
export interface ReversibleTransaction {
  readonly id: string;
  readonly kind: LedgerTxKind;
  readonly currencyCode: string;
  readonly entries: readonly {
    readonly ledgerAccountId: string;
    readonly amountMinor: bigint;
    readonly sequence: number;
    readonly memo?: string | null;
  }[];
}

export interface ReversalInput {
  readonly transaction: ReversibleTransaction;
  readonly actor: Actor;
  /** Free text that ends up on the transaction; say WHY, the amounts are already visible. */
  readonly reason: string;
  readonly occurredAt?: Date;
  readonly kind?: LedgerTxKind;
  readonly allowNegative?: boolean;
}

/**
 * Compensate a transaction by posting its mirror image. The original is never touched — the ledger
 * tables reject UPDATE and DELETE outright (prisma/sql/002), so this is the only correction that
 * exists.
 *
 * Two defaults worth knowing:
 *  - kind defaults to DEPOSIT_REVERSAL, never the original kind. Reusing DEPOSIT_CREDIT would hit the
 *    partial unique index "one credit per deposit" and fail for a confusing reason.
 *  - allowNegative defaults to TRUE. A correction that a sign guard can block is a correction that
 *    might be impossible exactly when it is needed — e.g. reversing a claim whose rail already
 *    settled would drive RAIL_CLEARING below zero. A wrong posting must always be undoable.
 */
export function reversal(input: ReversalInput): Posting {
  const { transaction } = input;
  if (transaction.entries.length === 0) {
    throw new LedgerError(
      'LEDGER_NOTHING_TO_REVERSE',
      `Transaction ${transaction.id} has no entries to reverse`,
      { transactionId: transaction.id },
    );
  }

  const ordered = [...transaction.entries].sort((a, b) => a.sequence - b.sequence);
  const entries: PostingEntry[] = ordered.map((entry) => ({
    accountId: entry.ledgerAccountId,
    amountMinor: -entry.amountMinor,
    memo: `Reversal of ${transaction.id}`,
  }));

  return {
    idempotencyKey: `ledger:reversal:${transaction.id}`,
    kind: input.kind ?? LedgerTxKind.DEPOSIT_REVERSAL,
    refType: 'REVERSAL',
    refId: transaction.id,
    currency: transaction.currencyCode,
    entries,
    description: `Reversal of ${transaction.kind} ${transaction.id}: ${input.reason}`,
    actor: input.actor,
    occurredAt: input.occurredAt,
    reversesTxId: transaction.id,
    allowNegative: input.allowNegative ?? true,
    metadata: { reversedTransactionId: transaction.id, reason: input.reason },
  };
}
