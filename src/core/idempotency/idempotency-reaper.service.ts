/**
 * WHY a reaper at all: idempotency_keys is append-only in practice — every money-moving POST adds a
 * row and nothing ever deletes one. Without a sweep the table grows forever, and the UNIQUE index
 * that the whole mechanism depends on grows with it. Expiry is what keeps `begin` an index lookup.
 *
 * Worker-only, like every other schedule: two roles reaping the same rows would just fight over
 * locks (SKIP LOCKED makes that harmless, but pointless).
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { AppConfigService } from '@core/config/config.service';

import { IDEMPOTENCY_REAPER_CRON_NAME } from './idempotency.constants';
import { IdempotencyService } from './idempotency.service';

@Injectable()
export class IdempotencyReaperService {
  private readonly logger = new Logger(IdempotencyReaperService.name);
  private reaping = false;

  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly config: AppConfigService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES, { name: IDEMPOTENCY_REAPER_CRON_NAME })
  async reap(): Promise<number> {
    if (!this.config.app.isWorker) return 0;
    // A sweep that runs long must not be started again on the next tick; the batches are bounded but
    // a very large backlog can still exceed ten minutes.
    if (this.reaping) return 0;
    this.reaping = true;
    try {
      const deleted = await this.idempotency.reap();
      if (deleted > 0) this.logger.log(`Reaped ${deleted} expired idempotency key(s)`);
      return deleted;
    } catch (cause) {
      this.logger.error(
        `Idempotency reaper failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return 0;
    } finally {
      this.reaping = false;
    }
  }
}
