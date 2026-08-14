/**
 * WHY this endpoint does almost nothing: Telegram gives a webhook a short budget and retries
 * anything it does not get a prompt 200 for. Doing real work here — resolving a player, reading a
 * deposit, calling Ichancy — means slow responses, duplicate deliveries of the SAME approval, and
 * a bot that stalls whenever Postgres is busy. So the handler only: authenticates, persists once,
 * enqueues, returns. Everything else happens in the worker.
 *
 * WHY it almost never returns 4xx/5xx: a non-2xx tells Telegram to send the update again. That is
 * the right answer for "we failed to store it" and the WRONG answer for "this deposit was already
 * approved" — the latter would put Telegram in a retry loop over a decision that has already been
 * made. Business outcomes are therefore reported inside the bot conversation, never through the
 * HTTP status. The only rejections here are authentication ones.
 *
 * ORDERING IS SECURITY-RELEVANT: the secret token is checked before anything reads the body.
 * (Express has already parsed the JSON by the time a controller runs — moving the check earlier
 * than that needs middleware, which is out of this module's scope — but nothing in OUR code
 * inspects, stores or forwards the payload before the comparison succeeds.)
 */
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { type Update } from 'grammy/types';
import { Public } from '@common/decorators/auth.decorator';
import { ForbiddenError } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';
import { AppConfigService } from '../../config/config.service';
import {
  TELEGRAM_SECRET_HEADER,
  TELEGRAM_UPDATE_JOB,
  TELEGRAM_UPDATE_QUEUE,
} from '../telegram.constants';
import { type TelegramUpdateJobData } from '../telegram.types';
import { UpdateDedupeService } from '../services/update-dedupe.service';
import { secureCompare } from '../utils/secure-compare.util';

interface WebhookAck {
  ok: true;
  deduped?: boolean;
}

@Controller('telegram/webhook')
export class TelegramWebhookController {
  private readonly logger = new Logger(TelegramWebhookController.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly dedupe: UpdateDedupeService,
    @InjectQueue(TELEGRAM_UPDATE_QUEUE)
    private readonly queue: Queue<TelegramUpdateJobData>,
  ) {}

  /**
   * The path token is part of the URL (`/telegram/webhook/<token>`) because it keeps the endpoint
   * off scanners' radar; the secret header is the actual credential. Both are compared in constant
   * time — this route is unauthenticated by definition, so it is the one place where a comparison
   * oracle is directly reachable.
   */
  @Public()
  @Post(':token')
  @HttpCode(HttpStatus.OK)
  async receive(
    @Param('token') pathToken: string,
    @Headers(TELEGRAM_SECRET_HEADER) secretHeader: string | undefined,
    @Body() update: Update,
  ): Promise<WebhookAck> {
    if (!secureCompare(secretHeader, this.config.telegram.webhookSecret)) {
      // 403 is correct here and is NOT a business failure: whoever sent this is not Telegram.
      throw new ForbiddenError(
        CommonErrorCodes.TELEGRAM_WEBHOOK_SECRET_INVALID,
        'Invalid webhook credentials.',
      );
    }

    if (!secureCompare(pathToken, this.config.telegram.webhookPathToken)) {
      throw new ForbiddenError(
        CommonErrorCodes.TELEGRAM_WEBHOOK_SECRET_INVALID,
        'Invalid webhook credentials.',
      );
    }

    // A body without an update_id cannot be deduplicated, so it cannot be processed safely.
    // Answering 200 keeps a malformed probe from turning into an infinite Telegram retry.
    if (typeof update?.update_id !== 'number') {
      this.logger.warn('Received an authenticated webhook call with no update_id; ignoring');
      return { ok: true };
    }

    const recorded = await this.dedupe.record(update);
    if (!recorded.isNew || recorded.id === null) {
      return { ok: true, deduped: true };
    }

    try {
      await this.queue.add(
        TELEGRAM_UPDATE_JOB,
        {
          updateRowId: recorded.id,
          updateId: String(update.update_id),
          update,
        },
        {
          // A second dedupe layer: even if the row and the Redis claim were both lost, BullMQ will
          // not create a second job with this id while the first is still known.
          jobId: `tg-${update.update_id}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 1_000 },
          removeOnComplete: 1_000,
          // Failures are kept much longer: a dropped update is invisible unless someone can see it.
          removeOnFail: 10_000,
        },
      );
    } catch (error: unknown) {
      // Undo the record so Telegram's retry is accepted rather than deduplicated away. Then let
      // the 500 through, because a retry is exactly what we want.
      await this.dedupe.rollback(recorded.id, update.update_id);
      this.logger.error(
        `Failed to enqueue update ${update.update_id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }

    return { ok: true };
  }
}
