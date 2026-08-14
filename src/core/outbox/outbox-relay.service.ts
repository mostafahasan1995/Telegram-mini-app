/**
 * WHY worker-only: the relay is the one component that turns a committed row into a real side
 * effect. Running it in the api role as well would double every notification and every Ichancy
 * call attempt for no gain — horizontal scaling of the relay comes from FOR UPDATE SKIP LOCKED,
 * not from running it in more roles. The guard is defensive: the api entrypoint does not import
 * ScheduleModule either, so in practice these methods never fire there.
 *
 * DELIVERY GUARANTEE, precisely: the outbox gives at-least-once PUBLISH. Exactly-once delivery is
 * impossible; what we get instead is effectively-once, because every publish uses the deterministic
 * jobId `outbox-<row id>` and BullMQ refuses a duplicate for as long as the job exists. The failure
 * window is therefore "the row was published and the process died before marking it SENT", which
 * the reaper resolves by re-publishing into the same jobId — a no-op.
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

import { AppConfigService } from '@core/config/config.service';
import { PrismaService } from '@core/prisma/prisma.service';
import { fromDbJsonObject } from '@core/queue/json.util';
import { DEFAULT_JOB_ATTEMPTS, DEFAULT_JOB_BACKOFF_MS } from '@core/queue/queue.constants';
import { TASKS, type OutboxDispatchTask } from '@core/queue/queue.types';
import { TypedQueueService, type BulkTaskEntry } from '@core/queue/typed-queue.service';

import {
  OUTBOX_CLAIM_BATCH_SIZE,
  OUTBOX_MAX_PUBLISH_ATTEMPTS,
  OUTBOX_REAPER_INTERVAL_MS,
  OUTBOX_REAPER_INTERVAL_NAME,
  OUTBOX_RECLAIMED_ERROR,
  OUTBOX_RELAY_INTERVAL_MS,
  OUTBOX_RELAY_INTERVAL_NAME,
  OUTBOX_STALE_LOCK_MS,
  outboxJobId,
  publishBackoffMs,
} from './outbox.constants';
import { buildClaimQuery, buildReaperQuery, buildStatusCountQuery } from './outbox.sql';
import type { ClaimedOutboxRow, OutboxRelayTickResult } from './outbox.types';

const IDLE_TICK: OutboxRelayTickResult = Object.freeze({
  claimed: 0,
  published: 0,
  failed: 0,
  dead: 0,
});

/** last_error is for a human reading a dead row, not for a stack trace dump. */
const MAX_ERROR_LENGTH = 1_000;

function describeError(cause: unknown): string {
  const raw = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  return raw.length > MAX_ERROR_LENGTH ? `${raw.slice(0, MAX_ERROR_LENGTH - 1)}…` : raw;
}

