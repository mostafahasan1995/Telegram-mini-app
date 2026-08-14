/**
 * The consumer of the `media` queue: decode, normalize, hash and screen a proof image.
 *
 * WHY this is a queue and not part of the request: sharp decoding a 12-megapixel photo is hundreds
 * of milliseconds of CPU, and it arrives in bursts (a player uploading, then re-uploading). Doing it
 * on the HTTP thread makes the mini-app feel broken; doing it on the Telegram webhook path makes
 * Telegram retry the update, which is worse. Here it is bounded, retryable and off the critical
 * path — the deposit is already SUBMITTED and visible to an admin before this runs.
 *
 * Concurrency 2: sharp releases the event loop but not the CPU, and this process also has to answer
 * a credit worker.
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import { QUEUE_NAMES } from '@core/queue/queue.constants';
import { TASKS, type MediaProofProcessTask } from '@core/queue/queue.types';

import { ProofIngestService, type IngestOutcome } from '../services/proof-ingest.service';

const MEDIA_CONCURRENCY = 2;

@Injectable()
@Processor(QUEUE_NAMES.MEDIA, { concurrency: MEDIA_CONCURRENCY })
export class IngestProofProcessor extends WorkerHost {
  private readonly logger = new Logger(IngestProofProcessor.name);

  constructor(private readonly ingest: ProofIngestService) {
    super();
  }

  override async process(job: Job<unknown, unknown, string>): Promise<IngestOutcome> {
    if (job.name !== TASKS.MEDIA_PROOF_PROCESS) {
      throw new Error(`The media queue has no handler for job "${job.name}"`);
    }
    const data = job.data as MediaProofProcessTask;
    const outcome = await this.ingest.ingest(data.depositProofId);
    this.logger.log(`proof ${data.depositProofId} -> ${outcome.status}`);
    return outcome;
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<unknown, unknown, string> | undefined, error: Error): void {
    this.logger.error(
      `media job ${job?.id ?? 'unknown'} failed on attempt ${job?.attemptsMade ?? 0}: ${error.message}`,
    );
  }
}
