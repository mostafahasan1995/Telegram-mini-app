/**
 * WHY the queue is registered here with an explicit connection rather than relying on a global
 * BullModule.forRoot(): this module is the PRODUCER side of the update pipeline and must work in
 * the api process whether or not the worker's queue infrastructure is present. Supplying
 * `connection` makes the registration self-sufficient; if a forRoot() is added later, these options
 * simply override it for this one queue.
 *
 * TELEGRAM_UPDATE_QUEUE / TELEGRAM_UPDATE_JOB are exported constants precisely because the consumer
 * lives in another module: the two sides must agree on the names, and a mismatch would look like
 * "updates are accepted but nothing ever happens" with no error to find.
 */
import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import { AppConfigService } from '../config/config.service';
import { CacheService } from '../cache/cache.service';
import { redisUrlToOptions } from '../cache/redis-url.util';
import { TelegramWebhookController } from './controllers/webhook.controller';
import { SetWebhookCommand } from './commands/set-webhook.command';
import { SetupBotCommand } from './commands/setup-bot.command';
import { BotService } from './services/bot.service';
import { createTelegramBot } from './services/bot.factory';
import { TelegramHandlerRegistrar } from './services/handler-registrar.service';
import { UpdateDedupeService } from './services/update-dedupe.service';
import { TELEGRAM_BOT, TELEGRAM_UPDATE_QUEUE } from './telegram.constants';

@Module({
  imports: [
    // Required by TelegramHandlerRegistrar to find @OnCommand/@OnCallback/@OnMessage methods.
    DiscoveryModule,
    BullModule.registerQueueAsync({
      name: TELEGRAM_UPDATE_QUEUE,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        connection: redisUrlToOptions(config.redis.url),
      }),
    }),
  ],
  controllers: [TelegramWebhookController],
  providers: [
    {
      provide: TELEGRAM_BOT,
      // Async because botInfo is resolved from Redis (or one getMe) before the Bot is constructed.
      useFactory: createTelegramBot,
      inject: [AppConfigService, CacheService],
    },
    BotService,
    UpdateDedupeService,
    TelegramHandlerRegistrar,
    SetWebhookCommand,
    SetupBotCommand,
  ],
  // BullModule is re-exported so a feature module importing TelegramModule can inject the same
  // queue with @InjectQueue(TELEGRAM_UPDATE_QUEUE) instead of registering a second one.
  exports: [TELEGRAM_BOT, BotService, UpdateDedupeService, BullModule],
})
export class TelegramModule {}
