/**
 * THE MISSING HALF OF THE TELEGRAM PIPELINE.
 *
 * `TelegramWebhookController` (api role) authenticates an update, persists it and enqueues it onto
 * `telegram-updates`. Until this class existed nothing consumed that queue: every button press in
 * the admin review group was accepted with a 200, written to `telegram_updates`, parked in Redis —
 * and never handled. Nothing errors in that state, which is exactly why it needs to be a real
 * provider rather than a convention.
 *
 * The contract (queue name, job name, payload shape) is owned by @core/telegram/telegram.constants;
 * this is the consumer side of it, and it is worker-only — see WorkerModule.
 *
 * WHOSE UPDATE: the job carries the tenant the webhook resolved from its path token. The update is
 * dispatched through THAT operator's Bot (TenantBotRegistry), inside `runWithTenant(tenantId)`, so
 * every handler, repository and audit row below reads the operator that actually received it.
 *
 * WHEN IT IS NOT DISPATCHED:
 *  - The job has no tenant. Only a job queued before ingress became per-operator can look like this.
 *    Guessing an operator for it is exactly the cross-tenant bug this pipeline exists to prevent, so
 *    the row is marked failed and the job fails without retries.
 *  - The operator no longer exists: nothing runs, the row records why, and the job completes.
 *  - The operator is not ACTIVE. The webhook already drops a SUSPENDED or CLOSED operator's updates
 *    without storing them, EXCEPT the chat projection's (TelegramChatProjectionService: the bot's
 *    membership in a group, a supergroup migration, a staff-group bind command). Those run through the
 *    projection only and are marked processed. Anything else, such as a job queued before the
 *    suspension landed, is not dispatched: the row records why and the job completes. Retrying would
 *    only replay old taps, money actions included, the moment the operator is reactivated.
 *  - The operator's bot cannot be used (TenantBotUnavailableError). The row records why. A cause
 *    retrying can fix (getMe timed out) is rethrown for BullMQ's backoff. A cause it cannot fix
 *    (token unset, unreadable, or rejected by Telegram) fails the job now with UnrecoverableError.
 *    Either way it is this operator's job that fails. The worker, and every other operator's
 *    updates, carry on.
 *
 * THE STAFF LINK RUNS NEXT, for an ACTIVE or SUSPENDED operator: a `/link <code>` is handed to
 * StaffTelegramLinkService and never reaches grammY, so no handler of a stopped operator runs and no
 * handler of a serving one sees a code. A CLOSED operator's `/link` is dropped like the rest.
 *
 * THE PROJECTION RUNS FOR EVERY OPERATOR, before dispatch. For an ACTIVE operator a bind command is
 * consumed there and never reaches grammY, whose player /start handler would otherwise register the
 * person who added the bot as a player. A projection failure (the database, a Telegram outage during a
 * bind check) is recorded and rethrown before anything is dispatched, so the retry is safe.
 *
 * WHY the job is acknowledged even when a handler misbehaves:
 * `TelegramHandlerRegistrar` wraps every handler and swallows its errors on purpose, because
 * replaying an update whose money side-effect already happened is precisely what the dedupe layer
 * exists to prevent. So anything that still escapes `handleUpdate()` is a grammY-level or transport
 * failure. We record it on the row (`markFailed`) and rethrow, letting BullMQ's retry policy have
 * its five attempts — the update is identified by a fixed jobId, so a retry can never fan out into
 * two deliveries.
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { TenantStatus } from '@prisma/client';
import { type Job, UnrecoverableError } from 'bullmq';
import { type Bot } from 'grammy';

import { ActorContextService } from '@core/actor-context/actor-context.service';

import { TenantRegistryService } from '../../tenant/services/tenant-registry.service';
import { runWithTenant } from '../../tenant/tenant.storage';
import {
  TelegramChatProjectionService,
  type ChatProjectionResult,
} from '../chat-binding/chat-projection.service';
import { TELEGRAM_CHAT_PROJECTION_HANDLER } from '../telegram-chat.constants';
import { STAFF_TELEGRAM_LINK_HANDLER } from '../staff-link/staff-link.constants';
import { StaffTelegramLinkService } from '../staff-link/staff-telegram-link.service';
import { TELEGRAM_UPDATE_JOB, TELEGRAM_UPDATE_QUEUE } from '../telegram.constants';
import { isTenantBotUnavailableError } from '../tenant-bot.errors';
import { type TelegramUpdateJobData } from '../telegram.types';
import { TenantBotRegistry } from '../services/tenant-bot-registry.service';
import { UpdateDedupeService } from '../services/update-dedupe.service';

/**
 * Modest on purpose. Handlers talk to Telegram (rate limited per chat) and to Postgres, and an
 * admin tapping "approve" twice in a second should be serialised by the per-deposit guards, not by
 * luck. Five in flight is plenty for a review group's traffic.
 */
