/**
 * The smallest graph that can run an operational command. Deliberately NOT AppModule: a CLI that
 * boots the api graph would attach BullMQ producers, the outbox relay and every feature module just
 * to call setWebhook once — and `webhook:set` is run by a human during a deploy, often against
 * production, so the fewer things it wakes up the better.
 *
 * TelegramModule brings BotService and the SetWebhookCommand itself; PrismaModule and CacheModule
 * are here because TelegramModule's own providers need them (UpdateDedupeService writes rows, the
 * bot factory caches getMe in Redis).
 */
import { Module } from '@nestjs/common';

import { ActorContextModule } from '@core/actor-context/actor-context.module';
import { AuditModule } from '@core/audit/audit.module';
import { CacheModule } from '@core/cache/cache.module';
import { AppConfigModule } from '@core/config/config.module';
import { IchancyModule } from '@core/ichancy/ichancy.module';
import { PrismaModule } from '@core/prisma/prisma.module';
import { TelegramModule } from '@core/telegram/telegram.module';

import { PlayerModule } from '@modules/player/player.module';

@Module({
  /**
   * IchancyModule and PlayerModule are here for `ichancy:check` and `player:register`.
   *
   * WHY THAT IS STILL NOT AppModule: this graph has no HTTP server, no queue producers, no outbox
   * relay and no schedules — the three feature modules that would drag those in stay out. What it
   * gains is the ONE service that may register a player (PlayerLinkService, via PlayerModule) and
   * the session that talks to the agent API. AuditModule is explicit because linking writes a
   * `player.ichancy.linked` audit row; it is @Global, so this line documents rather than enables.
   */
  imports: [
    AppConfigModule,
    ActorContextModule,
    PrismaModule,
    CacheModule,
    AuditModule,
    TelegramModule,
    IchancyModule,
    PlayerModule,
  ],
})
export class CliModule {}
