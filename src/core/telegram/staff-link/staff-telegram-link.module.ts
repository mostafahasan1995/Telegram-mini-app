/**
 * Linking a staff account to a Telegram account with a one-time code.
 *
 * WHY A MODULE OF ITS OWN: the flow has two halves in two processes. The api issues and removes links
 * for the staff directory (AdminModule), and the worker's update processor redeems `/link` (WorkerModule).
 * Both need the same service. It needs AdminIdentityService, to evict a cached identity the moment a link
 * changes, and TelegramModule itself is loaded by the CLI graph, which has no reason to load AuthModule.
 *
 * PrismaService, AuditService, RedisService and TenantSecretService come from @Global modules; BotService
 * and TenantBotSetupService from TelegramModule.
 */
import { Module } from '@nestjs/common';

import { AuthModule } from '../../auth/auth.module';
import { TelegramModule } from '../telegram.module';

import { StaffTelegramLinkService } from './staff-telegram-link.service';

@Module({
  imports: [TelegramModule, AuthModule],
  providers: [StaffTelegramLinkService],
  exports: [StaffTelegramLinkService],
})
export class StaffTelegramLinkModule {}
