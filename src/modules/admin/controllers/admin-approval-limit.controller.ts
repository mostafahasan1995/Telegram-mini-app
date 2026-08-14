/**
 * WHY setting a limit is a POST and not a PUT/PATCH: it does not modify a row, it creates a new
 * VERSION and closes the previous one (see AdminApprovalLimitRepository for why history is never
 * rewritten). POST to a collection is the honest verb for "add the version that applies from now".
 *
 * The `:adminUserId` in the path is validated as a uuid via IdParamDto's shape, reused through a
 * dedicated param class so the field is named for what it is.
 */
import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { IsUUID } from 'class-validator';

import { AdminAuth } from '@common/decorators/auth.decorator';
import { CurrentAdmin } from '@common/decorators/current-principal.decorator';
import { IdParamDto } from '@common/dtos/id-param.dto';

import { ADMIN_MANAGER_ROLES, ADMIN_READER_ROLES } from '../admin.constants';
import { SetApprovalLimitDto, type ApprovalLimitView } from '../dtos/approval-limit.dto';
import { AdminApprovalLimitService } from '../services/admin-approval-limit.service';

class AdminUserIdParamDto {
  @IsUUID(undefined, { message: 'adminUserId must be a UUID' })
  adminUserId: string;
}

@Controller('v1/admin')
export class AdminApprovalLimitController {
  constructor(private readonly limits: AdminApprovalLimitService) {}

  /** Full history, newest first — an old decision must stay explicable by an old limit. */
  @AdminAuth(...ADMIN_READER_ROLES)
  @Get('admins/:adminUserId/approval-limits')
  list(@Param() params: AdminUserIdParamDto): Promise<ApprovalLimitView[]> {
    return this.limits.listForAdmin(params.adminUserId);
  }

  @AdminAuth(...ADMIN_MANAGER_ROLES)
  @Post('admins/:adminUserId/approval-limits')
  set(
    @CurrentAdmin('adminUserId') actorAdminId: string,
    @Param() params: AdminUserIdParamDto,
    @Body() body: SetApprovalLimitDto,
  ): Promise<ApprovalLimitView> {
    return this.limits.setLimit(actorAdminId, params.adminUserId, body);
  }

  /**
   * Ends a version without replacing it. The admin is then left with NO active limit, which the
   * evaluator treats as DENIED — this revokes authority, it does not grant it.
   */
  @AdminAuth(...ADMIN_MANAGER_ROLES)
  @Delete('approval-limits/:id')
  end(
    @CurrentAdmin('adminUserId') actorAdminId: string,
    @Param() params: IdParamDto,
  ): Promise<ApprovalLimitView> {
    return this.limits.endLimit(actorAdminId, params.id);
  }
}
