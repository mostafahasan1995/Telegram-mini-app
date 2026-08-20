/**
 * The SCHEDULE for the registration backfill. Nothing else.
 *
 * Same split, and for the same reason, as DepositExpiryCron: `@Interval` fires wherever
 * ScheduleModule is imported, while the WORK has to live in a service both roles can hold so an
 * admin "run it now" endpoint is not depending on a worker-only provider. This class owns only the
 * interval, the APP_ROLE guard, the leader lock and the swallow.
 *
 * The role guard is the belt to ScheduleModule's braces: it is imported only in worker.module.ts,
 * but a provider that runs a registration in the api process would be a genuinely bad surprise —
 * an api-role process never signs in to Ichancy (the worker owns the single token pair), so every
 * attempt it made would fail with ICHANCY_SESSION_MISSING and burn the players' attempt budget.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { LockService } from '@core/cache/lock.service';
import { AppConfigService } from '@core/config/config.service';

import {
  PLAYER_LINK_BACKFILL_INTERVAL_MS,
  PLAYER_LINK_BACKFILL_LOCK_TTL_MS,
} from '../player.constants';
import { PlayerLinkBackfillService } from './player-link-backfill.service';

@Injectable()
export class PlayerLinkBackfillCron {
  private readonly logger = new Logger(PlayerLinkBackfillCron.name);

  constructor(
    private readonly backfill: PlayerLinkBackfillService,
    private readonly locks: LockService,
    private readonly config: AppConfigService,
  ) {}

  @Interval('player-link-backfill', PLAYER_LINK_BACKFILL_INTERVAL_MS)
  async tick(): Promise<void> {
    if (!this.config.app.isWorker) return;

    // One replica per tick. Losing the race is harmless — every write is a compare-and-set and the
    // per-player lock is underneath — but N replicas all registering the same person is N
    // registerPlayer calls on an endpoint that is not idempotent.
    const handle = await this.locks.acquire(
      LockService.key('cron', 'player-link-backfill'),
      PLAYER_LINK_BACKFILL_LOCK_TTL_MS,
    );
    if (handle === null) return;

    try {
      const result = await this.backfill.runOnce();
      if (result.linked + result.deferred + result.parked > 0) {
        this.logger.log(
          `player-link backfill: ${String(result.linked)} linked, ` +
            `${String(result.deferred)} deferred, ${String(result.parked)} parked ` +
            `(scanned ${String(result.scanned)})`,
        );
      }
    } catch (cause) {
      // A cron that throws is an unhandled rejection; it must be loud but harmless.
      this.logger.error(
        `player-link backfill failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      await this.locks.release(handle).catch(() => false);
    }
  }
}
