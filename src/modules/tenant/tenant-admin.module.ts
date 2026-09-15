/**
 * The platform surface: operators and the defaults new ones inherit.
 *
 * WHY IT IS NOT CALLED TenantModule: that name belongs to core/tenant, the @Global tenancy
 * infrastructure (context, registry, secrets). This module is the HTTP surface that manages the rows
 * that infrastructure reads, and the two must never be confused in an import.
 *
 * WHY AuthModule, TelegramModule AND IchancyModule ARE IMPORTED: suspending or activating an operator
 * or replacing its bot evicts InitDataService's derived mini-app key (AuthModule); every Telegram
 * operation here goes through TenantBotRegistry and TenantBotSetupService (TelegramModule); and
 * activation, the credential edit, the import and health reach the operator's own Ichancy agent
 * through ICHANCY_PORT and IchancySessionService (IchancyModule). None of the three is @Global.
 * AuditModule, PrismaModule, CacheModule, AppConfigModule and TenantModule are, which is why
 * AuditService, PrismaService, CacheService, LockService, AppConfigService, TenantRegistryService
 * and TenantSecretService arrive without being listed.
 *
 * PlatformDefaultsService is exported for anything else that must resolve defaults through the same
 * service the GET route reads, so the env seeding happens in one place.
 *
 * Imported by AppModule only. The worker serves no HTTP and never needs this surface.
 */
import { Module } from '@nestjs/common';

import { AuthModule } from '@core/auth/auth.module';
import { IchancyModule } from '@core/ichancy/ichancy.module';
import { TelegramModule } from '@core/telegram/telegram.module';

import { PlatformDefaultsController } from './controllers/platform-defaults.controller';
import { TenantAdminController } from './controllers/tenant-admin.controller';
import { PlatformDefaultsService } from './services/platform-defaults.service';
import { TenantAdminService } from './services/tenant-admin.service';
import { TenantCreationService } from './services/tenant-creation.service';
import { TenantHealthService } from './services/tenant-health.service';
import { TenantIchancyService } from './services/tenant-ichancy.service';
import { TenantProvisioningService } from './services/tenant-provisioning.service';
import { TenantTelegramService } from './services/tenant-telegram.service';
import { DEFAULT_PLAYER_IMPORT_LIMITS, TENANT_IMPORT_LIMITS } from './tenant-admin.constants';

@Module({
  imports: [AuthModule, TelegramModule, IchancyModule],
  controllers: [TenantAdminController, PlatformDefaultsController],
  providers: [
    // A provider only so a test can page a small agent; production always uses the defaults.
    { provide: TENANT_IMPORT_LIMITS, useValue: DEFAULT_PLAYER_IMPORT_LIMITS },
    TenantAdminService,
    PlatformDefaultsService,
    TenantTelegramService,
    TenantIchancyService,
    TenantProvisioningService,
    TenantCreationService,
    TenantHealthService,
  ],
  exports: [TenantAdminService, PlatformDefaultsService],
})
export class TenantAdminModule {}
