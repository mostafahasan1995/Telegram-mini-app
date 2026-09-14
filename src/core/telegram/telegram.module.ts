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
 *
 * WHY NO PROVIDER HERE BUILDS A BOT: every operator has its own bot token, sealed on its tenant row.
 * TenantBotRegistry builds an operator's Bot the first time that operator needs one. Constructing
 * this module therefore never talks to Telegram, and a process with zero operators, or with one
 * whose token Telegram rejects, boots all the same.
 *
 * WHY TenantModule IS IMPORTED HERE: the webhook controller resolves its operator through
 * TenantRegistryService and opens that operator's secret through TenantSecretService, and the
 * registry opens bot tokens the same way. TenantModule is @Global, but only AppModule imported it.
 * The worker and CLI graphs also load this module, and Nest instantiates controllers in an
 * application context too, so without this import neither graph would boot. Importing a global
 * module a second time does not create a second instance.
 */
import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import { AppConfigService } from '../config/config.service';
import { redisUrlToOptions } from '../cache/redis-url.util';
import { TenantModule } from '../tenant/tenant.module';
import { TelegramWebhookController } from './controllers/webhook.controller';
import { SetWebhookCommand } from './commands/set-webhook.command';
import { SetupBotCommand } from './commands/setup-bot.command';
import { BotService } from './services/bot.service';
import { TelegramHandlerRegistrar } from './services/handler-registrar.service';
import { TenantBotRegistry } from './services/tenant-bot-registry.service';
import { UpdateDedupeService } from './services/update-dedupe.service';
import { TELEGRAM_UPDATE_QUEUE } from './telegram.constants';

@Module({
  imports: [
    // Required by TelegramHandlerRegistrar to find @OnCommand/@OnCallback/@OnMessage methods.
    DiscoveryModule,
    TenantModule,
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
    TenantBotRegistry,
    BotService,
    UpdateDedupeService,
    TelegramHandlerRegistrar,
    SetWebhookCommand,
    SetupBotCommand,
  ],
  // BullModule is re-exported so a feature module importing TelegramModule can inject the same
  // queue with @InjectQueue(TELEGRAM_UPDATE_QUEUE) instead of registering a second one.
  exports: [TenantBotRegistry, BotService, UpdateDedupeService, BullModule],
})
export class TelegramModule {}
