/**
 * Everything the worker must do ONCE, at startup, before the first job lands.
 *
 * WHY the role assertion is fatal: WorkerModule composes live BullMQ consumers, the outbox relay,
 * every `@Interval`, and the only on-demand Ichancy sign-in in the system. Booting this graph with
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
 * second signIn silently invalidates the first. `ensureSession()` takes the agent's distributed lock
 * and reuses whatever is already in Redis, so warming up here is safe with more than one worker
 * replica — whereas a naive signIn at boot would have them knocking each other out on every deploy.
 *
 * ONE WARM-UP PER AGENT, NOT PER OPERATOR: every ACTIVE operator's own agent is warmed with its own
 * credentials, inside that operator's tenant context (so the sign-in's call-log row lands in its log).
 * Operators that share an agent with the same credentials share one session, so the second of them
 * finds it in Redis and signs in nothing. One operator's failure never stops the rest.
 */
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

import { AppConfigService } from '@core/config/config.service';
import {
  ICHANCY_AGENT_RESOLVER,
  type IchancyAgentResolver,
} from '@core/ichancy/ichancy-agent';
import { IchancySessionService } from '@core/ichancy/ichancy-session.service';
import { TenantRegistryService } from '@core/tenant/services/tenant-registry.service';
import { runWithTenant } from '@core/tenant/tenant.storage';

@Injectable()
export class WorkerBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WorkerBootstrapService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly session: IchancySessionService,
    private readonly tenants: TenantRegistryService,
    @Inject(ICHANCY_AGENT_RESOLVER) private readonly agents: IchancyAgentResolver,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.app.isWorker) {
      throw new Error(
        `WorkerModule was bootstrapped with APP_ROLE=${this.config.app.role}. ` +
          'Queue consumers, schedules and Ichancy sign-in belong to APP_ROLE=worker only.',
      );
    }

    this.logger.log('Worker starting: queues, schedules, outbox relay and Ichancy sessions');

    // ICHANCY_FAKE swaps the IchancyPort for the in-memory adapter, but the session service talks
    // to the real host regardless — so warming it up against placeholder operators logged an ERROR
    // on every single dev boot. A startup error that is never a real problem teaches people to skim
    // past startup errors, which is the last habit this service should encourage.
    if (this.config.ichancy.fake) {
      this.logger.warn('Ichancy is FAKE (ICHANCY_FAKE) — skipping sign-in. No real money moves.');
      return;
    }

    let operators: { id: string; slug: string }[];
    try {
      operators = await this.tenants.listActiveOperators();
    } catch (error: unknown) {
      this.logger.error(
        `Ichancy session warm-up skipped: could not list operators: ${describe(error)}`,
      );
      return;
    }

    const warmed = new Set<string>();
    for (const operator of operators) {
      try {
        const agent = await this.agents.forTenant(operator.id);
        const identity = `${agent.agentKey}:${agent.credentialDigest}`;
        if (warmed.has(identity)) continue;
        warmed.add(identity);

        await runWithTenant(operator.id, () => this.session.ensureSession(agent));
        const info = await this.session.describe(agent);
        this.logger.log(
          `Ichancy session ready for ${operator.slug} (agent ${agent.agentKey}, ` +
            `source=${info.hasSession ? String(info.source) : 'none'}, ` +
            `generation=${info.hasSession ? String(info.generation) : '0'})`,
        );
      } catch (error: unknown) {
        this.logger.error(
          `Ichancy session warm-up failed for ${operator.slug}; its credits will sign in on demand: ${describe(error)}`,
        );
      }
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
