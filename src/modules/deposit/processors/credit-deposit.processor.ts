/**
 * The consumer of the `ichancy` queue.
 *
 * WHY one processor for the whole queue rather than one per task: a BullMQ Worker consumes a QUEUE,
 * not a job name. Two @Processor classes bound to `ichancy` would compete for the same jobs and each
 * message would reach a random one of them — the single worst failure mode a queue has, because it
 * looks like everything works until half the credits vanish. So the queue has exactly one consumer
 * and it dispatches on `job.name`.
 *
 * WHY concurrency is 4 and not higher: every credit holds a per-player Redis mutex for the whole
 * verify window (seconds, sometimes tens of seconds), and every one of them debits the single
 * ICHANCY_AGENT_FLOAT ledger account. More concurrency does not buy throughput here; it buys lock
 * contention on one hot row.
 *
 * WHY a decided outcome never throws: `failed`, `needs_reconciliation` and `skipped` are ANSWERS.
 * Throwing on them would make BullMQ retry a deposit that has already been resolved — and the one
 * outcome we must never retry is the one where Ichancy told us the float is empty. Only
 * CreditRetryLaterError (mutex contention, an unreadable baseline) is rethrown, because only those
 * are genuinely transient.
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import { QUEUE_NAMES } from '@core/queue/queue.constants';
import { TASKS, type IchancyDepositCreditTask } from '@core/queue/queue.types';

import {
  CreditRetryLaterError,
  DepositCreditService,
  type CreditOutcome,
} from '../services/deposit-credit.service';

/** See the header: this bounds contention on one player mutex and one float account. */
const CREDIT_CONCURRENCY = 4;

@Injectable()
@Processor(QUEUE_NAMES.ICHANCY, { concurrency: CREDIT_CONCURRENCY })
export class CreditDepositProcessor extends WorkerHost {
  private readonly logger = new Logger(CreditDepositProcessor.name);

  constructor(private readonly credits: DepositCreditService) {
    super();
  }

  override async process(job: Job<unknown, unknown, string>): Promise<CreditOutcome> {
    if (job.name !== TASKS.ICHANCY_DEPOSIT_CREDIT) {
      // Nothing else is enqueued onto this queue today. Failing loudly beats acknowledging work
      // nobody performed.
      throw new Error(`The ichancy queue has no handler for job "${job.name}"`);
    }

    const data = job.data as IchancyDepositCreditTask;
    const outcome = await this.credits.credit({
      depositRequestId: data.depositRequestId,
      shortId: data.shortId,
      creditKeyEpoch: data.creditKeyEpoch,
      amountMinor: data.amountMinor,
      ...(typeof job.id === 'string' ? { correlationId: `credit:${job.id}` } : {}),
    });

    this.logger.log(`credit ${data.shortId} -> ${outcome.kind}`);
    return outcome;
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<unknown, unknown, string> | undefined, error: Error): void {
    const transient = error instanceof CreditRetryLaterError;
    const label = `${job?.name ?? 'unknown'} ${job?.id ?? ''}`;
    if (transient) {
      this.logger.warn(`${label} will retry: ${error.message}`);
      return;
    }
    this.logger.error(
      `${label} failed on attempt ${job?.attemptsMade ?? 0}: ${error.message}`,
      error.stack,
    );
  }
}
