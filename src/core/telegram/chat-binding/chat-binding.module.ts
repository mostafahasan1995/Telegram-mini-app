/**
 * Binding an operator's staff and feed groups, and the update projection that feeds it.
 *
 * WHY A MODULE OF ITS OWN AND NOT PART OF TelegramModule: TelegramModule is loaded by every graph, the
 * CLI's included, and the CLI has no queues. The binding service enqueues the review cards of deposits
 * that were waiting for a staff group (TypedQueueService, from the @Global QueueModule), so it is
 * imported only where those exist: TenantAdminModule in the api, which serves the platform routes, and
 * WorkerModule, whose update processor runs the projection.
 *
 * PrismaService, AuditService and TypedQueueService come from @Global modules; BotService,
 * TenantBotSetupService and the chat directory and migration services from TelegramModule.
 */
import { Module } from '@nestjs/common';

import { TelegramModule } from '../telegram.module';

import { ChatBindingService } from './chat-binding.service';
import { TelegramChatProjectionService } from './chat-projection.service';

@Module({
  imports: [TelegramModule],
  providers: [ChatBindingService, TelegramChatProjectionService],
  exports: [ChatBindingService, TelegramChatProjectionService],
})
export class TelegramChatBindingModule {}
