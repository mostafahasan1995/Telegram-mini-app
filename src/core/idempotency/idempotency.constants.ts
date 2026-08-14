/**
 * WHY a 24h TTL: an idempotency key only has to outlive the client's own retry budget. A mini-app
 * that lost its network retries for seconds, a support agent re-submitting a form retries for
 * minutes. A day is generous; a week would just be a bigger table to scan.
 *
 * WHY a stale-lock window at all: a request that crashed the process between "insert IN_FLIGHT" and
 * "complete" would otherwise wedge that key until it expires — the client would get 409 for 24
 * hours for a request that never ran. After the window the record can be stolen exactly once.
 */

/** Lower-cased because Node lower-cases incoming header names. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
/** Set on a replayed response so a client can tell a cached answer from a fresh one. */
export const IDEMPOTENCY_REPLAY_HEADER = 'idempotency-replayed';

export const IDEMPOTENT_METADATA = 'ichancy:idempotent';

export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** How long an IN_FLIGHT record is believed before another request may take it over. */
export const IDEMPOTENCY_STALE_LOCK_MS = 60_000;

/**
 * begin() re-reads after a lost race. Three rounds is enough for any real contention; more would
 * mean something is wrong that a retry cannot fix.
 */
export const IDEMPOTENCY_BEGIN_MAX_ROUNDS = 3;

export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;
/** Deliberately permissive: clients send UUIDs, ULIDs, or their own opaque tokens. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]+$/;

/**
 * Plain strings, not a Prisma enum: this is infrastructure state, not a domain concept, and the
 * column is a VarChar(16) precisely so it never shows up in a domain migration.
 */
export const IDEMPOTENCY_STATE = {
  IN_FLIGHT: 'IN_FLIGHT',
  COMPLETED: 'COMPLETED',
} as const;

export type IdempotencyState = (typeof IDEMPOTENCY_STATE)[keyof typeof IDEMPOTENCY_STATE];

/** Stable client-facing codes. Never reworded into the message. */
export const IdempotencyErrorCodes = {
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_KEY_INVALID: 'IDEMPOTENCY_KEY_INVALID',
  /** The same key is being processed right now. Retry later; do NOT change the body. */
  IDEMPOTENCY_IN_FLIGHT: 'IDEMPOTENCY_IN_FLIGHT',
  /** The same key was used for a DIFFERENT body. Always a client bug. */
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
} as const;

export const IDEMPOTENCY_REAPER_CRON_NAME = 'idempotency-reaper';
/** Deleting in bounded batches keeps the reaper off the lock manager's radar. */
export const IDEMPOTENCY_REAP_BATCH = 500;
export const IDEMPOTENCY_REAP_MAX_BATCHES = 20;
