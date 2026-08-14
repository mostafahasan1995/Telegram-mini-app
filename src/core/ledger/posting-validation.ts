/**
 * WHY a pure validator separate from the repository: the zero-sum rule is the one invariant that
 * must be provable without a database. The DB has a DEFERRABLE constraint trigger as a last line of
 * defence (prisma/sql/001), but discovering an unbalanced posting at COMMIT means the error arrives
 * with no idea which rule produced it. Checking here names the posting while the stack is intact.
 *
 * These functions are total and side-effect free, which is what makes posting-validation.spec.ts
 * meaningful: the assertion that guards every money movement is tested without a container.
 */
import { sumMinor } from '@common/helpers/money.util';

import { LedgerError } from './ledger.errors';
import type { Posting, PostingEntry } from './ledger.types';

/** Minimum sides for double entry. Mirrors the `v_entry_count < 2` check in prisma/sql/001. */
export const MIN_POSTING_ENTRIES = 2;

/**
 * The heart of it: signed minor units must cancel exactly. bigint means there is no epsilon and no
 * "close enough" — either the posting balances or it is not a posting.
 */
export function assertZeroSum(entries: readonly PostingEntry[], currency: string): void {
  const total = sumMinor(entries.map((entry) => entry.amountMinor));
  if (total !== 0n) {
    throw new LedgerError(
      'LEDGER_UNBALANCED',
      `Entries sum to ${total.toString()} ${currency} minor units; a posting must sum to exactly 0`,
      { currency, sumMinor: total.toString(), entryCount: String(entries.length) },
    );
  }
}

/** Exactly one of accountId / accountCode, and a movement that actually moves something. */
export function assertEntryShape(entry: PostingEntry, index: number): void {
  const hasId = typeof entry.accountId === 'string' && entry.accountId.length > 0;
  const hasCode = typeof entry.accountCode === 'string' && entry.accountCode.length > 0;
  if (hasId === hasCode) {
    throw new LedgerError(
      'LEDGER_MISSING_ACCOUNT_REF',
      `Entry ${index} must name exactly one of accountId or accountCode`,
      { index: String(index) },
    );
  }
  if (entry.amountMinor === 0n) {
    throw new LedgerError(
      'LEDGER_ZERO_AMOUNT_ENTRY',
      `Entry ${index} moves 0 minor units; drop it instead of writing a no-op to an append-only table`,
      { index: String(index) },
    );
  }
}

/**
 * Full structural check of a posting, run before a single row is written or a single account locked.
 * Order matters: shape errors are reported before the sum, because an entry with no account is the
 * more likely cause of a caller's confusion than the arithmetic.
 */
export function assertValidPosting(posting: Posting): void {
  if (posting.entries.length === 0) {
    throw new LedgerError('LEDGER_EMPTY_POSTING', 'A posting must contain at least one entry', {
      idempotencyKey: posting.idempotencyKey,
    });
  }
  if (posting.entries.length < MIN_POSTING_ENTRIES) {
    throw new LedgerError(
      'LEDGER_SINGLE_SIDED',
      `A posting needs at least ${MIN_POSTING_ENTRIES} entries, got ${posting.entries.length}`,
      { idempotencyKey: posting.idempotencyKey },
    );
  }
  if (posting.idempotencyKey.length === 0) {
    throw new LedgerError(
      'LEDGER_MISSING_ACCOUNT_REF',
      'A posting must carry a non-empty idempotency key',
    );
  }
  posting.entries.forEach(assertEntryShape);
  assertZeroSum(posting.entries, posting.currency);
}

/**
 * Net movement per account. Two entries may legitimately touch the same account (a fee split, a
 * reversal folded into a correction), and the balance guard has to judge the account's END state,
 * not each entry in isolation.
 */
export function netByAccountRef(entries: readonly PostingEntry[]): Map<string, bigint> {
  const net = new Map<string, bigint>();
  for (const entry of entries) {
    const ref = entry.accountId ?? entry.accountCode ?? '';
    net.set(ref, (net.get(ref) ?? 0n) + entry.amountMinor);
  }
  return net;
}
