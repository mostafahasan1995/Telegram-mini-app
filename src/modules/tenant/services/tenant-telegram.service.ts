/**
 * Everything the platform surface asks of an operator's Telegram bot: verify a pasted token,
 * register and remove the webhook, push the command menus, replace the token, and report the bot
 * half of health.
 *
 * ══ EVERY CALL GOES THROUGH THE OPERATOR'S OWN BOT ══════════════════════════════════════════════
 * TenantBotRegistry builds the operator's Bot from its sealed token, and a token not stored yet is
 * verified through `identifyToken`, which uses the same client. Nothing here builds a grammY client
 * of its own, so no call can use the wrong operator's token, and in tests none reaches Telegram.
 *
 * ══ FAILURES ARE CONTRACT ERRORS, OR A BOOLEAN AND A SENTENCE ═══════════════════════════════════
 * The HTTP routes (POST/DELETE /webhook, POST /bot-setup, PATCH /bot) throw one of the tenant error
 * codes (utils/telegram-failure.ts), never a raw grammY error that would surface as a 500.
 * Provisioning calls the `…ForProvisioning` variants, which run the same code and turn any failure
 * into `{ false, sentence }`: a creation that already committed must answer 201 and say what did not
 * happen, not fail. The laptop is the ordinary case: API_BASE_URL is https://api.localhost, Telegram
 * refuses to deliver there, and the admin gets `webhookRegistered: false` with Telegram's reason.
 *
 * ══ WEBHOOK CREDENTIALS ═══════════════════════════════════════════════════════════════════════════
 * An operator created here already has a path token (32 CSPRNG bytes) and a sealed secret (24). A
 * legacy row does not: the multi-tenant migration inserted the bootstrap operator with neither, and a
 * row whose secret was sealed under another JWT_SECRET cannot be opened. Registering such an operator
 * generates whatever is missing or unusable, conditionally on the row being unchanged, audits it, and
 * evicts the webhook route cache, which holds the sealed secret keyed by path token. A path token
 * without a secret would make the ingress refuse every delivery with 403.
 *
 * ══ REPLACING THE BOT (PATCH /bot) ════════════════════════════════════════════════════════════════
 * The dashboard: "Replacing the token also drops the webhook: the new bot has never been told where
 * to deliver, and Telegram permits exactly one webhook URL per bot. The screen must send the operator
 * back through register webhook." So, in order:
 *  1. getMe on the new token. A token Telegram refuses is a 400 naming botToken and nothing changes.
 *     A bot another operator already holds is a 409 naming botToken, also before anything changes:
 *     step 5 would otherwise delete THAT operator's live webhook through the shared bot.
 *  2. deleteWebhook on the OLD bot, best effort. Left registered, the old bot would keep delivering
 *     into this operator's route with this operator's secret, and the worker would answer those
 *     players through the new bot.
 *  3. Store the sealed token and the new username, and ROTATE the webhook secret (the path token is
 *     kept, so `hasWebhookPath` stays true). Decided here, where the contract is silent: if step 2
 *     could not reach the old bot, the rotation is what still stops its deliveries from being
 *     accepted, and the secret has to be sent to Telegram again anyway at re-registration.
 *  4. Evict every cache holding the old token: the registry's Bot and identity, InitDataService's
 *     mini-app key, the tenant registry entry, and the route cache holding the old sealed secret.
 *  5. deleteWebhook on the NEW bot, best effort, so a bot whose token was merely regenerated at
 *     BotFather (same bot, still registered) also reads "not registered", as the console promises.
 * No re-registration is attempted: the console asks the admin for it, and it is one click.
 *
 * ══ ONE BOT, ONE OPERATOR ═════════════════════════════════════════════════════════════════════════
 * Telegram keeps one webhook per bot. A token pasted for a second operator would, at its first
 * setWebhook, repoint the first operator's live bot at the second's route: the first goes silent
 * and, once both are ACTIVE, its players are served in the wrong books. So create and replace both
 * refuse a bot another row holds (`assertBotUnattached`), and `tenants.bot_id` is unique, so two
 * requests racing with one token collide at the write instead of both landing. Rows written before
 * that column existed hold only a sealed token; they are checked by opening it.
 */
