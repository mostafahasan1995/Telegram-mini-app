/**
 * POST /v1/admin/tenants: a platform admin creates an operator from four fields.
 *
 * THE ORDER, and why nothing reaches Telegram or the database before the request is known to be good
 * (dashboard docs/TENANT-OPERATIONS.md §1 and API-CONTRACT.md "Tenants"):
 *  1. Resolve the defaults (utils/create-defaults.ts). A missing agent id is a 400 naming the field,
 *     before any other work. No staff group is needed: an operator is created without one and stays
 *     SUSPENDED until one is bound (owner decision, 2026-09-15).
 *  2. Check the currency exists and is active: it is a foreign key, and an unchecked one would fail
 *     as a 500 at insert.
 *  3. A slug the caller CHOSE that is taken is 409 DUPLICATE_RESOURCE `fields: ['slug']`. A derived
 *     one cannot collide: it is de-duplicated with -2, -3, ….
 *  4. getMe on the pasted token. A bad token never reaches the database, and its @username is
 *     recorded from Telegram's answer. A bot another operator already holds is 409
 *     DUPLICATE_RESOURCE naming botToken: provisioning's setWebhook would otherwise repoint that
 *     operator's live bot at this one. `bot_id` is unique, so a double submit loses at the insert
 *     with the same 409, before any Telegram call changes anything. A staff or feed chat named on the
 *     form is then verified with the same token (400 TELEGRAM_CHAT_REJECTED when Telegram says no).
 *  5. Seal the bot token and the Ichancy password; generate a 32-byte path token and a 24-byte
 *     secret, sealed.
 *  6. Insert the row SUSPENDED, with no staff, and audit it in the new operator's own log, in one
 *     transaction.
 *  7. provision() and answer 201 `{ ...TenantView, provisioning }`.
 *
 * TWO CREATES RACING FOR ONE DERIVED SLUG: both pick `acme`, one insert wins and the other hits the
 * unique index. The loser picks again from what now exists (`acme-2`), a bounded number of times.
 * A chosen slug is never re-picked: the caller asked for exactly that one.
 *
 * IDEMPOTENCY: the route is `@Idempotent('tenant.create', { required: false })`. The console sends no
 * key, so a key cannot be required, but a client that sends one gets the first answer replayed and
 * one operator, never two bots registered for one click.
 */
import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { TenantStatus } from '@prisma/client';
import type { UserFromGetMe } from 'grammy/types';

import type { AuthenticatedAdmin } from '@common/decorators/auth.types';
import { ConflictError, ValidationError } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';
import { adminActor } from '@common/types/actor.type';
import { AuditService } from '@core/audit/audit.service';
import { isUniqueConstraintError, mapPrismaError } from '@core/prisma/prisma-errors';
import { PrismaService } from '@core/prisma/prisma.service';
import { boundChatOf } from '@core/telegram/utils/chat-membership.util';
import { TenantRegistryService } from '@core/tenant/services/tenant-registry.service';
import {
  TenantSecretService,
  isTenantSecretError,
} from '@core/tenant/services/tenant-secret.service';
import { TENANT_ZERO_ID } from '@core/tenant/tenant.constants';
import { runWithTenant } from '@core/tenant/tenant.storage';

import type { CreateTenantDto } from '../dtos/create-tenant.dto';
import {
  SLUG_INSERT_ATTEMPTS,
  TenantAuditActions,
  WEBHOOK_PATH_TOKEN_BYTES,
  WEBHOOK_SECRET_BYTES,
} from '../tenant-admin.constants';
import { resolveCreateDefaults, type ResolvedTenantValues } from '../utils/create-defaults';
import { firstFreeSlug, slugify } from '../utils/slug';
import { botAlreadyAttached, isBotIdCollision, slugTaken } from '../utils/tenant-errors';
import type { TenantCreatedView } from '../views/tenant-operations.view';

