/**
 * The platform surface: operators and the defaults new ones inherit.
 *
 * WHY IT IS NOT CALLED TenantModule: that name belongs to core/tenant, the @Global tenancy
 * infrastructure (context, registry, secrets). This module is the HTTP surface that manages the rows
 * that infrastructure reads, and the two must never be confused in an import.
 *
 * WHY AuthModule AND TelegramModule ARE IMPORTED: suspending an operator evicts InitDataService's
 * derived mini-app key (AuthModule) and TenantBotRegistry's built Bot (TelegramModule). Neither
 * module is @Global. AuditModule, PrismaModule, CacheModule, AppConfigModule and TenantModule are,
 * which is why AuditService, PrismaService, AppConfigService and TenantRegistryService arrive
 * without being listed.
 *
 * PlatformDefaultsService is exported for tenant creation, which must resolve its defaults through
 * the same service the GET route reads, so the env seeding happens in one place.
 *
 * Imported by AppModule only. The worker serves no HTTP and never needs this surface.
 */
import { Module } from '@nestjs/common';

import { AuthModule } from '@core/auth/auth.module';
import { TelegramModule } from '@core/telegram/telegram.module';

import { PlatformDefaultsController } from './controllers/platform-defaults.controller';
import { TenantAdminController } from './controllers/tenant-admin.controller';
import { PlatformDefaultsService } from './services/platform-defaults.service';
import { TenantAdminService } from './services/tenant-admin.service';

@Module({
  imports: [AuthModule, TelegramModule],
  controllers: [TenantAdminController, PlatformDefaultsController],
  providers: [TenantAdminService, PlatformDefaultsService],
  exports: [TenantAdminService, PlatformDefaultsService],
})
export class TenantAdminModule {}