import { randomBytes } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import type { Bot } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';

import {
  BusinessRuleError,
  ConflictError,
  ServiceUnavailableError,
  ValidationError,
  isAppException,
} from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';
import { adminActor } from '@common/types/actor.type';
import { AuditService } from '@core/audit/audit.service';
import { InitDataService } from '@core/auth/services/init-data.service';
import { AppConfigService } from '@core/config/config.service';
import { PrismaService } from '@core/prisma/prisma.service';
import { botIdFromToken } from '@core/telegram/services/bot.factory';
import { TenantBotRegistry } from '@core/telegram/services/tenant-bot-registry.service';
import {
  TenantBotSetupService,
  type BotMenuPushResult,
} from '@core/telegram/services/tenant-bot-setup.service';
import { TELEGRAM_ALLOWED_UPDATES, telegramWebhookUrl } from '@core/telegram/telegram.constants';
import { TenantRegistryService } from '@core/tenant/services/tenant-registry.service';
import {
  TenantSecretService,
  isTenantSecretError,
  isTenantSecretSentinel,
} from '@core/tenant/services/tenant-secret.service';
import { TenantErrorCodes } from '@core/tenant/tenant-error-codes';
import { TENANT_ZERO_ID } from '@core/tenant/tenant.constants';
import { runWithTenant } from '@core/tenant/tenant.storage';

import {
  TenantAuditActions,
  WEBHOOK_PATH_TOKEN_BYTES,
  WEBHOOK_SECRET_BYTES,
} from '../tenant-admin.constants';
import { telegramFailure } from '../utils/telegram-failure';
import { botAlreadyAttached, isBotIdCollision, tenantNotFound } from '../utils/tenant-errors';
import {
  botHealthFromWebhookInfo,
  botHealthUnavailable,
  maskWebhookText,
  toWebhookView,
  type TenantBotHealthView,
  type TenantBotSetupView,
  type TenantWebhookView,
} from '../views/tenant-operations.view';

const TENANT_SUBJECT = 'Tenant';

const WEBHOOK_ROW_SELECT = { id: true, webhookPathToken: true, webhookSecretEnc: true } as const;

interface WebhookRow {
  id: string;
  webhookPathToken: string | null;
  webhookSecretEnc: string | null;
}

interface WebhookCredentials {
  pathToken: string;
  secret: string;
}

/** The operator columns the bot half of health reads. */
export interface BotHealthRow {
  id: string;
  botUsername: string | null;
  webhookPathToken: string | null;
}

/** One provisioning step's outcome: a boolean and a nullable sentence, never a tri-state. */
export interface StepOutcome {
  ok: boolean;
  error: string | null;
}

@Injectable()
export class TenantTelegramService {
  private readonly logger = new Logger(TenantTelegramService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly registry: TenantRegistryService,
    private readonly secrets: TenantSecretService,
    private readonly bots: TenantBotRegistry,
    private readonly setup: TenantBotSetupService,
    private readonly initData: InitDataService,
  ) {}

  /** Where this deployment expects Telegram to deliver an operator's updates. Unmasked: internal. */
  expectedWebhookUrl(pathToken: string): string {
    return telegramWebhookUrl(this.config.app.baseUrl, pathToken);
  }

  /**
   * getMe on a token that is not stored yet. A token Telegram refuses is a 400 VALIDATION_FAILED
   * naming botToken (dashboard TENANT-OPERATIONS.md §6, detail 5); a Telegram that cannot be asked
   * is a 503, because nothing about the token is known.
   */
  async verifyNewBotToken(token: string): Promise<UserFromGetMe> {
    const identity = await this.bots.identifyToken(token);
    if (identity.ok) return identity.botInfo;

    if (identity.rejected) {
      throw new ValidationError(undefined, {
        fields: [
          `botToken was not accepted by Telegram (${identity.reason}). Copy the token again from @BotFather.`,
        ],
      });
    }
    this.logger.warn(`Could not verify a bot token with Telegram: ${identity.reason}`);
    throw new ServiceUnavailableError(
      TenantErrorCodes.TENANT_TELEGRAM_UNREACHABLE,
      'Telegram could not be reached to verify the bot token. Nothing was saved; try again shortly.',
    );
  }

