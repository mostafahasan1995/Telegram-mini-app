/**
 * WHY: PostgreSQL can abort a perfectly correct transaction for reasons that have nothing to do
 * with our business rules — SERIALIZABLE conflicts (SQLSTATE 40001) and deadlocks (40P01). The
 * ledger writes touch the same few accounts from the API and from the credit worker at the same
 * time, so this WILL happen in production. The database's own answer to those two codes is
 * "retry the whole transaction", and that is all this helper does.
 *
 * Two rules make this safe rather than dangerous:
 *  1. Only 40001/40P01/P2034 are retried. A unique violation, a balance check, an HTTP failure —
 *     none of those are retried, ever.
 *  2. The retried unit MUST be the whole transaction callback, and it must contain no third-party
 *     IO (see the layering contract). Re-running a callback that already POSTed to Ichancy would
 *     double-credit a player.
 */
import { setTimeout as sleepMs } from 'node:timers/promises';

/** Prisma's "transaction failed due to a write conflict or a deadlock" code. */
export const PRISMA_WRITE_CONFLICT_CODE = 'P2034';
/** serialization_failure, deadlock_detected. */
export const RETRYABLE_SQL_STATES: ReadonlySet<string> = new Set(['40001', '40P01']);

const RETRYABLE_MESSAGE =
  /could not serialize access|deadlock detected|write conflict|40001|40P01/i;

export interface SerializationRetryOptions {
  /** Total attempts INCLUDING the first one. Default 5. */
  attempts?: number;
  /** First backoff step; doubles each attempt. Default 25ms. */
  baseDelayMs?: number;
  /** Ceiling for the exponential part. Default 500ms. */
  maxDelayMs?: number;
  /** Injectable for tests. Default Math.random. */
  random?: () => number;
  /** Injectable for tests. Default node:timers/promises setTimeout. */
  sleep?: (ms: number) => Promise<unknown>;
  /** Observability hook — the caller decides whether a retry deserves a log line. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

const DEFAULTS = {
  attempts: 5,
  baseDelayMs: 25,
  maxDelayMs: 500,
} as const;

/**
 * OBSERVED on Prisma 7 + @prisma/adapter-pg + PG17: a conflict raised inside a raw statement does
 * NOT arrive as P2034. It arrives as P2010 with the real SQLSTATE buried in
 * `meta.driverAdapterError.cause.originalCode` and `…cause.kind === 'TransactionWriteConflict'`.
 * Matching only on the Prisma code would silently disable every retry for raw SQL.
 */
const RETRYABLE_ADAPTER_KINDS: ReadonlySet<string> = new Set(['TransactionWriteConflict']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function readString(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' ? value : undefined;
}

function readRecord(
  source: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = source?.[key];
  return isRecord(value) ? value : undefined;
}

/**
 * Duck-typed on purpose. The same conflict reaches us in four different shapes depending on where
 * it is raised: as a Prisma P2034, as a raw `pg` error carrying the SQLSTATE in `code`, as a P2010
 * wrapping a driver-adapter error (see above), and — worst case — as a message we can only pattern
 * match. Recognising too much here is harmless (the operation is replayable by construction);
 * recognising too little means a lost transaction under load.
 */
export function isSerializationError(error: unknown): boolean {
  if (!isRecord(error)) return false;

  const code = readString(error, 'code');
  if (code === PRISMA_WRITE_CONFLICT_CODE) return true;
  if (code !== undefined && RETRYABLE_SQL_STATES.has(code)) return true;

  const meta = readRecord(error, 'meta');
  if (meta !== undefined) {
    const metaCode = readString(meta, 'code');
    if (metaCode !== undefined && RETRYABLE_SQL_STATES.has(metaCode)) return true;

    const dbCode = readString(readRecord(meta, 'dbError'), 'code');
    if (dbCode !== undefined && RETRYABLE_SQL_STATES.has(dbCode)) return true;

    const adapterCause = readRecord(readRecord(meta, 'driverAdapterError'), 'cause');
    if (adapterCause !== undefined) {
      const originalCode = readString(adapterCause, 'originalCode');
      if (originalCode !== undefined && RETRYABLE_SQL_STATES.has(originalCode)) return true;
      const kind = readString(adapterCause, 'kind');
      if (kind !== undefined && RETRYABLE_ADAPTER_KINDS.has(kind)) return true;
    }
  }

  const cause = error.cause;
  if (cause !== undefined && cause !== error && isSerializationError(cause)) return true;

  const message = readString(error, 'message');
  return message !== undefined && RETRYABLE_MESSAGE.test(message);
}

/**
 * Equal jitter: half the backoff is deterministic (so the delay actually grows), half is random
 * (so two workers that collided do not collide again in lockstep).
 */
function backoffFor(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  rand: number,
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(exponential / 2 + exponential * 0.5 * rand);
}

/**
 * Runs `fn` and retries it while PostgreSQL says the transaction lost a race.
 * The last error is rethrown untouched — callers still map P2002 & friends themselves.
 *
 * @param fn        receives the 1-based attempt number, mostly for logging/metrics.
 * @param options   a plain number is accepted as a shorthand for `{ attempts }`.
 */
export async function withSerializationRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: number | SerializationRetryOptions = {},
): Promise<T> {
  const opts: SerializationRetryOptions =
    typeof options === 'number' ? { attempts: options } : options;

  const attempts = opts.attempts ?? DEFAULTS.attempts;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new TypeError(
      `withSerializationRetry: attempts must be a positive integer, got ${attempts}`,
    );
  }

  const baseDelayMs = opts.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? ((ms: number) => sleepMs(ms));

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      // Not a race: fail now. Retrying a business error only hides it.
      if (!isSerializationError(error)) throw error;
      // Out of budget: the caller must decide (NEEDS_RECONCILIATION, 503, whatever).
      if (attempt === attempts) throw error;

      const delayMs = backoffFor(attempt, baseDelayMs, maxDelayMs, random());
      opts.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }

  // Unreachable: the loop either returns or throws. Kept so the function is total for tsc.
  throw lastError;
}
