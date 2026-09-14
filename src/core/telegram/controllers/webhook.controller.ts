/**
 * WHY this endpoint does almost nothing: Telegram gives a webhook a short budget and retries
 * anything it does not get a prompt 200 for. Doing real work here — resolving a player, reading a
 * deposit, calling Ichancy — means slow responses, duplicate deliveries of the SAME approval, and
 * a bot that stalls whenever Postgres is busy. So the handler only: authenticates, persists once,
 * enqueues, returns. Everything else happens in the worker.
 *
 * WHY it almost never returns 4xx/5xx: a non-2xx tells Telegram to send the update again. That is
 * the right answer for "we failed to store it" and the WRONG answer for "this deposit was already
 * approved" — the latter would put Telegram in a retry loop over a decision that has already been
 * made. Business outcomes are therefore reported inside the bot conversation, never through the
 * HTTP status. The only rejections here are authentication ones.
 *
 * WHICH OPERATOR: every operator has its own bot, and Telegram allows one webhook URL per bot, so the
 * path token is what routes an update to its tenant. It is looked up on the unique
 * `tenants.webhook_path_token` column (cached), and the X-Telegram-Bot-Api-Secret-Token header is
 * compared against THAT tenant's secret, opened through TenantSecretService. No global bot token,
 * webhook secret or path token takes part.
 *
 * NO ENUMERATION: an unknown path token, a real token with a wrong or missing secret, and a real
 * token whose secret was never set all get the same 403, with the same code and the same message.
 * They also run the same code: one route lookup, one secret opened (a decoy sealed at construction
 * when there is no operator to open), and one constant-time comparison. The lookup caches misses
 * like hits, so an unknown token is not a cheaper or slower query than a known one.
 *
 * A SUSPENDED OR CLOSED OPERATOR: the dashboard contract does not say what its webhook does. It only
 * says a new operator "always lands SUSPENDED" and that activating "is a second, deliberate act"
 * (API-CONTRACT.md, tenants). Decided here: authenticate first, then answer 200 and drop the update,
 * storing no row, enqueueing no job, and logging once per operator and status. Why:
 *  - A non-2xx makes Telegram retry, growing `pending_update_count` and `last_error_message` for an
 *    operator that was stopped on purpose. That reads as an outage on the health panel.
 *  - Persisting or enqueueing would run bot handlers, including money actions, for an operator
 *    that must not take money, or replay hours-old taps the moment it is reactivated.
 *  - Dropping only AFTER the secret matches means nobody without the secret learns the status.
 * The status is read through TenantRegistryService.find, so a suspension bites as soon as the suspend
 * path invalidates it, and within its 30 s TTL otherwise.
 *
 * ORDERING IS SECURITY-RELEVANT: the credentials are checked before anything reads the body.
 * (Express has already parsed the JSON by the time a controller runs — moving the check earlier
 * than that needs middleware, which is out of this module's scope — but nothing in OUR code
 * inspects, stores or forwards the payload before the comparison succeeds.) The body-size cap and
 * the path-token redaction in logs are unchanged: this is still the single-segment route
 * `/telegram/webhook/:token`, and no log line here carries the token.
 */
import { randomBytes } from 'node:crypto';

