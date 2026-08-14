/**
 * WHY: a ledger refusal is a business fact the caller has to branch on ("float is empty", "this
 * posting already exists"), not a string to show a human. Every rejection therefore carries a
 * STABLE code that survives translation, log scraping and API versioning, plus a `context` bag for
 * the incident channel. Nothing in this folder ever throws a bare Error.
 */

export type LedgerErrorCode =
  /** A posting with no entries at all. */
  | 'LEDGER_EMPTY_POSTING'
  /** Fewer than two entries: double entry needs two sides (mirrors the DB trigger). */
  | 'LEDGER_SINGLE_SIDED'
  /** The signed sum of the entries is not exactly zero. */
  | 'LEDGER_UNBALANCED'
  /** An entry names neither an accountId nor an accountCode, or names both. */
  | 'LEDGER_MISSING_ACCOUNT_REF'
  /** An entry moves 0 minor units; it is noise in an append-only table. */
  | 'LEDGER_ZERO_AMOUNT_ENTRY'
  /** The account code does not parse into a known kind/scope/currency triple. */
  | 'LEDGER_INVALID_ACCOUNT_CODE'
  /** A referenced account id does not exist. */
  | 'LEDGER_ACCOUNT_NOT_FOUND'
  /** The account exists but has been deactivated; postings to it are refused. */
  | 'LEDGER_ACCOUNT_INACTIVE'
  /** The account's currency differs from the posting currency. */
  | 'LEDGER_CURRENCY_MISMATCH'
  /** The posting would drive an account onto the wrong side of its normal balance. */
  | 'LEDGER_SIGN_VIOLATION'
  /** Same idempotency key, different posting body — a caller bug, never answered from cache. */
  | 'LEDGER_IDEMPOTENCY_KEY_REUSED'
  /** The idempotency row exists but points at no transaction (a crashed writer, or scope reuse). */
  | 'LEDGER_IDEMPOTENCY_IN_FLIGHT'
  /** The replayed transaction referenced by an idempotency row has vanished. */
  | 'LEDGER_REPLAY_TARGET_MISSING'
  /** reversal() was handed a transaction with no entries. */
  | 'LEDGER_NOTHING_TO_REVERSE'
  /** A caller passed a non-positive amount to a posting rule that requires a real movement. */
  | 'LEDGER_INVALID_AMOUNT'
  /** withSerializationRetry exhausted its attempts. */
  | 'LEDGER_RETRY_EXHAUSTED';

export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
    readonly context: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export const isLedgerError = (error: unknown): error is LedgerError => error instanceof LedgerError;