import { PlatformDefaultsService } from './platform-defaults.service';
import { TenantAdminService } from './tenant-admin.service';
import { TenantProvisioningService } from './tenant-provisioning.service';
import { TenantTelegramService } from './tenant-telegram.service';

const TENANT_SUBJECT = 'Tenant';

interface SealedCredentials {
  botTokenEnc: string;
  ichancyPasswordEnc: string;
  webhookPathToken: string;
  webhookSecretEnc: string;
}

interface InsertInput {
  actorAdminId: string;
  chosenSlug: string | undefined;
  values: ResolvedTenantValues;
  defaulted: string[];
  botInfo: UserFromGetMe;
  credentials: SealedCredentials;
}

@Injectable()
export class TenantCreationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly platformDefaults: PlatformDefaultsService,
    private readonly secrets: TenantSecretService,
    private readonly registry: TenantRegistryService,
    private readonly telegram: TenantTelegramService,
    private readonly provisioning: TenantProvisioningService,
    private readonly tenants: TenantAdminService,
  ) {}

  async create(creator: AuthenticatedAdmin, dto: CreateTenantDto): Promise<TenantCreatedView> {
    const [defaults, tenantZero] = await Promise.all([
      this.platformDefaults.read(),
      this.prisma.tenant.findUnique({
        where: { id: TENANT_ZERO_ID },
        select: { ichancyAgentId: true },
      }),
    ]);

    const resolved = resolveCreateDefaults({
      dto,
      platformDefaults: defaults,
      tenantZeroAgentId: tenantZero?.ichancyAgentId ?? null,
    });
    if (!resolved.ok) throw new ValidationError(undefined, { fields: resolved.fields });

    await this.platformDefaults.assertCurrencyUsable(this.prisma, resolved.values.currencyCode);

    if (dto.slug !== undefined && (await this.slugsStartingWith(dto.slug)).has(dto.slug)) {
      throw slugTaken();
    }

    const botInfo = await this.telegram.verifyNewBotToken(dto.botToken);
    await this.telegram.assertBotUnattached(botInfo.id, null);
    // A staff or feed chat named on the form is bound only if Telegram verifies it, like every bind.
    const chats = await this.telegram.verifyChatsForNewBot(dto.botToken, botInfo.id, {
      adminChatId: resolved.values.adminChatId,
      feedChatId: resolved.values.feedChatId,
    });
    const credentials = this.sealCredentials(dto);

    const created = await this.insert({
      actorAdminId: creator.adminUserId,
      chosenSlug: dto.slug,
      values: { ...resolved.values, ...chats },
      defaulted: resolved.defaulted,
      botInfo,
      credentials,
    });

    // A miss for this token may have been cached by a probe before it existed; the route must find
    // the operator on Telegram's first delivery, not 30 seconds later.
    await this.registry.invalidateWebhookPathToken(credentials.webhookPathToken);

    const provisioning = await this.provisioning.provision(creator.adminUserId, created);
    const view = await this.tenants.get(created.id);
    return { ...view, provisioning };
  }

  private sealCredentials(dto: CreateTenantDto): SealedCredentials {
    let ichancyPasswordEnc: string;
    try {
      ichancyPasswordEnc = this.secrets.sealIchancyPassword(dto.ichancyPassword);
    } catch (error: unknown) {
      if (!isTenantSecretError(error)) throw error;
      // The secret service refuses to seal a value that reads as "never set" (REPLACE-ME…,
      // SEED-PLACEHOLDER…, UNUSED…), because every reader would then treat it as unconfigured.
      throw new ValidationError(undefined, {
        fields: ['ichancyPassword must be the real agent password, not a placeholder'],
      });
    }

    return {
      botTokenEnc: this.secrets.sealBotToken(dto.botToken),
      ichancyPasswordEnc,
      webhookPathToken: randomBytes(WEBHOOK_PATH_TOKEN_BYTES).toString('base64url'),
      webhookSecretEnc: this.secrets.sealWebhookSecret(
        randomBytes(WEBHOOK_SECRET_BYTES).toString('base64url'),
      ),
    };
  }

  private async insert(input: InsertInput): Promise<{ id: string; currencyCode: string }> {
    const base = slugify(input.values.displayName);

    for (let attempt = 1; ; attempt += 1) {
      const slug = input.chosenSlug ?? firstFreeSlug(base, await this.slugsStartingWith(base));
      try {
        return await this.prisma.runInTransaction(async (tx) => {
          const row = await tx.tenant.create({
            data: {
              ...input.values,
              slug,
              status: TenantStatus.SUSPENDED,
              botTokenEnc: input.credentials.botTokenEnc,
              botUsername: input.botInfo.username,
              botId: BigInt(input.botInfo.id),
              webhookPathToken: input.credentials.webhookPathToken,
              webhookSecretEnc: input.credentials.webhookSecretEnc,
              ichancyPasswordEnc: input.credentials.ichancyPasswordEnc,
            },
            select: { id: true, currencyCode: true },
          });

          await runWithTenant(row.id, () =>
            this.audit.write(tx, {
              action: TenantAuditActions.TENANT_CREATED,
              actor: adminActor(input.actorAdminId),
              subjectType: TENANT_SUBJECT,
              subjectId: row.id,
              after: auditSnapshot(slug, input.values, input.botInfo),
              // Which values the operator got from a default rather than the form: the question a
              // reviewer asks when a threshold is not what somebody remembers typing.
              metadata: { defaulted: input.defaulted, botId: String(input.botInfo.id) },
            }),
          );
          return row;
        });
      } catch (error: unknown) {
        if (isBotIdCollision(error)) throw botAlreadyAttached();
        if (!isSlugCollision(error)) throw error;
        if (input.chosenSlug !== undefined) throw slugTaken();
        if (attempt >= SLUG_INSERT_ATTEMPTS) {
          throw new ConflictError(
            CommonErrorCodes.WRITE_CONFLICT,
            'Other operators with this name were being created at the same moment. Try again.',
          );
        }
      }
    }
  }

  /** Every slug that `base` could collide with: itself and its -2, -3, … family. */
  private async slugsStartingWith(base: string): Promise<Set<string>> {
    const rows = await this.prisma.tenant.findMany({
      where: { slug: { startsWith: base } },
      select: { slug: true },
    });
    return new Set(rows.map((row) => row.slug));
  }
}

