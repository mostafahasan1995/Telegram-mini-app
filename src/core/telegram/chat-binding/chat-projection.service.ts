/**
 * The part of an inbound update that is about the operator's CHATS rather than its players, run by the
 * update processor before (and, for a SUSPENDED or CLOSED operator, instead of) grammY dispatch:
 *  - `my_chat_member` in a group or channel: recorded in the chat directory;
 *  - a group becoming a supergroup (`migrate_to_chat_id` / `migrate_from_chat_id`): every stored id
 *    moved to the new one;
 *  - `/start@<bot> <nonce>` in a group: the bind a startgroup link produces.
 *
 * WHY BEFORE THE STATUS GATE: the owner creates an operator (SUSPENDED until its staff group is bound),
 * then adds its bot to the staff group. Every one of those updates arrives while the operator is not
 * serving, and a dropped `my_chat_member` or bind command is gone for good. Nothing else a stopped
 * operator receives runs: no handler, no money action.
 *
 * `consumed`: the update was a bind command and grammY must not see it. The player /start handler would
 * otherwise register whoever added the bot as a player of the operator.
 * `relevant`: the update was one of the kinds above (for a stopped operator, whether it was handled or
 * dropped). A `/start@<other bot> …` in a group the bot administers is not relevant: it is somebody
 * else's command.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { ChatMemberUpdated, Update } from 'grammy/types';

import { PrismaService } from '@core/prisma/prisma.service';

import { TelegramChatDiscoveryService } from '../services/telegram-chat-discovery.service';
import { TelegramChatMigrationService } from '../services/telegram-chat-migration.service';
import {
  bindCommandOf,
  boundChatOf,
  isChatProjectionUpdate,
  type BindCommand,
} from '../utils/chat-membership.util';

import { ChatBindingService } from './chat-binding.service';

export interface ChatProjectionResult {
  relevant: boolean;
  consumed: boolean;
}

const NOT_RELEVANT: ChatProjectionResult = { relevant: false, consumed: false };
const RECORDED: ChatProjectionResult = { relevant: true, consumed: false };

@Injectable()
export class TelegramChatProjectionService {
  private readonly logger = new Logger(TelegramChatProjectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly discovery: TelegramChatDiscoveryService,
    private readonly migrations: TelegramChatMigrationService,
    private readonly bindings: ChatBindingService,
  ) {}

  /** MUST be given the tenant the authenticated webhook resolved, never one read off the update. */
  async project(tenantId: string, update: Update): Promise<ChatProjectionResult> {
    if (!isChatProjectionUpdate(update)) return NOT_RELEVANT;

    const membership = update.my_chat_member;
    if (membership !== undefined) {
      await this.discovery.record(tenantId, membership);
      await this.warnWhenBoundChatLost(tenantId, membership);
      return RECORDED;
    }

    const message = update.message;
    if (message === undefined) return NOT_RELEVANT;

    if (message.migrate_to_chat_id !== undefined) {
      await this.migrations.migrate(
        tenantId,
        BigInt(message.chat.id),
        BigInt(message.migrate_to_chat_id),
        'service_message',
      );
      return RECORDED;
    }
    if (message.migrate_from_chat_id !== undefined) {
      await this.migrations.migrate(
        tenantId,
        BigInt(message.migrate_from_chat_id),
        BigInt(message.chat.id),
        'service_message',
      );
      return RECORDED;
    }

    const command = bindCommandOf(message);
    if (command === null || !(await this.addressedToThisBot(tenantId, command))) return NOT_RELEVANT;
    await this.bindings.bindFromStartGroup(tenantId, message, command.nonceHash);
    return { relevant: true, consumed: true };
  }

  /** A command naming no bot is this bot's (it received it); one naming a bot must name this one. */
  private async addressedToThisBot(tenantId: string, command: BindCommand): Promise<boolean> {
    if (command.mention === null) return true;
    const row = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { botUsername: true },
    });
    const username = row?.botUsername ?? null;
    return username !== null && username.toLowerCase() === command.mention.toLowerCase();
  }

  /**
   * The binding is kept when the bot is removed (a human rebinds; see the health `chats` block), but
   * the moment it happens is logged, because every card from now on goes nowhere.
   */
  private async warnWhenBoundChatLost(tenantId: string, event: ChatMemberUpdated): Promise<void> {
    const status = event.new_chat_member.status;
    if (status !== 'left' && status !== 'kicked') return;
    const row = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { adminChatId: true, feedChatId: true },
    });
    if (row === null) return;
    const chatId = BigInt(event.chat.id);
    const which =
      boundChatOf(row.adminChatId) === chatId
        ? 'staff'
        : boundChatOf(row.feedChatId) === chatId
          ? 'feed'
          : null;
    if (which === null) return;
    this.logger.warn(
      `Tenant ${tenantId}: the bot is ${status} from its ${which} group ${chatId}. The binding is ` +
        'kept; nothing reaches that group until the bot is added back or another group is bound.',
    );
  }
}
