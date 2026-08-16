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
 * ActivityReportService is exported because /report's body is no longer owned by a Telegram
 * handler: anything that wants to render the SAME activity report on a schedule injects this
 * instead of growing a second copy that drifts on the next label change. ReportScheduleCron is that
 * scheduled sender.
 *
 * WHY TelegramModule is imported: ReportScheduleCron posts through BotService, and TelegramModule is
 * not @Global (CacheModule and LedgerModule are, which is why LockService, RedisService and the
 * ledger arrive unasked). Both real compositions — app.module.ts and worker.module.ts — already
 * import it, so this adds nothing to either process; it only makes this module's own dependency
 * honest instead of relying on a parent to have imported it.
 *
 * WHY ReportScheduleCron is an UNCONDITIONAL provider like the reconciliation crons: `@Interval`
 * only becomes behaviour where ScheduleModule is imported, and that is worker.module.ts alone. The
 * `config.app.isWorker` guard inside tick() is the belt to that braces.
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
import { TelegramModule } from '@core/telegram/telegram.module';

import { AdminApprovalLimitController } from './controllers/admin-approval-limit.controller';
import { AdminUserController } from './controllers/admin-user.controller';
import { AdminApprovalLimitRepository } from './repositories/admin-approval-limit.repository';
import { AdminUserRepository } from './repositories/admin-user.repository';
import { ActivityReportService } from './services/activity-report.service';
import { AdminApprovalLimitService } from './services/admin-approval-limit.service';
import { AdminUserService } from './services/admin-user.service';
import { ReportScheduleCron } from './services/report-schedule.cron';
import { AdminTelegramHandlers } from './telegram/admin.handlers';
import { APPROVAL_LIMIT_PORT } from './approval-limit.port';

@Module({
  imports: [AuthModule, IchancyModule, TelegramModule],
  controllers: [AdminUserController, AdminApprovalLimitController],
  providers: [
    AdminUserRepository,
    AdminApprovalLimitRepository,
    AdminUserService,
    AdminApprovalLimitService,
    ActivityReportService,
    ReportScheduleCron,
    AdminTelegramHandlers,
    { provide: APPROVAL_LIMIT_PORT, useExisting: AdminApprovalLimitService },
  ],
  exports: [
    APPROVAL_LIMIT_PORT,
    AdminApprovalLimitService,
    AdminUserService,
    AdminUserRepository,
    AdminApprovalLimitRepository,
    ActivityReportService,
  ],
})
export class AdminModule {}