const TELEGRAM_UPDATE_CONCURRENCY = 5;

@Injectable()
@Processor(TELEGRAM_UPDATE_QUEUE, { concurrency: TELEGRAM_UPDATE_CONCURRENCY })
export class TelegramUpdateProcessor extends WorkerHost {
  private readonly logger = new Logger(TelegramUpdateProcessor.name);

  /**
   * tenantId -> the reason already logged for not dispatching its updates. A stopped or broken
   * operator can have a long backlog, and one line per update would bury everything else. Cleared
   * as soon as one of its updates is dispatched again.
   */
  private readonly loggedSkips = new Map<string, string>();

  constructor(
    private readonly bots: TenantBotRegistry,
    private readonly dedupe: UpdateDedupeService,
    private readonly actorContext: ActorContextService,
    private readonly tenants: TenantRegistryService,
    private readonly projection: TelegramChatProjectionService,
    private readonly staffLinks: StaffTelegramLinkService,
  ) {
    super();
  }

  override async process(job: Job<TelegramUpdateJobData, void, string>): Promise<void> {
    if (job.name !== TELEGRAM_UPDATE_JOB) {
      // Not ours. Failing loudly beats silently dropping something another producer expected us to
      // handle — and there is no other producer on this queue today.
      throw new Error(`Unexpected job "${job.name}" on ${TELEGRAM_UPDATE_QUEUE}`);
    }

    const { tenantId, updateRowId, updateId } = job.data;

    // Typed as a string, but job data is JSON from Redis and older jobs predate the field.
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      const reason = `Telegram update ${updateId} has no tenant; it cannot be dispatched to a bot`;
      await this.recordFailure(updateRowId, reason);
      throw new UnrecoverableError(reason);
    }

    const tenant = await this.tenants.find(tenantId);
    if (tenant === null) {
      await this.dropUndispatched(tenantId, updateRowId, 'NOT_FOUND');
      return;
    }

