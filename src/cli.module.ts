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
import { CacheModule } from '@core/cache/cache.module';
import { AppConfigModule } from '@core/config/config.module';
import { PrismaModule } from '@core/prisma/prisma.module';
import { TelegramModule } from '@core/telegram/telegram.module';

@Module({
  imports: [AppConfigModule, ActorContextModule, PrismaModule, CacheModule, TelegramModule],
})
export class CliModule {}
