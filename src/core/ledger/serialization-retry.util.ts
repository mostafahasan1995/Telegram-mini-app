/**
 * WHY: taking row locks in a sorted order removes deadlocks between well-behaved writers, but it
 * cannot remove them entirely — an unrelated statement elsewhere, a caller that raised the isolation
 * level, or a lock taken by a future migration can still abort our transaction. Those aborts are not
 * failures: the correct response is to run the whole transaction again, because nothing it wrote
 * survived.
 *
 * The retry MUST wrap the transaction, never live inside it. Once PostgreSQL raises 40001 the
 * transaction is dead and every subsequent statement on it fails, so retrying a step in place is a
 * guaranteed second error.
 *
 * Only these two conditions are retried. A unique-violation or a LedgerError is a real answer and
 * re-running it would just produce the same answer more slowly.
 */
import { LedgerError } from './ledger.errors';

/** 40001 serialization_failure, 40P01 deadlock_detected. */
const RETRYABLE_PG_CODES = new Set(['40001', '40P01']);
/** P2034: "Transaction failed due to a write conflict or a deadlock." */
const RETRYABLE_PRISMA_CODES = new Set(['P2034']);
const RETRYABLE_MESSAGE_RE =
  /could not serialize access|deadlock detected|write conflict|40001|40P01/i;

export interface SerializationRetryOptions {
  /** Total attempts, including the first. */
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly onRetry?: (attempt: number, error: unknown) => void;
  /** Injectable for tests, so a retry suite does not actually wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Prisma surfaces the driver error differently depending on whether the failure came from the query
 * engine or the pg driver adapter, so all the plausible carriers are checked rather than trusting
 * one shape.
 */
export function isRetryableTransactionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    code?: unknown;
    meta?: { code?: unknown } | null;
    message?: unknown;
  };

  if (typeof candidate.code === 'string') {
    if (RETRYABLE_PRISMA_CODES.has(candidate.code)) return true;
    if (RETRYABLE_PG_CODES.has(candidate.code)) return true;
  }
  const metaCode = candidate.meta?.code;
  if (typeof metaCode === 'string' && RETRYABLE_PG_CODES.has(metaCode)) return true;

  return typeof candidate.message === 'string' && RETRYABLE_MESSAGE_RE.test(candidate.message);
}

/**
 * Run `work` until it succeeds or stops being retryable. Full-jitter backoff: two workers that
 * collided once must not collide again in lockstep.
 */
export async function withSerializationRetry<T>(
  work: (attempt: number) => Promise<T>,
  options: SerializationRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 25;
  const maxDelayMs = options.maxDelayMs ?? 500;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await work(attempt);
    } catch (error) {
      if (!isRetryableTransactionError(error)) throw error;
      lastError = error;
      if (attempt === maxAttempts) break;
      options.onRetry?.(attempt, error);
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await sleep(Math.floor(Math.random() * ceiling));
    }
  }

  throw new LedgerError(
    'LEDGER_RETRY_EXHAUSTED',
    `Transaction still conflicting after ${maxAttempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    { maxAttempts: String(maxAttempts) },
  );
}