@Injectable()
export class OutboxRelayService implements OnModuleInit {
  private readonly logger = new Logger(OutboxRelayService.name);
  /** Recorded in locked_by so an operator can tell which pod is sitting on a stuck row. */
  private readonly workerId = `${hostname()}#${process.pid}#${randomUUID().slice(0, 8)}`;
  private ticking = false;
  private reaping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: TypedQueueService,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.app.isWorker) {
      this.logger.log(`Outbox relay active as ${this.workerId}`);
    } else {
      this.logger.log('Outbox relay inert (APP_ROLE is not worker)');
    }
  }

  @Interval(OUTBOX_RELAY_INTERVAL_NAME, OUTBOX_RELAY_INTERVAL_MS)
  async tick(): Promise<OutboxRelayTickResult> {
    if (!this.config.app.isWorker) return IDLE_TICK;
    // A tick that overruns its interval must not start a second claim: two overlapping runs in one
    // process would fight over the same rows through the row lock and halve throughput.
    if (this.ticking) return IDLE_TICK;
    this.ticking = true;
    try {
      return await this.runOnce();
    } catch (cause) {
      this.logger.error(`Outbox relay tick failed: ${describeError(cause)}`);
      return IDLE_TICK;
    } finally {
      this.ticking = false;
    }
  }

  /** Public so an operator endpoint (and the integration spec) can drain the outbox on demand. */
  async runOnce(limit: number = OUTBOX_CLAIM_BATCH_SIZE): Promise<OutboxRelayTickResult> {
    const rows = await this.claim(limit);
    if (rows.length === 0) return IDLE_TICK;

    try {
      await this.queue.addBulk(
        TASKS.OUTBOX_DISPATCH,
        rows.map((row) => this.toJob(row)),
      );
    } catch (cause) {
      // addBulk is all-or-nothing from here: we cannot tell which entries landed, so every row goes
      // back for retry. Safe because the jobId dedupes anything that did land.
      const { failed, dead } = await this.markPublishFailed(rows, describeError(cause));
      this.logger.error(`Outbox publish failed for ${rows.length} row(s): ${describeError(cause)}`);
      return { claimed: rows.length, published: 0, failed, dead };
    }

    await this.markSent(rows.map((row) => row.id));
    this.logger.debug(`Outbox published ${rows.length} message(s)`);
    return { claimed: rows.length, published: rows.length, failed: 0, dead: 0 };
  }

  /**
   * Rows stuck IN_FLIGHT belong to a process that died between the claim and the mark. Nobody else
   * can ever pick them up, so without this they are lost forever — which is exactly the failure the
   * outbox exists to prevent.
   */
  @Interval(OUTBOX_REAPER_INTERVAL_NAME, OUTBOX_REAPER_INTERVAL_MS)
  async reap(): Promise<number> {
    if (!this.config.app.isWorker) return 0;
    if (this.reaping) return 0;
    this.reaping = true;
    try {
      const staleBefore = new Date(Date.now() - OUTBOX_STALE_LOCK_MS);
      const reclaimed = await this.prisma.$executeRaw(
        buildReaperQuery(staleBefore, OUTBOX_MAX_PUBLISH_ATTEMPTS, OUTBOX_RECLAIMED_ERROR),
      );
      if (reclaimed > 0) {
        this.logger.warn(`Reclaimed ${reclaimed} outbox row(s) from a stale in-flight lock`);
      }
      return reclaimed;
    } catch (cause) {
      this.logger.error(`Outbox reaper failed: ${describeError(cause)}`);
      return 0;
    } finally {
      this.reaping = false;
    }
  }

  /** Status histogram for the health endpoint; a growing DEAD count is a page-worthy signal. */
  async statusCounts(): Promise<Record<string, number>> {
    const rows =
      await this.prisma.$queryRaw<{ status: string; count: number }[]>(buildStatusCountQuery());
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = row.count;
    return counts;
  }

  private async claim(limit: number): Promise<ClaimedOutboxRow[]> {
    return this.prisma.$queryRaw<ClaimedOutboxRow[]>(buildClaimQuery(limit, this.workerId));
  }

  private toJob(row: ClaimedOutboxRow): BulkTaskEntry<typeof TASKS.OUTBOX_DISPATCH> {
    const payload: OutboxDispatchTask = {
      outboxId: row.id,
      topic: row.topic,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      payload: fromDbJsonObject(row.payload),
      attempt: row.attempts,
    };
    return {
      payload,
      options: {
        jobId: outboxJobId(row.id),
        attempts: DEFAULT_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: DEFAULT_JOB_BACKOFF_MS },
      },
    };
  }

  private async markSent(ids: readonly string[]): Promise<void> {
    await this.prisma.outboxMessage.updateMany({
      where: { id: { in: [...ids] } },
      data: { status: 'SENT', sentAt: new Date(), lockedAt: null, lockedBy: null, lastError: null },
    });
  }

  private async markPublishFailed(
    rows: readonly ClaimedOutboxRow[],
    error: string,
  ): Promise<{ failed: number; dead: number }> {
    const exhausted = rows.filter((row) => row.attempts >= OUTBOX_MAX_PUBLISH_ATTEMPTS);
    const retryable = rows.filter((row) => row.attempts < OUTBOX_MAX_PUBLISH_ATTEMPTS);

    if (exhausted.length > 0) {
      await this.prisma.outboxMessage.updateMany({
        where: { id: { in: exhausted.map((row) => row.id) } },
        data: { status: 'DEAD', lockedAt: null, lockedBy: null, lastError: error },
      });
      this.logger.error(
        `${exhausted.length} outbox row(s) exhausted ${OUTBOX_MAX_PUBLISH_ATTEMPTS} publish attempts and are DEAD`,
      );
    }

    // Rows in one batch usually share an attempt count, so this collapses to a single UPDATE.
    const byAttempts = new Map<number, string[]>();
    for (const row of retryable) {
      const bucket = byAttempts.get(row.attempts);
      if (bucket) bucket.push(row.id);
      else byAttempts.set(row.attempts, [row.id]);
    }

    for (const [attempts, ids] of byAttempts) {
      await this.prisma.outboxMessage.updateMany({
        where: { id: { in: ids } },
        data: {
          status: 'PENDING',
          lockedAt: null,
          lockedBy: null,
          lastError: error,
          availableAt: new Date(Date.now() + publishBackoffMs(attempts)),
        },
      });
    }

    return { failed: retryable.length, dead: exhausted.length };
  }
}