    // Tenant outermost, as in the outbox dispatcher: everything below, including the audit rows the
    // actor context stamps, belongs to this operator. A bot handler that approves a deposit writes
    // audit rows and calls Ichancy; without an actor context those rows carry a null correlationId.
    // Tenant and update id together are stable across every retry, which makes them a useful key.
    await runWithTenant(tenantId, () =>
      this.actorContext.runAsSystem(
        () => this.handle(tenant.id, tenant.status, updateRowId, job.data),
        `tg-update-${tenantId}-${updateId}`,
      ),
    );
  }

  /** The projection for every operator, then dispatch for a serving one. See the file header. */
  private async handle(
    tenantId: string,
    status: TenantStatus,
    updateRowId: string,
    data: TelegramUpdateJobData,
  ): Promise<void> {
    let projection: ChatProjectionResult;
    try {
      projection = await this.projection.project(tenantId, data.update);
    } catch (error: unknown) {
      await this.recordFailure(updateRowId, error);
      throw error;
    }

    if (status !== TenantStatus.ACTIVE) {
      if (projection.relevant) {
        await this.dedupe.markProcessed(updateRowId, TELEGRAM_CHAT_PROJECTION_HANDLER);
        return;
      }
      if (status === TenantStatus.SUSPENDED && (await this.handledAsStaffLink(tenantId, updateRowId, data))) {
        return;
      }
      await this.dropUndispatched(tenantId, updateRowId, status);
      return;
    }

    if (projection.consumed) {
      await this.dedupe.markProcessed(updateRowId, TELEGRAM_CHAT_PROJECTION_HANDLER);
      return;
    }
    if (await this.handledAsStaffLink(tenantId, updateRowId, data)) return;
    await this.dispatch(tenantId, updateRowId, data);
  }

  /**
   * True when the update was a `/link` for this bot and the link flow handled it (see the header). A
   * database failure is recorded and rethrown before anything is dispatched, like a projection failure.
   */
  private async handledAsStaffLink(
    tenantId: string,
    updateRowId: string,
    data: TelegramUpdateJobData,
  ): Promise<boolean> {
    let consumed: boolean;
    try {
      consumed = (await this.staffLinks.handleUpdate(tenantId, data.update)).consumed;
    } catch (error: unknown) {
      await this.recordFailure(updateRowId, error);
      throw error;
    }
    if (consumed) await this.dedupe.markProcessed(updateRowId, STAFF_TELEGRAM_LINK_HANDLER);
    return consumed;
  }

  private async dropUndispatched(tenantId: string, updateRowId: string, status: string): Promise<void> {
    await this.recordFailure(
      updateRowId,
      `Tenant ${tenantId} is ${status}; the update was dropped without being dispatched`,
    );
    this.logSkipOnce(
      tenantId,
      status,
      `Dropping queued Telegram updates for tenant ${tenantId}: it is ${status}. ` +
        'Nothing is dispatched. Logged once per status.',
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<TelegramUpdateJobData> | undefined, error: Error): void {
    const unrecoverable = error instanceof UnrecoverableError;
    this.logger.error(
      `Telegram update ${job?.data?.updateId ?? '(unknown)'} for tenant ${
        job?.data?.tenantId ?? '(none)'
      } failed on attempt ${job?.attemptsMade ?? 0}${unrecoverable ? ' (not retried)' : ''}: ${
        error.message
      }`,
      // A refused job is an expected, already-explained outcome; its stack says nothing new.
      unrecoverable || isTenantBotUnavailableError(error) ? undefined : error.stack,
    );
  }

  private async dispatch(
    tenantId: string,
    updateRowId: string,
    data: TelegramUpdateJobData,
  ): Promise<void> {
    let bot: Bot;
    try {
      bot = await this.bots.get(tenantId);
    } catch (error: unknown) {
      if (!isTenantBotUnavailableError(error)) throw error;
      await this.recordFailure(updateRowId, `${error.code}: ${error.message}`);
      // The registry has already logged this operator's failure once; the job's own failure is
      // logged by onFailed.
      if (error.retryable) throw error;
      throw new UnrecoverableError(error.message);
    }

    this.loggedSkips.delete(tenantId);

    try {
      await bot.handleUpdate(data.update);
    } catch (error: unknown) {
      await this.recordFailure(updateRowId, error);
      throw error;
    }
    await this.dedupe.markProcessed(updateRowId, TelegramUpdateProcessor.name);
  }

  /**
   * Writes the reason onto the row. Never throws: it runs on paths that are already failing, and a
   * database error here must not replace the error that explains what actually went wrong.
   */
  private async recordFailure(updateRowId: string, reason: unknown): Promise<void> {
    await this.dedupe.markFailed(updateRowId, reason).catch((error: unknown) => {
      this.logger.warn(
        `Could not record the failure on telegram_updates row ${updateRowId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  private logSkipOnce(tenantId: string, reason: string, message: string): void {
    if (this.loggedSkips.get(tenantId) === reason) return;
    this.loggedSkips.set(tenantId, reason);
    this.logger.warn(message);
  }
}
