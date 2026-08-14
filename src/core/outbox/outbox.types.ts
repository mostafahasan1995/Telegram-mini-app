/**
 * WHY a topic string rather than a class-per-event: the relay must be able to publish a row that
 * was written by a version of the code that no longer exists. A topic plus a JSON payload survives
 * a deploy; a deserialized class does not.
 */
import type { Prisma } from '@prisma/client';
import type { JsonObject } from '@core/queue/json.util';

export interface OutboxEnqueueInput {
  /** What the event is about, e.g. "DepositRequest". Used for forensic grouping, not routing. */
  aggregateType: string;
  aggregateId: string;
  /** Routing key the dispatch processor matches on, e.g. "deposit.credit.requested". */
  topic: string;
  payload: Record<string, unknown>;
  /**
   * Natural key of the event. With it, a retried business transaction cannot enqueue the same side
   * effect twice: the second insert is dropped by a UNIQUE index rather than by application logic.
   * Convention: `<topic>:<aggregateId>[:<discriminator>]`.
   */
  dedupeKey?: string | null;
  /** Delay the side effect (e.g. "expire this deposit in 2h"). Defaults to now. */
  availableAt?: Date;
}

export interface OutboxEnqueueResult {
  id: string;
  /** True when an identical dedupeKey was already registered; nothing new was written. */
  deduplicated: boolean;
}

/** Exactly the columns the claim query returns, in camelCase because the SQL aliases them. */
export interface ClaimedOutboxRow {
  id: string;
  aggregateType: string;
  aggregateId: string;
  topic: string;
  payload: Prisma.JsonValue;
  attempts: number;
  availableAt: Date;
  createdAt: Date;
}

/** Message as handed to a topic handler. */
export interface OutboxMessageView {
  outboxId: string;
  aggregateType: string;
  aggregateId: string;
  topic: string;
  payload: JsonObject;
  attempt: number;
}

/**
 * Implemented by feature modules and collected under the OUTBOX_HANDLERS token. A handler must be
 * idempotent: the relay guarantees at-least-once publish, and BullMQ retries on failure.
 */
export interface OutboxTopicHandler {
  /** Exact topic, or a prefix ending in "*" (e.g. "telegram.*"). */
  readonly topic: string;
  handle(message: OutboxMessageView): Promise<void>;
}

export const OUTBOX_HANDLERS = Symbol('OUTBOX_HANDLERS');

export interface OutboxRelayTickResult {
  claimed: number;
  published: number;
  failed: number;
  dead: number;
}