  /**
   * Refuses a bot that another operator already holds, as 409 DUPLICATE_RESOURCE naming botToken.
   * Called after getMe (the id is Telegram's, not parsed from input) and before any write or any
   * Telegram call that changes state. `exceptTenantId` is the operator being edited: re-pasting a
   * token regenerated at BotFather for its own bot is allowed.
   *
   * Two checks, because `bot_id` is null on rows written before the column existed:
   *  - rows with a `bot_id`: one indexed lookup;
   *  - rows without: their sealed tokens are opened and the id the token starts with compared.
   *    Placeholder and unreadable tokens hold no bot and are skipped. Every create and replace
   *    stores `bot_id`, so this set only shrinks. No request writes a legacy row's token any more,
   *    so the unique index covering only the first check leaves no race that matters.
   */
  async assertBotUnattached(botId: number, exceptTenantId: string | null): Promise<void> {
    const others = exceptTenantId === null ? {} : { NOT: { id: exceptTenantId } };

    const holder = await this.prisma.tenant.findFirst({
      where: { botId: BigInt(botId), ...others },
      select: { id: true },
    });
    if (holder !== null) throw botAlreadyAttached();

    const legacyRows = await this.prisma.tenant.findMany({
      where: { botId: null, ...others },
      select: { id: true, botTokenEnc: true },
    });
    const wanted = String(botId);
    for (const row of legacyRows) {
      if (isTenantSecretSentinel(row.botTokenEnc)) continue;
      let token: string;
      try {
        token = this.secrets.openBotToken(row);
      } catch (error: unknown) {
        if (!isTenantSecretError(error)) throw error;
        continue;
      }
      if (botIdFromToken(token) === wanted) throw botAlreadyAttached();
    }
  }

  // ── Webhook ────────────────────────────────────────────────────────────────────────────────────

  async registerWebhook(actorAdminId: string, tenantId: string): Promise<TenantWebhookView> {
    const { bot } = await this.registerOrThrow(actorAdminId, tenantId);
    const info = await this.call('read the webhook back', () => bot.api.getWebhookInfo());
    return toWebhookView(info);
  }

  /** The same registration, for provisioning: the masked URL on success, a sentence on failure. */
  async registerWebhookForProvisioning(
    actorAdminId: string,
    tenantId: string,
  ): Promise<StepOutcome & { url: string | null }> {
    try {
      const { url } = await this.registerOrThrow(actorAdminId, tenantId);
      return { ok: true, url: maskWebhookText(url), error: null };
    } catch (error: unknown) {
      return { ok: false, url: null, error: this.sentenceFor(error, tenantId, 'register the webhook') };
    }
  }

  /** Stops delivery. The operator's status is untouched: it keeps serving everything else. */
  async removeWebhook(actorAdminId: string, tenantId: string): Promise<TenantWebhookView> {
    await this.webhookRowOrThrow(tenantId);
    const bot = await this.botOrThrow(tenantId, 'remove the webhook');
    const removed = await this.call('remove the webhook', () => bot.api.deleteWebhook());
    if (!removed) throw notConfirmed('remove the webhook');

    await this.auditOnce(actorAdminId, tenantId, TenantAuditActions.TENANT_WEBHOOK_REMOVED, {
      webhookRegistered: false,
    });

    const info = await this.call('read the webhook back', () => bot.api.getWebhookInfo());
    return toWebhookView(info);
  }

  // ── Command menus ──────────────────────────────────────────────────────────────────────────────

  async pushMenus(actorAdminId: string, tenantId: string): Promise<TenantBotSetupView> {
    const result = await this.pushMenusOrThrow(actorAdminId, tenantId);
    return { commandsSet: result.commandsSet, scopes: result.scopes };
  }

