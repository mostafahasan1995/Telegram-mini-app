/**
 * `/v1/admin/tenants`: PLATFORM_ADMIN only, like every route on this surface
 * (manager-account-dashboard docs/API-CONTRACT.md, "Tenants — /v1/admin/tenants (PLATFORM_ADMIN
 * only)"). No other role is listed, so an operator's SUPER_ADMIN gets 403 INSUFFICIENT_ROLE: reading
 * or suspending another operator is the platform's job and nobody else's.
 *
 * Every route names its operator in the path, never through X-Tenant-Id. A platform admin who has
 * the console pointed at operator Y and edits operator X is editing X, and the service writes X's
 * audit row in X's log regardless of where the request's context points.
 *
 * Status codes: create answers 201 (it creates the operator). Every other POST answers 200, not
 * Nest's POST default of 201: suspend, activate, webhook registration, menu pushes, the import and a
 * bind link change an existing operator and create no resource the client addresses.
 *
 * The staff and feed group routes (`/:id/telegram/...`) are PLATFORM_ADMIN only too: owner decision 3
 * (2026-09-15) is that only the platform binds or changes an operator's groups. See
 * TenantTelegramChatsService.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { AdminRole } from '@prisma/client';

import { AdminAuth } from '@common/decorators/auth.decorator';
import type { AuthenticatedAdmin } from '@common/decorators/auth.types';
import { CurrentAdmin } from '@common/decorators/current-principal.decorator';
import { Idempotent } from '@core/idempotency/idempotent.decorator';

import { CreateTenantDto } from '../dtos/create-tenant.dto';
import { ReplaceTenantBotDto } from '../dtos/replace-tenant-bot.dto';
import {
  BindTelegramChatDto,
  IssueBindLinkDto,
  TenantChatPurposeParamDto,
} from '../dtos/telegram-chat.dto';
import { TenantIdParamDto } from '../dtos/tenant-id-param.dto';
import { UpdateTenantIchancyDto } from '../dtos/update-tenant-ichancy.dto';
import { UpdateTenantDto } from '../dtos/update-tenant.dto';
import { TenantAdminService } from '../services/tenant-admin.service';
import { TenantCreationService } from '../services/tenant-creation.service';
import { TenantHealthService } from '../services/tenant-health.service';
import { TenantIchancyService } from '../services/tenant-ichancy.service';
import { TenantTelegramChatsService } from '../services/tenant-telegram-chats.service';
import { TenantTelegramService } from '../services/tenant-telegram.service';
import type { DiscoveredChatView, TelegramBindLinkView } from '../views/tenant-chats.view';
import type {
  PlayerImportSummaryView,
  TenantBotSetupView,
  TenantCreatedView,
  TenantHealthView,
  TenantWebhookView,
} from '../views/tenant-operations.view';
import type { TenantView } from '../views/tenant.view';

@Controller('v1/admin/tenants')
export class TenantAdminController {
  constructor(
    private readonly tenants: TenantAdminService,
    private readonly creation: TenantCreationService,
    private readonly telegram: TenantTelegramService,
    private readonly healthChecks: TenantHealthService,
    private readonly ichancy: TenantIchancyService,
    private readonly chats: TenantTelegramChatsService,
  ) {}

  /** `{ tenants: [...] }`, a wrapper object and not a bare array, as the console parses it. */
  @AdminAuth(AdminRole.PLATFORM_ADMIN)
  @Get()
  async list(): Promise<{ tenants: TenantView[] }> {
    return { tenants: await this.tenants.list() };
  }

  /**
   * 201 `{ ...TenantView, provisioning }`. The Idempotency-Key header is honoured but not required:
   * the console sends none, and refusing its creates would break the one flow this route exists for.
   */
  @AdminAuth(AdminRole.PLATFORM_ADMIN)
  @Post()
  @Idempotent('tenant.create', { required: false })
  create(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body() body: CreateTenantDto,
  ): Promise<TenantCreatedView> {
    return this.creation.create(admin, body);
  }

  @AdminAuth(AdminRole.PLATFORM_ADMIN)
  @Get(':id')
  get(@Param() params: TenantIdParamDto): Promise<TenantView> {
    return this.tenants.get(params.id);
  }

  @AdminAuth(AdminRole.PLATFORM_ADMIN)
  @Patch(':id')
  update(
    @CurrentAdmin('adminUserId') actorAdminId: string,
    @Param() params: TenantIdParamDto,
    @Body() body: UpdateTenantDto,
  ): Promise<TenantView> {
    return this.tenants.update(actorAdminId, params.id, body);
  }

  @AdminAuth(AdminRole.PLATFORM_ADMIN)
  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  suspend(
    @CurrentAdmin('adminUserId') actorAdminId: string,
    @Param() params: TenantIdParamDto,
  ): Promise<TenantView> {
    return this.tenants.suspend(actorAdminId, params.id);
  }

  /** A real Ichancy sign-in with the operator's own credentials; SUSPENDED -> ACTIVE only if accepted. */
  @AdminAuth(AdminRole.PLATFORM_ADMIN)
  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @CurrentAdmin('adminUserId') actorAdminId: string,
    @Param() params: TenantIdParamDto,
  ): Promise<TenantView> {
    return this.ichancy.activate(actorAdminId, params.id);
  }

  /** Tells Telegram where to deliver, generating a legacy row's path token and secret if needed. */
  @AdminAuth(AdminRole.PLATFORM_ADMIN)
  @Post(':id/webhook')
  @HttpCode(HttpStatus.OK)
  registerWebhook(
    @CurrentAdmin('adminUserId') actorAdminId: string,
    @Param() params: TenantIdParamDto,
  ): Promise<TenantWebhookView> {
    return this.telegram.registerWebhook(actorAdminId, params.id);
  }

  /** Stops delivery; the operator keeps its status. */
  @AdminAuth(AdminRole.PLATFORM_ADMIN)
  @Delete(':id/webhook')
  removeWebhook(
    @CurrentAdmin('adminUserId') actorAdminId: string,
    @Param() params: TenantIdParamDto,
  ): Promise<TenantWebhookView> {
    return this.telegram.removeWebhook(actorAdminId, params.id);
  }

  @AdminAuth(AdminRole.PLATFORM_ADMIN)
  @Post(':id/bot-setup')
  @HttpCode(HttpStatus.OK)
  setupBot(
    @CurrentAdmin('adminUserId') actorAdminId: string,
    @Param() params: TenantIdParamDto,
  ): Promise<TenantBotSetupView> {
    return this.telegram.pushMenus(actorAdminId, params.id);
  }

  @AdminAuth(AdminRole.PLATFORM_ADMIN)
  @Get(':id/health')
  health(@Param() params: TenantIdParamDto): Promise<TenantHealthView> {
    return this.healthChecks.health(params.id);
  }

  /** Only the fields that change; verified with a real sign-in before anything is saved. */
  @AdminAuth(AdminRole.PLATFORM_ADMIN)
  @Patch(':id/ichancy')
  updateIchancy(
    @CurrentAdmin('adminUserId') actorAdminId: string,
    @Param() params: TenantIdParamDto,
    @Body() body: UpdateTenantIchancyDto,
  ): Promise<TenantView> {
    return this.ichancy.updateIchancy(actorAdminId, params.id, body);
  }

  /** Verified with getMe before it is sealed; the webhook must be registered again afterwards. */
  @AdminAuth(AdminRole.PLATFORM_ADMIN)
  @Patch(':id/bot')
  async replaceBot(
    @CurrentAdmin('adminUserId') actorAdminId: string,
    @Param() params: TenantIdParamDto,
    @Body() body: ReplaceTenantBotDto,
  ): Promise<TenantView> {
    await this.telegram.replaceBot(actorAdminId, params.id, body.botToken);
    return this.tenants.get(params.id);
  }

  /**
   * A one-time "Add bot to group" link for the staff or feed group. Issuing one revokes the previous
   * link for the same purpose. The nonce is in `url` only.
   */
  @AdminAuth(AdminRole.PLATFORM_ADMIN)
  @Post(':id/telegram/bind-links')
  @HttpCode(HttpStatus.OK)
  issueBindLink(
    @CurrentAdmin('adminUserId') actorAdminId: string,
    @Param() params: TenantIdParamDto,
    @Body() body: IssueBindLinkDto,
  ): Promise<TelegramBindLinkView> {
    return this.chats.issueBindLink(actorAdminId, params.id, body.purpose);
  }

  /** The groups and channels this operator's bot was seen in, most recent first, removals included. */
  @AdminAuth(AdminRole.PLATFORM_ADMIN)
  @Get(':id/telegram/chats')
  listChats(@Param() params: TenantIdParamDto): Promise<DiscoveredChatView[]> {
    return this.chats.listChats(params.id);
  }

  /** Binds a group as the staff or feed group after Telegram verifies it. Answers the TenantView. */
  @AdminAuth(AdminRole.PLATFORM_ADMIN)
  @Put(':id/telegram/chats/:purpose')
  async bindChat(
    @CurrentAdmin('adminUserId') actorAdminId: string,
    @Param() params: TenantChatPurposeParamDto,
    @Body() body: BindTelegramChatDto,
  ): Promise<TenantView> {
    await this.chats.bind(actorAdminId, params.id, params.purpose, BigInt(body.chatId));
    return this.tenants.get(params.id);
  }

  /** Removes the staff or feed group. The staff group of an ACTIVE operator is refused. */
  @AdminAuth(AdminRole.PLATFORM_ADMIN)
  @Delete(':id/telegram/chats/:purpose')
  async unbindChat(
    @CurrentAdmin('adminUserId') actorAdminId: string,
    @Param() params: TenantChatPurposeParamDto,
  ): Promise<TenantView> {
    await this.chats.unbind(actorAdminId, params.id, params.purpose);
    return this.tenants.get(params.id);
  }

  /**
   * The "old players", again. 200 with a PlayerImportSummary even when Ichancy failed part-way (the
   * failure is in `error`); 409 IMPORT_ALREADY_RUNNING while another import of this operator runs.
   */
  @AdminAuth(AdminRole.PLATFORM_ADMIN)
  @Post(':id/import-players')
  @HttpCode(HttpStatus.OK)
  importPlayers(
    @CurrentAdmin('adminUserId') actorAdminId: string,
    @Param() params: TenantIdParamDto,
  ): Promise<PlayerImportSummaryView> {
    return this.ichancy.importPlayers(actorAdminId, params.id);
  }
}
