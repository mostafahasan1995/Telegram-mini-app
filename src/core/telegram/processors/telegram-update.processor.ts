/**
 * THE MISSING HALF OF THE TELEGRAM PIPELINE.
 *
 * `TelegramWebhookController` (api role) authenticates an update, persists it and enqueues it onto
 * `telegram-updates`. Until this class existed nothing consumed that queue: every button press in
 * the admin review group was accepted with a 200, written to `telegram_updates`, parked in Redis —
 * and never handled. Nothing errors in that state, which is exactly why it needs to be a real
 * provider rather than a convention.
 *
 * The contract (queue name, job name, payload shape) is owned by @core/telegram/telegram.constants;
 * this is the consumer side of it, and it is worker-only — see WorkerModule.
 *
 * WHY the job is acknowledged even when a handler misbehaves:
 * `TelegramHandlerRegistrar` wraps every handler and swallows its errors on purpose, because
 * replaying an update whose money side-effect already happened is precisely what the dedupe layer
 * exists to prevent. So anything that still escapes `handleUpdate()` is a grammY-level or transport
 * failure. We record it on the row (`markFailed`) and rethrow, letting BullMQ's retry policy have
 * its five attempts — the update is identified by a fixed jobId, so a retry can never fan out into
 * two deliveries.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { Bot } from 'grammy';

import { ActorContextService } from '@core/actor-context/actor-context.service';

import { TELEGRAM_BOT, TELEGRAM_UPDATE_JOB, TELEGRAM_UPDATE_QUEUE } from '../telegram.constants';
import { type TelegramUpdateJobData } from '../telegram.types';
import { UpdateDedupeService } from '../services/update-dedupe.service';

/**
 * Modest on purpose. Handlers talk to Telegram (rate limited per chat) and to Postgres, and an
 * admin tapping "approve" twice in a second should be serialised by the per-deposit guards, not by
 * luck. Five in flight is plenty for a review group's traffic.
 */
const TELEGRAM_UPDATE_CONCURRENCY = 5;

@Injectable()
@Processor(TELEGRAM_UPDATE_QUEUE, { concurrency: TELEGRAM_UPDATE_CONCURRENCY })
export class TelegramUpdateProcessor extends WorkerHost {
  private readonly logger = new Logger(TelegramUpdateProcessor.name);

  constructor(
    @Inject(TELEGRAM_BOT) private readonly bot: Bot,
    private readonly dedupe: UpdateDedupeService,
    private readonly actorContext: ActorContextService,
  ) {
    super();
  }

  override async process(job: Job<TelegramUpdateJobData, void, string>): Promise<void> {
    if (job.name !== TELEGRAM_UPDATE_JOB) {
      // Not ours. Failing loudly beats silently dropping something another producer expected us to
      // handle — and there is no other producer on this queue today.
      throw new Error(`Unexpected job "${job.name}" on ${TELEGRAM_UPDATE_QUEUE}`);
    }

    const { updateRowId, updateId, update } = job.data;

    // A bot handler that approves a deposit writes audit rows and calls Ichancy. Without a context
    // those rows carry a null correlationId, i.e. an effect nobody can trace back to the tap that
    // caused it. The update id is stable across every retry, which is what makes it a useful key.
    await this.actorContext.runAsSystem(async () => {
      try {
        await this.bot.handleUpdate(update);
      } catch (error: unknown) {
        await this.dedupe.markFailed(updateRowId, error);
        throw error;
      }
      await this.dedupe.markProcessed(updateRowId, TelegramUpdateProcessor.name);
    }, `tg-update-${updateId}`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<TelegramUpdateJobData> | undefined, error: Error): void {
    this.logger.error(
      `Telegram update ${job?.data?.updateId ?? '(unknown)'} failed on attempt ${
        job?.attemptsMade ?? 0
      }: ${error.message}`,
      error.stack,
    );
  }
}
