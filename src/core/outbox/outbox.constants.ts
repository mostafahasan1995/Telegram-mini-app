/**
 * WHY these numbers: the relay ticks every second and claims at most 100 rows, so one worker
 * sustains ~100 msg/s, which is two orders of magnitude above anything this cashier will ever see —
 * the batch cap exists to bound the transaction, not the throughput.
 *
 * MAX_PUBLISH_ATTEMPTS is about publishing to Redis, not about delivering the message. Once the job
 * is in BullMQ its own 8 attempts take over. A row that exhausts 8 publish attempts means Redis has
 * been unreachable for minutes; that is a human problem, so the row goes DEAD rather than spinning.
 */

export const OUTBOX_RELAY_INTERVAL_MS = 1_000;
export const OUTBOX_REAPER_INTERVAL_MS = 30_000;

export const OUTBOX_CLAIM_BATCH_SIZE = 100;

/** Publish attempts by the relay before a row is parked as DEAD. */
export const OUTBOX_MAX_PUBLISH_ATTEMPTS = 8;

/** First retry after ~2s, then 4s, 8s, ... capped. Mirrors the BullMQ job backoff on purpose. */
export const OUTBOX_PUBLISH_BACKOFF_BASE_MS = 2_000;
export const OUTBOX_PUBLISH_BACKOFF_MAX_MS = 5 * 60_000;

/**
 * A row is only IN_FLIGHT between the claim and the mark. Anything older than this belonged to a
 * process that died mid-publish, so the reaper takes it back. Must stay comfortably above the
 * worst-case Redis timeout or the reaper will race a live publisher — which is survivable (the
 * jobId dedupes) but produces confusing logs.
 */
export const OUTBOX_STALE_LOCK_MS = 60_000;

/**
 * Deterministic BullMQ job id. This is the mechanism that turns the outbox's at-least-once publish
 * into an effectively-once delivery: publishing the same row twice is a no-op for as long as the
 * job still exists in Redis (see DEFAULT_JOB_OPTIONS.removeOnComplete).
 */
export const OUTBOX_JOB_ID_PREFIX = 'outbox-';

export function outboxJobId(outboxId: string): string {
  return `${OUTBOX_JOB_ID_PREFIX}${outboxId}`;
}

/** Registered names so two @Interval declarations cannot collide in the SchedulerRegistry. */
export const OUTBOX_RELAY_INTERVAL_NAME = 'outbox-relay';
export const OUTBOX_REAPER_INTERVAL_NAME = 'outbox-reaper';

/** Written to last_error when the reaper takes a row back from a dead process. */
export const OUTBOX_RECLAIMED_ERROR = 'RECLAIMED_AFTER_STALE_LOCK';

/**
 * Exponential backoff with full jitter on the upper half of the window. Without the jitter, every
 * relay in the fleet retries the same backlog at the same millisecond after a Redis outage and
 * knocks it over again. `attempts` is the value already stored on the row (claim incremented it),
 * so the first failure waits ~1-2s rather than 0.
 */
export function publishBackoffMs(attempts: number, random: () => number = Math.random): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 20);
  const window = Math.min(
    OUTBOX_PUBLISH_BACKOFF_BASE_MS * 2 ** exponent,
    OUTBOX_PUBLISH_BACKOFF_MAX_MS,
  );
  const half = window / 2;
  return Math.floor(half + random() * half);
}
