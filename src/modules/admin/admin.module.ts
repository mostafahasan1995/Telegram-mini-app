/**
 * WHY AuthModule is imported: AdminUserService invalidates AdminIdentityService's 60-second cache
 * whenever a role or the active flag changes. Without that call a revoked admin keeps their powers
 * for up to a minute — so the dependency is deliberate, not incidental.
 *
 * AdminApprovalLimitService is exported because the deposit approval path needs `evaluate()`. That
 * path lives in another module and therefore cannot import this one directly
 * (eslint-plugin-boundaries); see the manifest for the same port-token pattern used by
 * PLAYER_LINK_PORT, which is the supported way to consume it across a module boundary.
 *
 * WHY IchancyModule is imported: AdminTelegramHandlers reads the live agent wallet for /float
 * through ICHANCY_PORT. The module is not @Global, so the token has to be brought in here; the
 * ledger side of the same command arrives through @Global LedgerModule.
 *
 * WHY AdminTelegramHandlers is an UNCONDITIONAL provider, exactly as PlayerModule registers
 * PlayerTelegramHandlers: TelegramHandlerRegistrar discovers handlers via DiscoveryService and
 * skips registration entirely in the api role, so listing it here costs an api process one object
 * construction. A conditional provider would mean two different DI graphs per role — and a handler
 * that exists but is never registered is the silent failure the registrar exists to prevent.
 */
import { Module } from '@nestjs/common';

import { AuthModule } from '@core/auth/auth.module';
import { IchancyModule } from '@core/ichancy/ichancy.module';

import { AdminApprovalLimitController } from './controllers/admin-approval-limit.controller';
import { AdminUserController } from './controllers/admin-user.controller';
import { AdminApprovalLimitRepository } from './repositories/admin-approval-limit.repository';
import { AdminUserRepository } from './repositories/admin-user.repository';
import { AdminApprovalLimitService } from './services/admin-approval-limit.service';
import { AdminUserService } from './services/admin-user.service';
import { AdminTelegramHandlers } from './telegram/admin.handlers';
import { APPROVAL_LIMIT_PORT } from './approval-limit.port';

@Module({
  imports: [AuthModule, IchancyModule],
  controllers: [AdminUserController, AdminApprovalLimitController],
  providers: [
    AdminUserRepository,
    AdminApprovalLimitRepository,
    AdminUserService,
    AdminApprovalLimitService,
    AdminTelegramHandlers,
    { provide: APPROVAL_LIMIT_PORT, useExisting: AdminApprovalLimitService },
  ],
  exports: [
    APPROVAL_LIMIT_PORT,
    AdminApprovalLimitService,
    AdminUserService,
    AdminUserRepository,
    AdminApprovalLimitRepository,
  ],
})
export class AdminModule {}