  async pushMenusForProvisioning(
    actorAdminId: string,
    tenantId: string,
  ): Promise<StepOutcome & { scopes: string[] }> {
    try {
      const result = await this.pushMenusOrThrow(actorAdminId, tenantId);
      return { ok: true, scopes: result.scopes, error: null };
    } catch (error: unknown) {
      return {
        ok: false,
        scopes: [],
        error: this.sentenceFor(error, tenantId, 'push the command menus'),
      };
    }
  }

  // ── Replacing the bot ──────────────────────────────────────────────────────────────────────────

  /** See the file header for the order and why each step is there. */
  async replaceBot(actorAdminId: string, tenantId: string, token: string): Promise<void> {
    if (tenantId === TENANT_ZERO_ID) {
      throw new BusinessRuleError(
        TenantErrorCodes.TENANT_PLATFORM_LOCKED,
        'Tenant zero is the platform itself, not an operator, and has no Telegram bot to replace.',
      );
    }

    const current = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, botUsername: true, webhookPathToken: true },
    });
    if (current === null) throw tenantNotFound();

    const botInfo = await this.verifyNewBotToken(token);
    await this.assertBotUnattached(botInfo.id, tenantId);

    const previousWebhookCleared = await this.deleteWebhookQuietly(tenantId, 'previous');

    const sealedToken = this.secrets.sealBotToken(token);
    const pathToken =
      current.webhookPathToken !== null && current.webhookPathToken.length > 0
        ? current.webhookPathToken
        : null;
    const rotatedSecret =
      pathToken === null
        ? null
        : this.secrets.sealWebhookSecret(randomBytes(WEBHOOK_SECRET_BYTES).toString('base64url'));

    try {
      await this.writeReplacedBot(actorAdminId, current.botUsername, tenantId, {
        sealedToken,
        botInfo,
        rotatedSecret,
        previousWebhookCleared,
      });
    } catch (error: unknown) {
      // Another request attached this bot to another operator between the check and here. Only
      // this operator's OLD bot was touched (its webhook deleted), never the other operator's.
      if (isBotIdCollision(error)) throw botAlreadyAttached();
      throw error;
    }

    // After the commit, so no cache can be refilled from the old row in between.
    await this.bots.invalidate(tenantId);
    this.initData.invalidate(tenantId);
    await this.registry.invalidate(tenantId);
    if (pathToken !== null) await this.registry.invalidateWebhookPathToken(pathToken);

    await this.deleteWebhookQuietly(tenantId, 'new');
  }

  private async writeReplacedBot(
    actorAdminId: string,
    previousUsername: string | null,
    tenantId: string,
    input: {
      sealedToken: string;
      botInfo: UserFromGetMe;
      rotatedSecret: string | null;
      previousWebhookCleared: boolean;
    },
  ): Promise<void> {
    const { sealedToken, botInfo, rotatedSecret, previousWebhookCleared } = input;
    await this.prisma.runInTransaction(async (tx) => {
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          botTokenEnc: sealedToken,
          botUsername: botInfo.username,
          botId: BigInt(botInfo.id),
          ...(rotatedSecret === null ? {} : { webhookSecretEnc: rotatedSecret }),
        },
        select: { id: true },
      });
      await runWithTenant(tenantId, () =>
        this.audit.write(tx, {
          action: TenantAuditActions.TENANT_BOT_REPLACED,
          actor: adminActor(actorAdminId),
          subjectType: TENANT_SUBJECT,
          subjectId: tenantId,
          before: { botUsername: previousUsername },
          // The bot id is public (it is the bot's user id). The token is not, and is never here.
          after: { botUsername: botInfo.username, botId: String(botInfo.id) },
          metadata: { previousWebhookCleared, webhookSecretRotated: rotatedSecret !== null },
        }),
      );
    });
  }

  // ── Health ─────────────────────────────────────────────────────────────────────────────────────

  /**
   * getWebhookInfo through the operator's bot, compared with the URL this deployment expects. When
   * Telegram cannot be asked, the answer is `ok: false` with the reason, never an error: a health
   * check that throws is a screen that cannot show why an operator is dead.
   */
  async botHealth(row: BotHealthRow): Promise<TenantBotHealthView> {
    const expected =
      row.webhookPathToken === null || row.webhookPathToken.length === 0
        ? null
        : this.expectedWebhookUrl(row.webhookPathToken);
    try {
      const bot = await this.bots.get(row.id);
      const info = await bot.api.getWebhookInfo();
      return botHealthFromWebhookInfo(bot.botInfo.username, info, expected);
    } catch (error: unknown) {
      const failure = telegramFailure(error, 'check the webhook');
      if (failure === null) throw error;
      return botHealthUnavailable(row.botUsername, failure.message);
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────────────────────────

  /** Registers the webhook and audits it. Throws contract errors only. Returns the unmasked URL. */
  private async registerOrThrow(
    actorAdminId: string,
    tenantId: string,
  ): Promise<{ bot: Bot; url: string }> {
    const row = await this.webhookRowOrThrow(tenantId);
    this.assertHttpsBaseUrl();
    // The bot before the credentials: an operator with no working bot gets nothing written.
    const bot = await this.botOrThrow(tenantId, 'register the webhook');
    const credentials = await this.ensureWebhookCredentials(actorAdminId, row);
    const url = this.expectedWebhookUrl(credentials.pathToken);

    const accepted = await this.call('register the webhook', () =>
      bot.api.setWebhook(url, {
        secret_token: credentials.secret,
        allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
      }),
    );
    if (!accepted) throw notConfirmed('register the webhook');

    await this.auditOnce(actorAdminId, tenantId, TenantAuditActions.TENANT_WEBHOOK_REGISTERED, {
      webhookUrl: maskWebhookText(url),
      allowedUpdates: [...TELEGRAM_ALLOWED_UPDATES],
    });
    return { bot, url };
  }

  private async pushMenusOrThrow(
    actorAdminId: string,
    tenantId: string,
  ): Promise<BotMenuPushResult> {
    await this.webhookRowOrThrow(tenantId);
    // Asked first so an operator with no working bot gets the precise code, not a menu sentence.
    await this.botOrThrow(tenantId, 'push the command menus');

    const result = await this.setup.pushMenus(tenantId);
    if (result.fatalError !== null) {
      throw new BusinessRuleError(
        TenantErrorCodes.TENANT_TELEGRAM_REJECTED,
        `Telegram did not take the command menus: ${maskWebhookText(result.fatalError)}`,
      );
    }

    await this.auditOnce(actorAdminId, tenantId, TenantAuditActions.TENANT_BOT_MENUS_PUSHED, {
      commandsSet: result.commandsSet,
      scopes: result.scopes,
      warnings: result.warnings.length,
    });
    return result;
  }

  /**
   * The path token and the opened secret, generating whichever is missing or cannot be opened. The
   * write is conditional on the row still holding what was read, so two concurrent registrations
   * cannot each store a different secret while Telegram holds only one of them.
   */
  private async ensureWebhookCredentials(
    actorAdminId: string,
    row: WebhookRow,
  ): Promise<WebhookCredentials> {
    const existingPath =
      row.webhookPathToken !== null && row.webhookPathToken.length > 0 ? row.webhookPathToken : null;
    const existingSecret = this.openSecretOrNull(row);
    if (existingPath !== null && existingSecret !== null) {
      return { pathToken: existingPath, secret: existingSecret };
    }

    const pathToken = existingPath ?? randomBytes(WEBHOOK_PATH_TOKEN_BYTES).toString('base64url');
    const secret = existingSecret ?? randomBytes(WEBHOOK_SECRET_BYTES).toString('base64url');
    const sealedSecret =
      existingSecret === null ? this.secrets.sealWebhookSecret(secret) : row.webhookSecretEnc;

    const claimed = await this.prisma.runInTransaction(async (tx) => {
      const result = await tx.tenant.updateMany({
        where: {
          id: row.id,
          webhookPathToken: row.webhookPathToken,
          webhookSecretEnc: row.webhookSecretEnc,
        },
        data: { webhookPathToken: pathToken, webhookSecretEnc: sealedSecret },
      });
      if (result.count !== 1) return false;

      await runWithTenant(row.id, () =>
        this.audit.write(tx, {
          action: TenantAuditActions.TENANT_WEBHOOK_CREDENTIALS_GENERATED,
          actor: adminActor(actorAdminId),
          subjectType: TENANT_SUBJECT,
          subjectId: row.id,
          // Which were generated, never their values.
          before: { hasWebhookPath: existingPath !== null, hasUsableSecret: existingSecret !== null },
          after: { hasWebhookPath: true, hasUsableSecret: true },
          metadata: {
            pathTokenGenerated: existingPath === null,
            secretGenerated: existingSecret === null,
          },
        }),
      );
      return true;
    });
    if (!claimed) {
      throw new ConflictError(
        CommonErrorCodes.WRITE_CONFLICT,
        "This operator's webhook changed while it was being registered. Register it again.",
      );
    }

    // The route cache holds the sealed secret (and caches misses) by path token.
    await this.registry.invalidateWebhookPathToken(pathToken);
    return { pathToken, secret };
  }

  private openSecretOrNull(row: WebhookRow): string | null {
    try {
      return this.secrets.openWebhookSecret(row);
    } catch (error: unknown) {
      if (!isTenantSecretError(error)) throw error;
      return null;
    }
  }

  private assertHttpsBaseUrl(): void {
    if (this.config.app.baseUrl.startsWith('https://')) return;
    throw new BusinessRuleError(
      TenantErrorCodes.TENANT_WEBHOOK_URL_NOT_HTTPS,
      "This deployment's API_BASE_URL is not an https URL, and Telegram delivers webhooks only " +
        'over TLS. Set API_BASE_URL to the public https address of the API, then register the ' +
        'webhook again.',
    );
  }

  private async webhookRowOrThrow(tenantId: string): Promise<WebhookRow> {
    const row = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: WEBHOOK_ROW_SELECT,
    });
    if (row === null) throw tenantNotFound();
    return row;
  }

  private async botOrThrow(tenantId: string, action: string): Promise<Bot> {
    return this.call(action, () => this.bots.get(tenantId));
  }

  /** Runs one Telegram call, turning its failure into a contract error. */
  private async call<T>(action: string, invoke: () => Promise<T>): Promise<T> {
    try {
      return await invoke();
    } catch (error: unknown) {
      throw telegramFailure(error, action) ?? error;
    }
  }

  /**
   * deleteWebhook through whatever token the registry currently holds for the operator. Best effort:
   * a revoked token or an unreachable Telegram is logged and answered false. Anything that is not a
   * Telegram failure (the database) still throws.
   */
  private async deleteWebhookQuietly(tenantId: string, which: 'previous' | 'new'): Promise<boolean> {
    try {
      const bot = await this.bots.get(tenantId);
      return await bot.api.deleteWebhook();
    } catch (error: unknown) {
      const failure = telegramFailure(error, `remove the ${which} bot's webhook`);
      if (failure === null) throw error;
      this.logger.warn(`Tenant ${tenantId}: ${failure.message}`);
      return false;
    }
  }

  /** A provisioning step's failure as one sentence. Unexpected errors are logged, not echoed. */
  private sentenceFor(error: unknown, tenantId: string, action: string): string {
    if (isAppException(error)) return error.message;
    this.logger.error(
      `Tenant ${tenantId}: could not ${action}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return `Could not ${action}: an unexpected error occurred on this server. Try again from the operator's page.`;
  }

  private async auditOnce(
    actorAdminId: string,
    tenantId: string,
    action: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.runInTransaction((tx) =>
      runWithTenant(tenantId, () =>
        this.audit.write(tx, {
          action,
          actor: adminActor(actorAdminId),
          subjectType: TENANT_SUBJECT,
          subjectId: tenantId,
          after,
        }),
      ),
    );
  }
}

/** Telegram answered `false` instead of an error. It has never been observed; it is still not success. */
function notConfirmed(action: string): BusinessRuleError {
  return new BusinessRuleError(
    TenantErrorCodes.TENANT_TELEGRAM_REJECTED,
    `Telegram did not confirm the request to ${action}. Try again.`,
  );
}
