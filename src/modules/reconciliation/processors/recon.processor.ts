/**
 * The consumer of the `recon` queue.
 *
 * WHY the crons ALSO exist when there is a queue: the crons decide WHEN a sweep happens; this
 * processor exists so a sweep can be requested by something other than the clock — an operator
 * pressing a button, a credit that just failed on an empty float wanting the figure refreshed
 * immediately, a deploy hook.
 *
 * One @Processor for the whole queue, dispatching on job.name — two Workers on one queue would
 * compete for the same jobs and each would get a random half. Concurrency 1: these are sweeps over
 * the whole ledger and running two at once buys nothing but lock contention.
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import { QUEUE_NAMES } from '@core/queue/queue.constants';
import { TASKS, type ReconAgentFloatCheckTask } from '@core/queue/queue.types';

import { AgentFloatSyncService } from '../services/agent-float-sync.service';
import { InvariantCheckCron } from '../services/invariant-check.cron';
import { RailAgeingService } from '../services/rail-ageing.service';

@Injectable()
@Processor(QUEUE_NAMES.RECON, { concurrency: 1 })
export class ReconProcessor extends WorkerHost {
  private readonly logger = new Logger(ReconProcessor.name);

  constructor(
    private readonly floatSync: AgentFloatSyncService,
    private readonly invariants: InvariantCheckCron,
    private readonly railAgeing: RailAgeingService,
  ) {
    super();
  }

  override async process(job: Job<unknown, unknown, string>): Promise<unknown> {
    switch (job.name) {
      case TASKS.RECON_AGENT_FLOAT_CHECK: {
        const data = job.data as ReconAgentFloatCheckTask;
        const result = await this.floatSync.sync(data.currencyCode);
        return {
          ledgerMinor: result.ledgerMinor.toString(),
          ichancyMinor: result.ichancyMinor?.toString() ?? null,
          deltaMinor: result.deltaMinor?.toString() ?? null,
          breakId: result.breakId,
        };
      }
      case TASKS.RECON_STUCK_DEPOSITS: {
        // Stuck deposits are reaped by the deposit module's own sweeper (it owns the state machine
        // and the outbox messages a reap produces). What belongs here is the ageing view of money
        // that never settled, which is the same question asked of the ledger instead of the queue.
        const report = await this.railAgeing.report();
        return { staleAccountCodes: report.staleAccountCodes, rows: report.rows.length };
      }
      case TASKS.RECON_DEPOSIT_VERIFY: {
        // Verification needs the per-player mutex and the Ichancy port, both of which belong to the
        // credit path; re-running the credit is the correct way to re-verify a deposit, and it is
        // reachable from the admin endpoint. Failing loudly here beats a silent no-op.
        throw new Error(
          `${TASKS.RECON_DEPOSIT_VERIFY} is handled by re-running the credit ` +
            `(POST /v1/admin/deposits/:id/retry-credit), not by the recon queue`,
        );
      }
      default:
        throw new Error(`The recon queue has no handler for job "${job.name}"`);
    }
  }

  /** Exposed so a deploy hook or an operator can force a full pass. */
  async runAll(currencyCode: string): Promise<void> {
    await this.invariants.runOnce();
    await this.floatSync.sync(currencyCode);
    await this.railAgeing.report();
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<unknown, unknown, string> | undefined, error: Error): void {
    this.logger.error(
      `recon job ${job?.name ?? 'unknown'} failed on attempt ${job?.attemptsMade ?? 0}: ${error.message}`,
    );
  }
}
