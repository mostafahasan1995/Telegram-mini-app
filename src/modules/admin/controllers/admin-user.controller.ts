/**
 * WHY writes are SUPER_ADMIN-only while reads also allow FINANCE_ADMIN: creating an admin, or
 * changing a role, is the one operation that can grant somebody the power to move money. Reading
 * the directory is not. `@AdminAuth()` lists the roles explicitly — SUPER_ADMIN is never implicitly
 * granted, so what the decorator says is the whole truth. PLATFORM_ADMIN passes both as the owner
 * superset (admin-authority.ts), which is what lets "Add me as an admin here" write into an operator
 * through X-Tenant-Id.
 *
 * WHY the writes take the whole principal and not just its id: which role the actor may GRANT
 * depends on who they are and where their row lives (admin-role-grant.ts), not only on the role list
 * the guard already checked.
 *
 * WHY there is no DELETE that deletes: `admin_users` is referenced by every deposit those people
 * decided, with onDelete: Restrict. A real delete would either fail or destroy the audit trail, so
 * DELETE deactivates — and says so in its own name at the service layer.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { AdminAuth } from '@common/decorators/auth.decorator';
import type { AuthenticatedAdmin } from '@common/decorators/auth.types';
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
import type { StaffTelegramLinkCodeView } from '../dtos/admin-telegram-link.dto';
import { AdminTelegramLinkService } from '../services/admin-telegram-link.service';
import { AdminUserService } from '../services/admin-user.service';

@Controller('v1/admin/admins')
export class AdminUserController {
  constructor(
    private readonly admins: AdminUserService,
    private readonly telegramLinks: AdminTelegramLinkService,
  ) {}

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
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Body() body: CreateAdminUserDto,
  ): Promise<AdminUserView> {
    return this.admins.create(actor, body);
  }

  @AdminAuth(...ADMIN_MANAGER_ROLES)
  @Patch(':id')
  update(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param() params: IdParamDto,
    @Body() body: UpdateAdminUserDto,
  ): Promise<AdminUserView> {
    return this.admins.update(actor, params.id, body);
  }

  /** Deactivates. See the file header for why this is not a real delete. */
  @AdminAuth(...ADMIN_MANAGER_ROLES)
  @Delete(':id')
  deactivate(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param() params: IdParamDto,
  ): Promise<AdminUserView> {
    return this.admins.deactivate(actor, params.id);
  }

  /**
   * A one-time code that links this staff account to the Telegram account that sends it to the
   * operator's bot. `@AdminAuth()` with no roles on purpose: every staff member may link their own
   * account, and AdminTelegramLinkService decides who else may ask (platform staff only). The code is
   * in this body and nowhere else, so the response must not be cached. Throttled per admin
   * (throttle-routes.ts `staff-telegram-link-code`).
   */
  @AdminAuth()
  @Post(':id/telegram-link-code')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  issueTelegramLinkCode(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param() params: IdParamDto,
  ): Promise<StaffTelegramLinkCodeView> {
    return this.telegramLinks.issueCode(actor, params.id);
  }

  /** Removes the account's Telegram link. Same reasoning for `@AdminAuth()` as above. */
  @AdminAuth()
  @Delete(':id/telegram-link')
  unlinkTelegram(
    @CurrentAdmin() actor: AuthenticatedAdmin,
    @Param() params: IdParamDto,
  ): Promise<AdminUserView> {
    return this.telegramLinks.unlink(actor, params.id);
  }
}