function isSlugCollision(error: unknown): boolean {
  const mapped = isUniqueConstraintError(error) ? error : mapPrismaError(error);
  if (!isUniqueConstraintError(mapped)) return false;
  return mapped.fields.includes('slug') || (mapped.constraint ?? '').includes('slug');
}

/** The non-secret half of the new row, as audit evidence. Ids and money as strings. */
function auditSnapshot(
  slug: string,
  values: ResolvedTenantValues,
  botInfo: UserFromGetMe,
): Record<string, unknown> {
  return {
    slug,
    displayName: values.displayName,
    status: TenantStatus.SUSPENDED,
    botUsername: botInfo.username,
    hasWebhookPath: true,
    adminChatId: boundChatOf(values.adminChatId)?.toString() ?? null,
    feedChatId: boundChatOf(values.feedChatId)?.toString() ?? null,
    ichancyBaseUrl: values.ichancyBaseUrl,
    ichancyUsername: values.ichancyUsername,
    ichancyAgentId: values.ichancyAgentId,
    currencyCode: values.currencyCode,
    dualApprovalThresholdMinor: values.dualApprovalThresholdMinor.toString(),
    agentFloatLowWatermarkMinor: values.agentFloatLowWatermarkMinor.toString(),
    depositExpiryMinutes: values.depositExpiryMinutes,
    depositMode: values.depositMode,
    withdrawalMode: values.withdrawalMode,
    miniAppUrl: values.miniAppUrl,
  };
}