import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { type Tenant, TenantStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { type Update } from 'grammy/types';
import { Public } from '@common/decorators/auth.decorator';
import { ForbiddenError } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';
import {
  TenantRegistryService,
  type TenantWebhookRoute,
} from '../../tenant/services/tenant-registry.service';
import {
  TenantSecretService,
  isTenantSecretError,
  type TenantSecretErrorCode,
} from '../../tenant/services/tenant-secret.service';
import {
  TELEGRAM_SECRET_HEADER,
  TELEGRAM_UPDATE_JOB,
  TELEGRAM_UPDATE_QUEUE,
  telegramUpdateJobId,
} from '../telegram.constants';
import { type TelegramUpdateJobData } from '../telegram.types';
import { UpdateDedupeService } from '../services/update-dedupe.service';
import { secureCompare } from '../utils/secure-compare.util';

interface WebhookAck {
  ok: true;
  deduped?: boolean;
}

/** What the comparison runs against. `tenantId` is null when the secret is the decoy. */
interface ExpectedSecret {
  tenantId: string | null;
  secret: string;
}

/** Never a real tenant id, so it cannot collide with one in a log line or an error. */
const DECOY_ID = 'webhook-decoy';

/** One refusal for every authentication failure, so no two of them can be told apart. */
const invalidCredentials = (): ForbiddenError =>
  // 403 is correct here and is NOT a business failure: whoever sent this is not Telegram.
  new ForbiddenError(
    CommonErrorCodes.TELEGRAM_WEBHOOK_SECRET_INVALID,
    'Invalid webhook credentials.',
  );

@Controller('telegram/webhook')
export class TelegramWebhookController {
  private readonly logger = new Logger(TelegramWebhookController.name);

  /**
   * A secret nobody knows, sealed once. It is opened whenever there is no real one to open, so an
   * unknown token costs the same AES-GCM open as a known one. The plaintext is random and thrown
   * away, so nothing compared against it can match.
   */
  private readonly decoy: Pick<Tenant, 'id' | 'webhookSecretEnc'>;

  /**
   * tenantId -> the non-ACTIVE status already logged. A stopped operator's bot can keep receiving
   * traffic for days, and one line per update would bury everything else. The entry is cleared when
   * the operator serves again, so a later suspension is logged afresh. It is bounded by the number
   * of operators, because only an authenticated call adds one.
   */
  private readonly loggedInactive = new Map<string, TenantStatus>();

  /** tenantId -> the secret error already logged. Same reasoning, and cleared once the secret opens. */
  private readonly loggedSecretErrors = new Map<string, TenantSecretErrorCode>();

  constructor(
    private readonly tenants: TenantRegistryService,
    private readonly secrets: TenantSecretService,
    private readonly dedupe: UpdateDedupeService,
    @InjectQueue(TELEGRAM_UPDATE_QUEUE)
    private readonly queue: Queue<TelegramUpdateJobData>,
  ) {
    this.decoy = {
      id: DECOY_ID,
      webhookSecretEnc: secrets.sealWebhookSecret(randomBytes(24).toString('base64url')),
    };
  }

  /**
   * The path token is part of the URL (`/telegram/webhook/<token>`) and selects the operator; the
   * secret header is the credential that proves the caller is Telegram delivering for that operator.
   * This route is unauthenticated by definition, so it is the one place where a comparison or lookup
   * oracle is directly reachable.
   */
  @Public()
  @Post(':token')
  @HttpCode(HttpStatus.OK)
  async receive(
    @Param('token') pathToken: string,
    @Headers(TELEGRAM_SECRET_HEADER) secretHeader: string | undefined,
    @Body() update: Update,
  ): Promise<WebhookAck> {
    const tenantId = await this.authenticate(pathToken, secretHeader);

    const tenant = await this.tenants.find(tenantId);
    if (tenant === null) {
      // The route cache outlived a deleted operator. There is nobody to deliver to, which is the
      // same situation as an unknown token, so it gets the same answer.
      throw invalidCredentials();
    }

    if (tenant.status !== TenantStatus.ACTIVE) {
      this.logInactiveOnce(tenant.id, tenant.status);
      return { ok: true };
    }
    this.loggedInactive.delete(tenant.id);

    // A body without an update_id cannot be deduplicated, so it cannot be processed safely.
    // Answering 200 keeps a malformed probe from turning into an infinite Telegram retry.
    if (typeof update?.update_id !== 'number') {
      this.logger.warn(
        `Received an authenticated webhook call for tenant ${tenant.id} with no update_id; ignoring`,
      );
      return { ok: true };
    }

    const recorded = await this.dedupe.record(tenant.id, update);
    if (!recorded.isNew || recorded.id === null) {
      return { ok: true, deduped: true };
    }

    try {
      await this.queue.add(
        TELEGRAM_UPDATE_JOB,
        {
          tenantId: tenant.id,
          updateRowId: recorded.id,
          updateId: String(update.update_id),
          update,
        },
        {
          // A second dedupe layer: even if the row and the Redis claim were both lost, BullMQ will
          // not create a second job with this id while the first is still known. Tenant-scoped,
          // because update ids are numbered per bot.
          jobId: telegramUpdateJobId(tenant.id, update.update_id),
          attempts: 5,
          backoff: { type: 'exponential', delay: 1_000 },
          removeOnComplete: 1_000,
          // Failures are kept much longer: a dropped update is invisible unless someone can see it.
          removeOnFail: 10_000,
        },
      );
    } catch (error: unknown) {
      // Undo the record so Telegram's retry is accepted rather than deduplicated away. Then let
      // the 500 through, because a retry is exactly what we want.
      await this.dedupe.rollback(tenant.id, recorded.id, update.update_id);
      this.logger.error(
        `Failed to enqueue update ${update.update_id} for tenant ${tenant.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }

    return { ok: true };
  }

  /** The tenant this call is authenticated for. Every failure throws the one refusal. */
  private async authenticate(pathToken: string, secretHeader: string | undefined): Promise<string> {
    const route = await this.tenants.findByWebhookPathToken(pathToken);
    const expected = this.expectedSecret(route);

    // Runs whether or not there is an operator, so a refusal for an unknown token does not come
    // back measurably earlier than a refusal for a wrong secret.
    const matches = secureCompare(secretHeader, expected.secret);
    if (expected.tenantId === null || !matches) {
      throw invalidCredentials();
    }
    return expected.tenantId;
  }

  /**
   * The secret to compare against: the operator's own, or the decoy when there is no operator or
   * its secret cannot be opened. Exactly one successful open happens on every path.
   */
  private expectedSecret(route: TenantWebhookRoute | null): ExpectedSecret {
    if (route !== null) {
      try {
        const secret = this.secrets.openWebhookSecret({
          id: route.tenantId,
          webhookSecretEnc: route.webhookSecretEnc,
        });
        this.loggedSecretErrors.delete(route.tenantId);
        return { tenantId: route.tenantId, secret };
      } catch (error: unknown) {
        if (!isTenantSecretError(error)) throw error;
        // Every delivery for this operator is refused until someone fixes the secret, so it must
        // be visible, but once. The message names the field and the tenant, never a value.
        this.logSecretErrorOnce(route.tenantId, error.code, error.message);
      }
    }
    return { tenantId: null, secret: this.secrets.openWebhookSecret(this.decoy) };
  }

  private logInactiveOnce(tenantId: string, status: TenantStatus): void {
    if (this.loggedInactive.get(tenantId) === status) return;
    this.loggedInactive.set(tenantId, status);
    this.logger.warn(
      `Dropping Telegram updates for tenant ${tenantId}: it is ${status}. Telegram is answered ` +
        '200 so it stops retrying; nothing is stored or processed. Logged once per status.',
    );
  }

  private logSecretErrorOnce(tenantId: string, code: TenantSecretErrorCode, message: string): void {
    if (this.loggedSecretErrors.get(tenantId) === code) return;
    this.loggedSecretErrors.set(tenantId, code);
    this.logger.error(
      `Refusing every webhook delivery for tenant ${tenantId} (${code}): ${message}. ` +
        'Logged once until the secret opens.',
    );
  }
}
