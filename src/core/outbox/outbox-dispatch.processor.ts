/**
 * WHY the outbox has exactly ONE consumer: the relay publishes rows whose only routing information
 * is a topic string. If every feature module attached its own Worker to the `outbox` queue they
 * would compete for the same jobs and each message would reach a random one of them. So the queue
 * is drained here and fanned out to handlers registered under OUTBOX_HANDLERS.
 *
 * A message with no handler FAILS loudly rather than being acknowledged. Silently dropping an
 * unroutable side effect is the exact failure the outbox exists to make impossible; a job that
 * retries and lands in the failed set is visible in Redis and in the health counters.
 *
 * Handlers MUST be idempotent: delivery is at-least-once, a BullMQ retry re-runs every handler for
 * that message, and the relay itself may re-publish a row whose owner died before marking it SENT.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import { ActorContextService } from '@core/actor-context/actor-context.service';
import { QUEUE_NAMES } from '@core/queue/queue.constants';
import { isJsonObject } from '@core/queue/json.util';
import type { OutboxDispatchTask } from '@core/queue/queue.types';
import { OUTBOX_HANDLERS, type OutboxMessageView, type OutboxTopicHandler } from './outbox.types';

export class NoOutboxHandlerError extends Error {
  readonly code = 'OUTBOX_NO_HANDLER';

  constructor(readonly topic: string) {
    super(`No outbox handler is registered for topic "${topic}"`);
    this.name = 'NoOutboxHandlerError';
  }
}

/** Concurrency is modest on purpose: handlers do IO to Telegram and Ichancy, both rate limited. */
const OUTBOX_WORKER_CONCURRENCY = 8;

@Injectable()
@Processor(QUEUE_NAMES.OUTBOX, { concurrency: OUTBOX_WORKER_CONCURRENCY })
export class OutboxDispatchProcessor extends WorkerHost {
  private readonly logger = new Logger(OutboxDispatchProcessor.name);
  private readonly handlers: readonly OutboxTopicHandler[];

  // NOT @Optional(): OutboxModule.forWorker() always binds the token in this module's injector,
  // and a composition that somehow loses it must fail AT BOOT — an optional inject once degraded
  // to an empty table here and every outbox job died with OUTBOX_NO_HANDLER while boot looked green.
  constructor(
    private readonly actorContext: ActorContextService,
    @Inject(OUTBOX_HANDLERS) handlers: readonly OutboxTopicHandler[],
  ) {
    super();
    this.handlers = handlers;
  }

  override async process(job: Job<OutboxDispatchTask, unknown, string>): Promise<void> {
    const message: OutboxMessageView = {
      outboxId: job.data.outboxId,
      aggregateType: job.data.aggregateType,
      aggregateId: job.data.aggregateId,
      topic: job.data.topic,
      payload: job.data.payload,
      attempt: job.data.attempt,
    };

    const matched = this.resolve(message.topic);
    if (matched.length === 0) throw new NoOutboxHandlerError(message.topic);

    // A job has no request to inherit an actor from, and a handler that writes an audit row outside
    // a context produces one with a null correlationId — i.e. an effect nobody can trace back to the
    // request that caused it. Reusing the producer's correlationId (when it put one in the payload)
    // stitches the whole causal chain together; the outbox row id is the fallback, and is at least
    // stable across every retry of this message.
    await this.actorContext.runAsSystem(
      () => this.dispatch(matched, message),
      this.correlationIdFor(message),
    );
  }

  private async dispatch(
    handlers: readonly OutboxTopicHandler[],
    message: OutboxMessageView,
  ): Promise<void> {
    for (const handler of handlers) {
      await handler.handle(message);
    }
  }

  private correlationIdFor(message: OutboxMessageView): string {
    const fromPayload = isJsonObject(message.payload) ? message.payload.correlationId : undefined;
    return typeof fromPayload === 'string' && fromPayload.length > 0
      ? fromPayload
      : message.outboxId;
  }

  /**
   * Exact topics win outright; a prefix subscription ("telegram.*") only applies when nothing
   * claimed the topic by name, so adding a specific handler cannot accidentally double-deliver to
   * the catch-all that used to serve it.
   */
  private resolve(topic: string): OutboxTopicHandler[] {
    const exact = this.handlers.filter((handler) => handler.topic === topic);
    if (exact.length > 0) return exact;
    return this.handlers.filter(
      (handler) => handler.topic.endsWith('*') && topic.startsWith(handler.topic.slice(0, -1)),
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<OutboxDispatchTask, unknown, string> | undefined, error: Error): void {
    this.logger.error(
      `Outbox job ${job?.id ?? '<unknown>'} (topic ${job?.data?.topic ?? '<unknown>'}) failed on attempt ${
        job?.attemptsMade ?? 0
      }: ${error.message}`,
    );
  }
}
