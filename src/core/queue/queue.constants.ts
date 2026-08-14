/**
 * WHY: queue names are typed as a closed set because a typo in `queue.add('telgram', ...)` is a
 * message that is enqueued successfully, acknowledged, and never processed by anybody — the single
 * worst failure mode a queue has. Everything downstream (the task map, the processors, the health
 * checks) derives from this object.
 */
import type { JobsOptions } from 'bullmq';

export const QUEUE_NAMES = {
  /** Fed exclusively by the outbox relay; carries one job per committed outbox row. */
  OUTBOX: 'outbox',
  /** Every call that touches the agent API — credits, registrations, float sync. */
  ICHANCY: 'ichancy',
  /** Bot sends/edits. Kept apart so a Telegram rate limit cannot stall a money credit. */
  TELEGRAM: 'telegram',
  /** Proof image download, resize, hashing, OCR. CPU heavy, low urgency. */
  MEDIA: 'media',
  /** Scheduled reconciliation sweeps. */
  RECON: 'recon',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const ALL_QUEUE_NAMES: readonly QueueName[] = Object.freeze([
  QUEUE_NAMES.OUTBOX,
  QUEUE_NAMES.ICHANCY,
  QUEUE_NAMES.TELEGRAM,
  QUEUE_NAMES.MEDIA,
  QUEUE_NAMES.RECON,
]);

/**
 * Redis key prefix. Explicit so a second environment pointed at the same Redis (staging sharing a
 * dev box) cannot consume this one's jobs.
 */
export const BULLMQ_PREFIX = 'ichancy';

/**
 * Defaults every job inherits. 8 attempts with exponential backoff from 2s spans ~4 minutes of
 * retrying, which covers a Telegram 429 or an Ichancy blip without a human.
 *
 * removeOnComplete keeps an hour of history on purpose: BullMQ's duplicate-jobId protection only
 * works while the job still exists, and that is what makes the outbox's "publish twice, deliver
 * once" guarantee real.
 */
export const DEFAULT_JOB_ATTEMPTS = 8;
export const DEFAULT_JOB_BACKOFF_MS = 2_000;

export const DEFAULT_JOB_OPTIONS: JobsOptions = Object.freeze({
  attempts: DEFAULT_JOB_ATTEMPTS,
  backoff: { type: 'exponential', delay: DEFAULT_JOB_BACKOFF_MS },
  removeOnComplete: { age: 3_600, count: 5_000 },
  removeOnFail: { age: 7 * 24 * 3_600 },
});
