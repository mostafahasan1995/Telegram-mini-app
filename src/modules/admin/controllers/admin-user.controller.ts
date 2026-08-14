/**
 * WHY writes are SUPER_ADMIN-only while reads also allow FINANCE_ADMIN: creating an admin, or
 * changing a role, is the one operation that can grant somebody the power to move money. Reading
 * the directory is not. `@AdminAuth()` lists the roles explicitly — SUPER_ADMIN is never implicitly
 * granted, so what the decorator says is the whole truth.
 *
 * WHY there is no DELETE that deletes: `admin_users` is referenced by every deposit those people
 * decided, with onDelete: Restrict. A real delete would either fail or destroy the audit trail, so
 * DELETE deactivates — and says so in its own name at the service layer.
 */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { AdminAuth } from '@common/decorators/auth.decorator';
import { CurrentAdmin } from '@common/decorators/current-principal.decorator';
import { IdParamDto } from '@common/dtos/id-param.dto';
import type { PaginatedResult } from '@common/dtos/paginated.dto';

import { ADMIN_MANAGER_ROLES, ADMIN_READER_ROLES } from '../admin.constants';
import {
  CreateAdminUserDto,
  ListAdminUsersQueryDto,
  UpdateAdminUserDto,
  type AdminUserView,
} from '../dtos/admin-user.dto';
import { AdminUserService } from '../services/admin-user.service';

@Controller('v1/admin/admins')
export class AdminUserController {
  constructor(private readonly admins: AdminUserService) {}

  @AdminAuth(...ADMIN_READER_ROLES)
  @Get()
  list(@Query() query: ListAdminUsersQueryDto): Promise<PaginatedResult<AdminUserView>> {
    return this.admins.list(query);
  }

  @AdminAuth(...ADMIN_READER_ROLES)
  @Get(':id')
  get(@Param() params: IdParamDto): Promise<AdminUserView> {
    return this.admins.get(params.id);
  }

  @AdminAuth(...ADMIN_MANAGER_ROLES)
  @Post()
  create(
    @CurrentAdmin('adminUserId') actorAdminId: string,
    @Body() body: CreateAdminUserDto,
  ): Promise<AdminUserView> {
    return this.admins.create(actorAdminId, body);
  }

  @AdminAuth(...ADMIN_MANAGER_ROLES)
  @Patch(':id')
  update(
    @CurrentAdmin('adminUserId') actorAdminId: string,
    @Param() params: IdParamDto,
    @Body() body: UpdateAdminUserDto,
  ): Promise<AdminUserView> {
    return this.admins.update(actorAdminId, params.id, body);
  }

  /** Deactivates. See the file header for why this is not a real delete. */
  @AdminAuth(...ADMIN_MANAGER_ROLES)
  @Delete(':id')
  deactivate(
    @CurrentAdmin('adminUserId') actorAdminId: string,
    @Param() params: IdParamDto,
  ): Promise<AdminUserView> {
    return this.admins.deactivate(actorAdminId, params.id);
  }
}
