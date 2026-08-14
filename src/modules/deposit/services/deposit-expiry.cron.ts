/**
 * The SCHEDULE for the deposit sweep. Nothing else.
 *
 * WHY the work is not in here: `@Interval` fires wherever ScheduleModule is imported, so this class
 * exists only in the worker composition. The admin panel also has a "run the sweep now" button, and
 * that endpoint is served by the API — so the work has to live in a service both roles have
 * (DepositSweepService). Putting both in one class made the api's DepositAdminController depend on a
 * worker-only provider, i.e. a boot-time crash of the whole deposit admin surface. That is not a
 * hypothetical: deposit.di.int.spec.ts caught it, which is why this split exists.
 *
 * WHAT THIS CLASS OWNS
 *  - the interval;
 *  - the APP_ROLE guard (belt and braces — the module already excludes it from the api graph);
 *  - the leader lock, so N worker replicas do not all sweep the same rows every minute. Losing the
 *    race is harmless (every transition is a CAS and the loser sees `alreadyHandled`), but doing the
 *    same work N times a minute forever is not free;
 *  - swallowing the error, because a cron that throws is an unhandled rejection.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { LockService } from '@core/cache/lock.service';
import { AppConfigService } from '@core/config/config.service';

import { DepositSweepService } from './deposit-sweep.service';

const SWEEP_INTERVAL_MS = 60_000;
/** Just under the interval, so a tick is never skipped because the previous lock outlived it. */
const SWEEP_LOCK_TTL_MS = 55_000;

@Injectable()
export class DepositExpiryCron {
  private readonly logger = new Logger(DepositExpiryCron.name);

  constructor(
    private readonly sweeper: DepositSweepService,
    private readonly locks: LockService,
    private readonly config: AppConfigService,
  ) {}

  @Interval('deposit-sweep', SWEEP_INTERVAL_MS)
  async sweep(): Promise<void> {
    if (!this.config.app.isWorker) return;

    const handle = await this.locks.acquire(
      LockService.key('cron', 'deposit-sweep'),
      SWEEP_LOCK_TTL_MS,
    );
    if (handle === null) return;

    try {
      const report = await this.sweeper.runOnce();
      if (report.expired + report.released + report.reaped > 0) {
        this.logger.log(
          `sweep: expired ${report.expired}, released ${report.released}, reaped ${report.reaped}`,
        );
      }
    } catch (cause) {
      // A cron that throws takes nothing down, but it must be visible.
      this.logger.error(
        `deposit sweep failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      await this.locks.release(handle).catch(() => false);
    }
  }
}
