/**
 * Turns committed `deposit.*` outbox rows into queue jobs.
 *
 * WHY there is a hop from the outbox queue onto another queue at all: the outbox exists to make a
 * side effect ATOMIC with the change that caused it, and its dispatcher drains one queue with a
 * shared concurrency budget. A credit holds a per-player mutex for up to a minute while it waits out
 * an ambiguous call; running that on the outbox worker would let a handful of ambiguous credits
 * starve every notification in the system. So the outbox hands the work to the queue that has the
 * right retry policy and the right isolation, and does nothing else.
 *
 * The ALERT topic is the one exception: it is a single sendMessage with no retry semantics worth
 * separating, and an alert that queues behind a backlog of review cards is an alert that arrives too
 * late to matter.
 *
 * IDEMPOTENCY: every job gets a deterministic jobId, so a re-published outbox row (the relay
 * guarantees at-least-once) collapses into the job that already exists rather than a second credit.
 */
import { Injectable, Logger } from '@nestjs/common';

import { isJsonObject, type JsonObject } from '@core/queue/json.util';
import { TASKS } from '@core/queue/queue.types';
import { TypedQueueService } from '@core/queue/typed-queue.service';
import type { OutboxMessageView, OutboxTopicHandler } from '@core/outbox/outbox.types';

import { DEPOSIT_TOPICS, DEPOSIT_TOPIC_PREFIX, creditJobId } from '../deposit.constants';
import { DepositNotifyService } from '../services/deposit-notify.service';

const str = (payload: JsonObject, key: string): string | null => {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
};

const int = (payload: JsonObject, key: string, fallback: number): number => {
  const value = payload[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
};

const params = (payload: JsonObject): JsonObject => {
  const value = payload['params'];
  return isJsonObject(value) ? value : {};
};

@Injectable()
export class DepositOutboxHandler implements OutboxTopicHandler {
  /** Prefix subscription: one handler owns the whole `deposit.` namespace. */
  readonly topic = `${DEPOSIT_TOPIC_PREFIX}*`;

  private readonly logger = new Logger(DepositOutboxHandler.name);

  constructor(
    private readonly queue: TypedQueueService,
    private readonly notify: DepositNotifyService,
  ) {}

  async handle(message: OutboxMessageView): Promise<void> {
    const payload = message.payload;

    switch (message.topic) {
      case DEPOSIT_TOPICS.CREDIT_REQUESTED:
        return this.dispatchCredit(message, payload);

      case DEPOSIT_TOPICS.NOTIFY_ADMIN:
        await this.queue.add(
          TASKS.TELEGRAM_ADMIN_CARD_POST,
          { depositRequestId: message.aggregateId },
          { jobId: `deposit-card-post:${message.aggregateId}` },
        );
        return;

      case DEPOSIT_TOPICS.CARD_UPDATE:
        await this.queue.add(
          TASKS.TELEGRAM_ADMIN_CARD_UPDATE,
          {
            depositRequestId: message.aggregateId,
            reason: str(payload, 'reason') ?? 'state-change',
          },
          // The outbox row id makes each redraw unique, while a REDELIVERY of the same row collapses.
          { jobId: `deposit-card-update:${message.outboxId}` },
        );
        return;

      case DEPOSIT_TOPICS.NOTIFY_PLAYER: {
        const playerId = str(payload, 'playerId');
        const template = str(payload, 'template');
        if (playerId === null || template === null) {
          this.logger.error(
            `outbox ${message.outboxId} is a player notification without a playerId/template`,
          );
          return;
        }
        await this.queue.add(
          TASKS.TELEGRAM_NOTIFY_PLAYER,
          { playerId, template, params: params(payload) },
          { jobId: `deposit-notify:${message.outboxId}` },
        );
        return;
      }

      case DEPOSIT_TOPICS.PROOF_INGEST: {
        const depositProofId = str(payload, 'depositProofId');
        if (depositProofId === null) {
          this.logger.error(`outbox ${message.outboxId} is a proof ingest without a proof id`);
          return;
        }
        await this.queue.add(
          TASKS.MEDIA_PROOF_PROCESS,
          { depositProofId },
          { jobId: `proof-ingest:${depositProofId}` },
        );
        return;
      }

      case DEPOSIT_TOPICS.ALERT:
        // Sent inline: see the header. Alerts must not queue behind review cards.
        await this.notify.alertAdmins({
          shortId: str(payload, 'shortId') ?? undefined,
          severity: str(payload, 'severity') ?? 'warning',
          code: str(payload, 'code') ?? 'DEPOSIT_ALERT',
          message: str(payload, 'message') ?? 'A deposit needs attention.',
          hint: str(payload, 'hint') ?? undefined,
        });
        return;

      default:
        // Reaching here means a topic was produced that nobody routes. Throwing puts the job in the
        // failed set, where it is visible — silently acknowledging it would lose the side effect.
        throw new Error(`No deposit outbox route for topic "${message.topic}"`);
    }
  }

  private async dispatchCredit(message: OutboxMessageView, payload: JsonObject): Promise<void> {
    const shortId = str(payload, 'shortId');
    const amountMinor = str(payload, 'amountMinor');
    if (shortId === null || amountMinor === null) {
      throw new Error(`outbox ${message.outboxId} requests a credit without a shortId/amountMinor`);
    }
    const creditKeyEpoch = int(payload, 'creditKeyEpoch', 0);

    await this.queue.add(
      TASKS.ICHANCY_DEPOSIT_CREDIT,
      {
        depositRequestId: message.aggregateId,
        shortId,
        creditKeyEpoch,
        // Already a decimal string of minor units; MinorString is an alias of string by design.
        amountMinor,
      },
      {
        // Deterministic in (deposit, epoch): a redelivered approval cannot enqueue a second credit,
        // while a deliberate operator re-run (new epoch) is a genuinely new job.
        jobId: creditJobId(message.aggregateId, creditKeyEpoch),
        // Credits are already guarded by a mutex and by the balance-delta protocol; a long BullMQ
        // backoff just delays money that is already owed.
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
      },
    );
  }
}
