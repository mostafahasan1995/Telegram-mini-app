/**
 * WHY: this is the only sanctioned way to put work on a queue. It exists so that the queue a task
 * runs on is decided once (TASK_QUEUE) instead of at every call site, and so the payload type is
 * checked against the task name — `add('media.proof.process', { depositRequestId })` must not
 * compile.
 *
 * It deliberately does NOT take a Tx. Enqueuing is a side effect and side effects are registered
 * through the outbox, inside the transaction that caused them; the relay is what calls this. The
 * only other legitimate callers are schedulers and processors, which are already outside any
 * business transaction.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Job, JobsOptions, Queue } from 'bullmq';

import { DEFAULT_JOB_OPTIONS, QUEUE_NAMES, type QueueName } from './queue.constants';
import { TASK_QUEUE, type AnyTaskPayload, type TaskName, type TaskPayload } from './queue.types';

/** Every queue carries the union of payloads; the narrow pairing is enforced by `add` below. */
type TaskQueue = Queue<AnyTaskPayload, unknown, TaskName>;
export type TaskJob = Job<AnyTaskPayload, unknown, TaskName>;

export interface BulkTaskEntry<N extends TaskName> {
  payload: TaskPayload<N>;
  options?: JobsOptions;
}

@Injectable()
export class TypedQueueService {
  private readonly logger = new Logger(TypedQueueService.name);
  private readonly queues: Readonly<Record<QueueName, TaskQueue>>;

  constructor(
    @InjectQueue(QUEUE_NAMES.OUTBOX) outbox: TaskQueue,
    @InjectQueue(QUEUE_NAMES.ICHANCY) ichancy: TaskQueue,
    @InjectQueue(QUEUE_NAMES.TELEGRAM) telegram: TaskQueue,
    @InjectQueue(QUEUE_NAMES.MEDIA) media: TaskQueue,
    @InjectQueue(QUEUE_NAMES.RECON) recon: TaskQueue,
  ) {
    this.queues = Object.freeze({
      [QUEUE_NAMES.OUTBOX]: outbox,
      [QUEUE_NAMES.ICHANCY]: ichancy,
      [QUEUE_NAMES.TELEGRAM]: telegram,
      [QUEUE_NAMES.MEDIA]: media,
      [QUEUE_NAMES.RECON]: recon,
    });
  }

  /** Escape hatch for queue administration (drain, pause, counts). Not for producing jobs. */
  queueFor(name: QueueName): TaskQueue {
    return this.queues[name];
  }

  queueNameFor(task: TaskName): QueueName {
    return TASK_QUEUE[task];
  }

  async add<N extends TaskName>(
    name: N,
    payload: TaskPayload<N>,
    options?: JobsOptions,
  ): Promise<TaskJob> {
    const queue = this.queues[TASK_QUEUE[name]];
    return queue.add(name, payload, { ...DEFAULT_JOB_OPTIONS, ...options });
  }

  /**
   * One round trip for a batch of the same task. Used by the outbox relay, which claims up to 100
   * rows per tick and must not pay 100 Redis round trips for them.
   *
   * All-or-nothing from the caller's point of view: if this rejects, treat every entry as
   * unpublished and let the retry path run. That is safe precisely because callers set a
   * deterministic `jobId`, so a re-publish of an entry that did land is dropped by BullMQ.
   */
  async addBulk<N extends TaskName>(
    name: N,
    entries: readonly BulkTaskEntry<N>[],
  ): Promise<TaskJob[]> {
    if (entries.length === 0) return [];
    const queue = this.queues[TASK_QUEUE[name]];
    return queue.addBulk(
      entries.map((entry) => ({
        name,
        data: entry.payload,
        opts: { ...DEFAULT_JOB_OPTIONS, ...entry.options },
      })),
    );
  }

  /** Snapshot for health endpoints and the admin panel. */
  async counts(name: QueueName): Promise<Record<string, number>> {
    return this.queues[name].getJobCounts();
  }

  /**
   * Removes a repeatable/delayed job by its deterministic id. Used when a deposit is reversed and a
   * queued credit must not run any more.
   */
  async remove(task: TaskName, jobId: string): Promise<boolean> {
    const queue = this.queues[TASK_QUEUE[task]];
    const job = await queue.getJob(jobId);
    if (!job) return false;
    try {
      await job.remove();
      return true;
    } catch (cause) {
      // A job that is already active cannot be removed; that is a legitimate race, not an error.
      this.logger.warn(
        `Could not remove job ${jobId}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return false;
    }
  }
}
