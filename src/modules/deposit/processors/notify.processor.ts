/**
 * The consumer of the `telegram` queue: admin review cards and player messages.
 *
 * WHY Telegram gets its own queue: the Bot API rate-limits per chat and globally, and a 429 on one
 * busy admin group must never be able to stall a money credit. Keeping sends here means the worst a
 * Telegram outage can do is delay notifications.
 *
 * WHY every handler is idempotent: delivery is at-least-once and the card is EDITED in place, so a
 * replay produces "message is not modified", which BotService already reports as success. That is
 * what makes retrying a notification free.
 *
 * Concurrency 5: comfortably under the Bot API's ~30 messages/second while leaving room for the
 * per-chat limit to be the binding constraint rather than us.
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import { QUEUE_NAMES } from '@core/queue/queue.constants';
import {
  TASKS,
  type TelegramAdminCardPostTask,
  type TelegramAdminCardUpdateTask,
  type TelegramNotifyPlayerTask,
} from '@core/queue/queue.types';

import { DepositNotifyService } from '../services/deposit-notify.service';

const TELEGRAM_CONCURRENCY = 5;

@Injectable()
@Processor(QUEUE_NAMES.TELEGRAM, { concurrency: TELEGRAM_CONCURRENCY })
export class NotifyProcessor extends WorkerHost {
  private readonly logger = new Logger(NotifyProcessor.name);

  constructor(private readonly notify: DepositNotifyService) {
    super();
  }

  override async process(job: Job<unknown, unknown, string>): Promise<void> {
    switch (job.name) {
      case TASKS.TELEGRAM_ADMIN_CARD_POST: {
        const data = job.data as TelegramAdminCardPostTask;
        await this.notify.postOrUpdateAdminCard(data.depositRequestId, 'submitted');
        return;
      }
      case TASKS.TELEGRAM_ADMIN_CARD_UPDATE: {
        const data = job.data as TelegramAdminCardUpdateTask;
        await this.notify.postOrUpdateAdminCard(data.depositRequestId, data.reason);
        return;
      }
      case TASKS.TELEGRAM_NOTIFY_PLAYER: {
        const data = job.data as TelegramNotifyPlayerTask;
        await this.notify.notifyPlayer(data.playerId, data.template, toStringParams(data.params));
        return;
      }
      default:
        throw new Error(`The telegram queue has no handler for job "${job.name}"`);
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<unknown, unknown, string> | undefined, error: Error): void {
    this.logger.error(
      `telegram job ${job?.name ?? 'unknown'} ${job?.id ?? ''} failed on attempt ${
        job?.attemptsMade ?? 0
      }: ${error.message}`,
    );
  }
}

/**
 * Template parameters travel as JSON, so a value can legally be a number, a boolean or an object.
 * The renderer only ever interpolates strings; flattening here keeps that contract from leaking a
 * `[object Object]` into a message a player reads.
 */
function toStringParams(params: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    out[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return out;
}
