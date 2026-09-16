/**
 * The chat directory: every group or channel an operator's bot was seen in (`telegram_discovered_chats`).
 *
 * WHY IT EXISTS: a private group has no username and its invite link cannot be resolved by a bot, and
 * the Bot API has no "list my chats". Telegram tells a bot a group's id only by pushing an update, most
 * reliably `my_chat_member` when the bot is added, promoted, demoted or removed. That update was
 * subscribed, stored and then thrown away. It is now projected here while the worker handles it, for
 * ANY operator status: a new operator is SUSPENDED exactly while its bot is being added to its groups.
 *
 * A ROW IS AN OBSERVATION, NEVER A PERMISSION. Nothing is posted anywhere because it is listed here;
 * binding re-asks Telegram (verifyTelegramChat). A sighting made by that verification is recorded too,
 * so a group bound by a typed id still shows up with its title.
 *
 * ORDER: a sighting only overwrites one that is not newer. Telegram retries and BullMQ retries can
 * deliver an old "bot added" after a newer "bot removed", and the stale one must not resurrect a group
 * the bot is no longer in. Telegram's own `date` is the clock for updates.
 *
 * WHY RAW SQL: the upsert and the "not newer" guard have to be one statement (ON CONFLICT … WHERE), or
 * two sightings racing both read the old row. Raw SQL bypasses the tenant-scope extension, which is
 * why `tenant_id` is written explicitly, and it always comes from the authenticated webhook route.
 *
 * DB errors are thrown, not swallowed: the update carrying the sighting is the one copy Telegram
 * sends, and a thrown error lets the update job retry it.
 */
import { Injectable } from '@nestjs/common';
import type { TelegramDiscoveredChat } from '@prisma/client';
import type { ChatMemberUpdated } from 'grammy/types';

import { PrismaService } from '../../prisma/prisma.service';
import { chatTypeOf, membershipFacts, type MembershipFacts } from '../utils/chat-membership.util';
import type { VerifiedChat } from '../utils/chat-verification.util';

interface Sighting {
  chatId: bigint;
  chatType: string;
  title: string | null;
  username: string | null;
  facts: MembershipFacts;
  changedByTelegramUserId: bigint | null;
  changedByUsername: string | null;
  seenAt: Date;
}

@Injectable()
export class TelegramChatDiscoveryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records what one `my_chat_member` says about the bot in a group or channel. Returns false for a
   * private chat (a player blocking or unblocking the bot), which is never recorded.
   */
  async record(tenantId: string, event: ChatMemberUpdated): Promise<boolean> {
    const chatType = chatTypeOf(event.chat.type);
    if (chatType === null) return false;
    await this.upsert(tenantId, {
      chatId: BigInt(event.chat.id),
      chatType,
      title: event.chat.type === 'private' ? null : (event.chat.title ?? null),
      username: 'username' in event.chat ? (event.chat.username ?? null) : null,
      facts: membershipFacts(chatType, event.new_chat_member),
      changedByTelegramUserId: BigInt(event.from.id),
      changedByUsername: event.from.username ?? null,
      seenAt: new Date(event.date * 1_000),
    });
    return true;
  }

  /**
   * Records what a verification just read from Telegram. Keeps the stored "changed by".
   *
   * Stamped to the whole second, the resolution of Telegram's own `date`: a millisecond stamp would
   * be "newer" than a removal Telegram reports in the same second, and the guard would then keep a
   * bot that is already gone.
   */
  async recordVerified(tenantId: string, chat: VerifiedChat): Promise<void> {
    await this.upsert(tenantId, {
      chatId: chat.chatId,
      chatType: chat.chatType,
      title: chat.title,
      username: chat.username,
      facts: chat.facts,
      changedByTelegramUserId: null,
      changedByUsername: null,
      seenAt: new Date(Math.floor(Date.now() / 1_000) * 1_000),
    });
  }

  /** One operator's directory, most recently seen first. Pinned to the operator by name. */
  listForTenant(tenantId: string): Promise<TelegramDiscoveredChat[]> {
    return this.prisma.telegramDiscoveredChat.findMany({
      where: { tenantId },
      orderBy: [{ lastSeenAt: 'desc' }, { chatId: 'asc' }],
    });
  }

  /** The sightings of some of one operator's chats, e.g. its bound staff and feed groups. */
  findForTenant(tenantId: string, chatIds: readonly bigint[]): Promise<TelegramDiscoveredChat[]> {
    if (chatIds.length === 0) return Promise.resolve([]);
    return this.prisma.telegramDiscoveredChat.findMany({
      where: { tenantId, chatId: { in: [...chatIds] } },
    });
  }

  private async upsert(tenantId: string, sighting: Sighting): Promise<void> {
    const changedBy = sighting.changedByTelegramUserId;
    await this.prisma.$executeRaw`
      INSERT INTO telegram_discovered_chats (
        tenant_id, chat_id, chat_type, title, username, status,
        is_administrator, is_present, can_post,
        last_changed_by_telegram_user_id, last_changed_by_username,
        first_seen_at, last_seen_at
      ) VALUES (
        ${tenantId}::uuid,
        ${sighting.chatId.toString()}::bigint,
        ${sighting.chatType}::telegram_chat_type,
        ${sighting.title},
        ${sighting.username},
        ${sighting.facts.status}::telegram_bot_chat_status,
        ${sighting.facts.isAdministrator},
        ${sighting.facts.isPresent},
        ${sighting.facts.canPost},
        ${changedBy === null ? null : changedBy.toString()}::bigint,
        ${sighting.changedByUsername},
        ${sighting.seenAt.toISOString()}::timestamptz,
        ${sighting.seenAt.toISOString()}::timestamptz
      )
      ON CONFLICT (tenant_id, chat_id) DO UPDATE SET
        chat_type = EXCLUDED.chat_type,
        title = COALESCE(EXCLUDED.title, telegram_discovered_chats.title),
        username = EXCLUDED.username,
        status = EXCLUDED.status,
        is_administrator = EXCLUDED.is_administrator,
        is_present = EXCLUDED.is_present,
        can_post = EXCLUDED.can_post,
        last_changed_by_telegram_user_id = COALESCE(
          EXCLUDED.last_changed_by_telegram_user_id,
          telegram_discovered_chats.last_changed_by_telegram_user_id
        ),
        last_changed_by_username = CASE
          WHEN EXCLUDED.last_changed_by_telegram_user_id IS NULL
            THEN telegram_discovered_chats.last_changed_by_username
          ELSE EXCLUDED.last_changed_by_username
        END,
        last_seen_at = EXCLUDED.last_seen_at
      WHERE telegram_discovered_chats.last_seen_at <= EXCLUDED.last_seen_at
    `;
  }
}
