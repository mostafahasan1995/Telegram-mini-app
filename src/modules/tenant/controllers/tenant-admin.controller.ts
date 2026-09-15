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
 * suspend and activate answer 200, not Nest's POST default of 201: they change an existing row and
 * create nothing.
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { AdminRole } from '@prisma/client';

import { AdminAuth } from '@common/decorators/auth.decorator';
import { CurrentAdmin } from '@common/decorators/current-principal.decorator';

import { TenantIdParamDto } from '../dtos/tenant-id-param.dto';
import { UpdateTenantDto } from '../dtos/update-tenant.dto';
import { TenantAdminService } from '../services/tenant-admin.service';
import type { TenantView } from '../views/tenant.view';

@Controller('v1/admin/tenants')
export class TenantAdminController {
  constructor(private readonly tenants: TenantAdminService) {}

  /** `{ tenants: [...] }`, a wrapper object and not a bare array, as the console parses it. */
  @AdminAuth(AdminRole.PLATFORM_ADMIN)
  @Get()
  async list(): Promise<{ tenants: TenantView[] }> {
    return { tenants: await this.tenants.list() };
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
}
