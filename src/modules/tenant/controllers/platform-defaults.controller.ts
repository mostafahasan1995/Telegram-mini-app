/**
 * `/v1/admin/platform-defaults`: one row, no collection, no id. PLATFORM_ADMIN only: this row sets
 * the terms every new operator inherits, so an operator's own owner editing it would be setting them
 * for their competitors too.
 */
import { Body, Controller, Get, Patch } from '@nestjs/common';
import { AdminRole } from '@prisma/client';

import { AdminAuth } from '@common/decorators/auth.decorator';
import { CurrentAdmin } from '@common/decorators/current-principal.decorator';

import { UpdatePlatformDefaultsDto } from '../dtos/update-platform-defaults.dto';
import { PlatformDefaultsService } from '../services/platform-defaults.service';
import type { PlatformDefaultsView } from '../views/platform-defaults.view';

@Controller('v1/admin/platform-defaults')
export class PlatformDefaultsController {
  constructor(private readonly defaults: PlatformDefaultsService) {}

  @AdminAuth(AdminRole.PLATFORM_ADMIN)
  @Get()
  get(): Promise<PlatformDefaultsView> {
    return this.defaults.view();
  }

  @AdminAuth(AdminRole.PLATFORM_ADMIN)
  @Patch()
  update(
    @CurrentAdmin('adminUserId') actorAdminId: string,
    @Body() body: UpdatePlatformDefaultsDto,
  ): Promise<PlatformDefaultsView> {
    return this.defaults.update(actorAdminId, body);
  }
}
