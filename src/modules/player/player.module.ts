/**
 * WHY only two imports: PrismaModule, CacheModule, AuditModule and ActorContextModule are all
 * @Global, so PrismaService / LockService / AuditService arrive without being asked for. AuthModule
 * and IchancyModule are not global and provide things this module genuinely owns a dependency on.
 *
 * WHY PLAYER_LINK_PORT is aliased here: the credit worker lives in a different module and cannot
 * import this one (eslint-plugin-boundaries forbids modules/A -> modules/B, correctly). Binding the
 * implementation to a string token, and EXPORTING that token, is what lets another module inject it
 * without an import. See player-link.port.ts for the full reasoning and the proper fix.
 *
 * WHY the Telegram handlers are unconditional providers: TelegramHandlerRegistrar discovers them
 * through DiscoveryService and skips registration entirely in the api role, so listing them here
 * costs an api process one object construction and nothing else. Making the provider conditional
 * would mean two different DI graphs per role — and a handler that exists but is never registered
 * is the exact silent failure the registrar was built to prevent.
 *
 * WHY DiscoveryModule: /deposit has to call DepositService.create — a money write that must not be
 * reimplemented — and modules/player -> modules/deposit is a build failure (eslint-plugin-boundaries),
 * while importing DepositModule here would also break every graph that boots PlayerModule without
 * the three ports DepositService consumes (see src/modules/modules.int.spec.ts). PlayerTelegramHandlers
 * therefore locates that provider in the container at first use; DiscoveryModule is what makes
 * DiscoveryService injectable, exactly as TelegramModule imports it for the handler registrar.
 * It adds nothing to the graph in a process where DepositModule is absent — the lookup simply
 * returns null and /deposit says so.
 */
import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { AuthModule } from '@core/auth/auth.module';
import { IchancyModule } from '@core/ichancy/ichancy.module';

import { PlayerAuthController } from './controllers/player-auth.controller';
import { PlayerController } from './controllers/player.controller';
import { PlayerRepository } from './repositories/player.repository';
import { PlayerAccessService } from './services/player-access.service';
import { PlayerAuthService } from './services/player-auth.service';
import { PlayerLinkService } from './services/player-link.service';
import { PlayerService } from './services/player.service';
import { ReferralService } from './services/referral.service';
import { PlayerTelegramHandlers } from './telegram/player.handlers';
import { PLAYER_LINK_PORT } from './player-link.port';

@Module({
  imports: [AuthModule, IchancyModule, DiscoveryModule],
  controllers: [PlayerAuthController, PlayerController],
  providers: [
    PlayerRepository,
    PlayerService,
    PlayerAccessService,
    PlayerAuthService,
    PlayerLinkService,
    ReferralService,
    PlayerTelegramHandlers,
    { provide: PLAYER_LINK_PORT, useExisting: PlayerLinkService },
  ],
  exports: [
    PLAYER_LINK_PORT,
    PlayerLinkService,
    PlayerService,
    PlayerAccessService,
    PlayerRepository,
  ],
})
export class PlayerModule {}
