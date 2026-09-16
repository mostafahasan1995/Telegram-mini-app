/**
 * A group that becomes a supergroup gets a NEW chat id (Bot API: the old group receives a service
 * message with `migrate_to_chat_id`, the new supergroup one with `migrate_from_chat_id`, and any call
 * that still uses the old id fails with ResponseParameters.migrate_to_chat_id). Promoting a bot with
 * custom rights in a basic group is one of the ordinary ways this happens, so the owner's own "add the
 * bot as admin" step can cause it.
 *
 * Left alone, every card of that operator would be sent to a dead id. Telegram's error for it matches
 * none of BotService's "undeliverable" phrases, so the notify job would fail and retry for ever while
 * staff saw an empty group.
 *
 * WHAT MOVES, for ONE operator, in one transaction:
 *  - `tenants.admin_chat_id` and `tenants.feed_chat_id`, only where they hold the old id (a conditional
 *    update, so a concurrent rebind to some other chat is never overwritten);
 *  - `deposit_requests.admin_chat_id`, the stored location of each review card, so an in-flight card is
 *    edited in the supergroup (and reposted there if Telegram did not carry the message across);
 *  - the pin of a live one-time bind link (ChatBindingService), so the group that opened it can still
 *    use it: promoting the bot in a basic group, the owner's fix for BOT_NOT_ADMIN, is what moves it;
 *  - the discovered-chat row: copied to the new id, the old row kept and marked `migratedToChatId`.
 * Idempotent: both service messages, a send error and a verification can all report the same move.
 *
 * Audited as SYSTEM in the operator's own log whenever a bound chat moved, because the stored staff or
 * feed group changed without anybody choosing it.
 */
import { Injectable, Logger } from '@nestjs/common';
import { TelegramChatType } from '@prisma/client';

import { SYSTEM_ACTOR } from '@common/types/actor.type';

import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { runWithTenant } from '../../tenant/tenant.storage';
import { TELEGRAM_CHAT_AUDIT_SUBJECT, TelegramChatAuditActions } from '../telegram-chat.constants';

/** Which evidence reported the move. Recorded in the audit row. */
export type ChatMigrationSource = 'service_message' | 'send_error' | 'verification';

export interface ChatMigrationOutcome {
  staffMoved: boolean;
  feedMoved: boolean;
  cardsMoved: number;
}

@Injectable()
export class TelegramChatMigrationService {
  private readonly logger = new Logger(TelegramChatMigrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async migrate(
    tenantId: string,
    fromChatId: bigint,
    toChatId: bigint,
    source: ChatMigrationSource,
  ): Promise<ChatMigrationOutcome> {
    if (fromChatId === toChatId) return { staffMoved: false, feedMoved: false, cardsMoved: 0 };

    // The operator's own context, whatever the caller's: a notify job has none, and an HTTP request's
    // is tenant zero. Every scoped write below names this operator and must land in its log.
    const outcome = await runWithTenant(tenantId, () =>
      this.prisma.runInTransaction(async (tx) => {
        const staff = await tx.tenant.updateMany({
          where: { id: tenantId, adminChatId: fromChatId },
          data: { adminChatId: toChatId },
        });
        const feed = await tx.tenant.updateMany({
          where: { id: tenantId, feedChatId: fromChatId },
          data: { feedChatId: toChatId },
        });
        const cards = await tx.depositRequest.updateMany({
          where: { tenantId, adminChatId: fromChatId },
          data: { adminChatId: toChatId },
        });
        // A used or revoked link keeps the id it had, as evidence.
        await tx.telegramChatBindLink.updateMany({
          where: { tenantId, pinnedChatId: fromChatId, usedAt: null, revokedAt: null },
          data: { pinnedChatId: toChatId },
        });

        const sighting = await tx.telegramDiscoveredChat.findFirst({
          where: { tenantId, chatId: fromChatId },
        });
        if (sighting !== null) {
          await tx.telegramDiscoveredChat.createMany({
            data: [
              {
                tenantId,
                chatId: toChatId,
                chatType: TelegramChatType.SUPERGROUP,
                title: sighting.title,
                username: sighting.username,
                status: sighting.status,
                isAdministrator: sighting.isAdministrator,
                isPresent: sighting.isPresent,
                canPost: sighting.canPost,
                lastChangedByTelegramUserId: sighting.lastChangedByTelegramUserId,
                lastChangedByUsername: sighting.lastChangedByUsername,
                firstSeenAt: sighting.firstSeenAt,
                lastSeenAt: sighting.lastSeenAt,
              },
            ],
            // A sighting of the supergroup itself may already exist, and it is the newer truth.
            skipDuplicates: true,
          });
          await tx.telegramDiscoveredChat.updateMany({
            where: { tenantId, chatId: fromChatId },
            data: { migratedToChatId: toChatId, isPresent: false },
          });
        }

        const moved = {
          staffMoved: staff.count > 0,
          feedMoved: feed.count > 0,
          cardsMoved: cards.count,
        };
        if (moved.staffMoved || moved.feedMoved) {
          await this.audit.write(tx, {
            action: TelegramChatAuditActions.MIGRATED,
            actor: SYSTEM_ACTOR,
            subjectType: TELEGRAM_CHAT_AUDIT_SUBJECT,
            subjectId: tenantId,
            before: {
              ...(moved.staffMoved ? { adminChatId: fromChatId.toString() } : {}),
              ...(moved.feedMoved ? { feedChatId: fromChatId.toString() } : {}),
            },
            after: {
              ...(moved.staffMoved ? { adminChatId: toChatId.toString() } : {}),
              ...(moved.feedMoved ? { feedChatId: toChatId.toString() } : {}),
            },
            metadata: { source, cardsMoved: moved.cardsMoved },
          });
        }
        return moved;
      }),
    );

    if (outcome.staffMoved || outcome.feedMoved || outcome.cardsMoved > 0) {
      this.logger.warn(
        `Tenant ${tenantId}: chat ${fromChatId} became supergroup ${toChatId} (${source}); ` +
          `staff ${outcome.staffMoved}, feed ${outcome.feedMoved}, cards ${outcome.cardsMoved} moved`,
      );
    }
    return outcome;
  }
}
