/**
 * Everything the worker must do ONCE, at startup, before the first job lands.
 *
 * WHY the role assertion is fatal: WorkerModule composes live BullMQ consumers, the outbox relay,
 * every `@Interval`, and the only Ichancy sign-in in the system. Booting this graph with
 * APP_ROLE=api produces a process that consumes queues while `IchancySessionService` refuses to
 * sign in (it checks the role itself) — so jobs would be claimed and then fail on a missing token,
 * with the failures looking like an Ichancy outage. Refusing to start is the honest answer.
 *
 * WHY the Ichancy warm-up does NOT fail the boot: `ensureSession()` performs a real signIn when
 * Redis holds no token pair. If the agent API happens to be down at deploy time, a worker that
 * refuses to start would also stop draining the outbox, expiring stale deposits and answering
 * Telegram — none of which need Ichancy. The credit path acquires a token on demand anyway, so a
 * failed warm-up costs one extra round trip later, not correctness. It is logged at error level
 * because it is still the first thing to check when credits start failing.
 *
 * Calling it at all matters for a subtler reason: only ONE token pair is valid per agent and a
 * second signIn silently invalidates the first. `ensureSession()` takes the distributed lock and
 * reuses whatever is already in Redis, so warming up here is safe with more than one worker
 * replica — whereas a naive signIn at boot would have them knocking each other out on every deploy.
 */
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

import { AppConfigService } from '@core/config/config.service';
import { IchancySessionService } from '@core/ichancy/ichancy-session.service';

@Injectable()
export class WorkerBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WorkerBootstrapService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly session: IchancySessionService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.app.isWorker) {
      throw new Error(
        `WorkerModule was bootstrapped with APP_ROLE=${this.config.app.role}. ` +
          'Queue consumers, schedules and Ichancy sign-in belong to APP_ROLE=worker only.',
      );
    }

    this.logger.log('Worker starting: queues, schedules, outbox relay and Ichancy session');

    // ICHANCY_FAKE swaps the IchancyPort for the in-memory adapter, but the session service talks
    // to the real host regardless — so warming it up against a placeholder ICHANCY_BASE_URL logged
    // an ERROR on every single dev boot. A startup error that is never a real problem teaches
    // people to skim past startup errors, which is the last habit this service should encourage.
    if (this.config.ichancy.fake) {
      this.logger.warn('Ichancy is FAKE (ICHANCY_FAKE) — skipping sign-in. No real money moves.');
      return;
    }

    try {
      await this.session.ensureSession();
      const info = await this.session.describe();
      this.logger.log(
        `Ichancy session ready (source=${info.hasSession ? info.source : 'none'}, ` +
          `generation=${info.hasSession ? info.generation : 0})`,
      );
    } catch (error: unknown) {
      this.logger.error(
        `Ichancy session warm-up failed; credits will sign in on demand: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
