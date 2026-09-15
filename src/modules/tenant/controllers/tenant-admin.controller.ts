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
 * Nest's POST default of 201: suspend, activate, webhook registration and menu pushes change an
 * existing operator and create nothing.
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
} from '@nestjs/common';
import { AdminRole } from '@prisma/client';

import { AdminAuth } from '@common/decorators/auth.decorator';
import type { AuthenticatedAdmin } from '@common/decorators/auth.types';
import { CurrentAdmin } from '@common/decorators/current-principal.decorator';
import { Idempotent } from '@core/idempotency/idempotent.decorator';

import { CreateTenantDto } from '../dtos/create-tenant.dto';
import { ReplaceTenantBotDto } from '../dtos/replace-tenant-bot.dto';
import { TenantIdParamDto } from '../dtos/tenant-id-param.dto';
import { UpdateTenantDto } from '../dtos/update-tenant.dto';
import { TenantAdminService } from '../services/tenant-admin.service';
import { TenantCreationService } from '../services/tenant-creation.service';
import { TenantHealthService } from '../services/tenant-health.service';
import { TenantTelegramService } from '../services/tenant-telegram.service';
import type {
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

  @AdminAuth(AdminRole.PLATFORM_ADMIN)
  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @CurrentAdmin('adminUserId') actorAdminId: string,
    @Param() params: TenantIdParamDto,
  ): Promise<TenantView> {
    return this.tenants.activate(actorAdminId, params.id);
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
}
