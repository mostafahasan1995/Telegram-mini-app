/**
 * Binding an operator's staff group and feed group, whichever door the request came through:
 *  - the one-time "Add bot to group" link, which Telegram turns into `/start@<bot> <nonce>` inside the
 *    group the bot was added to (bindFromStartGroup, run by the worker's chat projection);
 *  - the console, picking a discovered group or typing an id (verify, then commit, run by the
 *    platform routes in modules/tenant, which map Telegram failures to contract errors).
 *
 * ══ THE ORDER, AND WHY ═══════════════════════════════════════════════════════════════════════════
 *  1. Verify with Telegram (verifyTelegramChat): group or supergroup, bot present, administrator, able
 *     to post. OUTSIDE any transaction: Telegram latency must never hold the tenant row lock, and the
 *     transaction helper may replay its callback, which must not replay a network call.
 *  2. Commit, in one transaction under the tenant row lock: use up the link (conditional on it still
 *     being unused, unrevoked and unexpired, so two groups racing for one link bind ONE of them), write
 *     the chat only when it actually changes, audit it in the operator's own log, and read which
 *     deposits are waiting for review without a card.
 *  3. After the commit, each best effort and reported, never thrown: a confirmation message in the group,
 *     so the owner sees it arrive in the right place; for the staff group, the admin command menu; and a
 *     card job for every waiting deposit.
 *
 * ══ THE BACKLOG ══════════════════════════════════════════════════════════════════════════════════
 * A deposit submitted while no staff group was bound (or while the old one was unreachable) got no
 * review card: DepositNotifyService logs it and returns, and nothing retries. Binding is the moment
 * those cards can exist, so each waiting deposit gets a TELEGRAM_ADMIN_CARD_UPDATE job, which posts
 * the card when none is stored. Enqueued after the commit rather than through the outbox because the
 * bind is a platform action, not a money transaction, and the job is idempotent and keyed per bind;
 * a failed enqueue is logged with the deposit id, and the console's deposit queue still shows them.
 *
 * ══ WHO MAY BIND ═════════════════════════════════════════════════════════════════════════════════
 * The PLATFORM_ADMIN only (owner decision 3): the console routes are PLATFORM_ADMIN routes, and a
 * link is only issued to one. Anybody can add a public bot to their own group and type /start in it;
 * without a live link of THIS operator (looked up by operator AND nonce hash, so another operator's
 * link is simply unknown here) nothing happens, and no reply tells them anything.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  DepositStatus,
  TelegramChatPurpose,
  TenantStatus,
  type TelegramChatBindLink,
} from '@prisma/client';
import type { Message } from 'grammy/types';

import { adminActor, type Actor } from '@common/types/actor.type';
import { AuditService } from '@core/audit/audit.service';
import { PrismaService } from '@core/prisma/prisma.service';
import { TASKS } from '@core/queue/queue.types';
import { TypedQueueService } from '@core/queue/typed-queue.service';
import { TENANT_ZERO_ID } from '@core/tenant/tenant.constants';
import { runWithTenant } from '@core/tenant/tenant.storage';

import { BotService } from '../services/bot.service';
import { TelegramChatDiscoveryService } from '../services/telegram-chat-discovery.service';
import { TenantBotSetupService } from '../services/tenant-bot-setup.service';
import { TELEGRAM_CHAT_AUDIT_SUBJECT, TelegramChatAuditActions } from '../telegram-chat.constants';
import { UNBOUND_CHAT_ID, boundChatOf } from '../utils/chat-membership.util';
import type {
  ChatRejectionReason,
  ChatVerification,
  VerifiedChat,
} from '../utils/chat-verification.util';

/**
 * Deposits a reviewer still has to decide, restated from modules/deposit REVIEWABLE_STATUSES (core may
 * not import a module). A deposit in any of them with no stored card has nowhere for staff to act.
 */
export const WAITING_FOR_REVIEW: readonly DepositStatus[] = Object.freeze([
  DepositStatus.SUBMITTED,
  DepositStatus.UNDER_REVIEW,
  DepositStatus.PENDING_SECOND_APPROVAL,
]);

/** Recorded on the audit row: which door the bind came through. */
export type ChatBindVia = 'startgroup' | 'console' | 'patch';

/** Why a link could not be used, beside the chat reasons Telegram's answer gives. */
export type LinkRefusalReason = 'LINK_EXPIRED' | 'LINK_USED' | 'LINK_REVOKED' | 'OPERATOR_CLOSED';

export type BindRefusalReason = ChatRejectionReason | LinkRefusalReason;

export interface ChatCommitInput {
  tenantId: string;
  purpose: TelegramChatPurpose;
  chat: VerifiedChat;
  actor: Actor;
  via: ChatBindVia;
  /** The link this bind uses up, or null for a console bind. */
  linkId: string | null;
  /** Who sent the bind command in Telegram, when it came from one. */
  telegramUserId: bigint | null;
}

export type ChatCommitOutcome =
  | {
      kind: 'bound';
      /** False when the chat was already the bound one: nothing was written or sent. */
      changed: boolean;
      previousChatId: bigint | null;
      waitingDeposits: number;
      cardsQueued: number;
    }
  | { kind: 'not-found' }
  | { kind: 'platform' }
  | { kind: 'closed' }
  | { kind: 'link-unusable' };

export type ChatUnbindOutcome =
  | { kind: 'unbound'; changed: boolean; previousChatId: bigint | null }
  | { kind: 'not-found' }
  | { kind: 'platform' }
  | { kind: 'closed' }
  /** The staff group of an ACTIVE operator: a serving operator must always have one. */
  | { kind: 'serving' };

export type StartGroupOutcome = 'bound' | 'refused' | 'ignored';

export interface BindRefusalRecord {
  tenantId: string;
  purpose: TelegramChatPurpose;
  reason: BindRefusalReason;
  chatId: bigint;
  actor: Actor;
  via: ChatBindVia;
  linkId: string | null;
  telegramUserId: bigint | null;
  detail: string | null;
}

/** The group's answer to a refused bind command. Arabic first, as the bot speaks to staff. */
const REFUSAL_REPLIES: Readonly<Record<BindRefusalReason, string>> = {
  LINK_EXPIRED:
    'انتهت صلاحية رابط الربط هذا. أنشئ رابطاً جديداً من لوحة التحكم.\n' +
    'This link has expired. Create a new one from the console.',
  LINK_USED:
    'تم استخدام رابط الربط هذا من قبل. أنشئ رابطاً جديداً من لوحة التحكم.\n' +
    'This link was already used. Create a new one from the console.',
  LINK_REVOKED:
    'تم استبدال هذا الرابط برابط أحدث. استخدم الرابط الأحدث من لوحة التحكم.\n' +
    'This link was replaced by a newer one. Use the newest link from the console.',
  OPERATOR_CLOSED:
    'لا يمكن ربط مجموعة بهذا الحساب.\nNo group can be bound to this operator.',
  NOT_FOUND:
    'تعذّر التحقق من هذه المجموعة. حاول مرة أخرى بعد قليل.\n' +
    'This group could not be verified. Try the link again shortly.',
  PRIVATE_CHAT:
    'يجب أن تكون مجموعة، وليست محادثة خاصة.\nThis must be a group, not a private chat.',
  CHANNEL_NOT_ALLOWED:
    'القنوات غير مدعومة. أضف البوت إلى مجموعة.\nChannels are not supported. Add the bot to a group.',
  BOT_NOT_MEMBER:
    'البوت ليس عضواً في هذه المجموعة. أضفه ثم افتح الرابط مرة أخرى.\n' +
    'The bot is not a member of this group. Add it, then open the link again.',
  BOT_NOT_ADMIN:
    'اجعل البوت مشرفاً في هذه المجموعة، ثم افتح الرابط مرة أخرى.\n' +
    'Make the bot an administrator of this group, then open the link again.',
  BOT_CANNOT_POST:
    'البوت لا يستطيع إرسال الرسائل هنا. اسمح له بالإرسال ثم افتح الرابط مرة أخرى.\n' +
    'The bot is not allowed to post here. Allow it to send messages, then open the link again.',
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

@Injectable()
export class ChatBindingService {
  private readonly logger = new Logger(ChatBindingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly bot: BotService,
    private readonly setup: TenantBotSetupService,
    private readonly discovery: TelegramChatDiscoveryService,
    private readonly queue: TypedQueueService,
  ) {}

  /**
   * Step 1: Telegram's answer for this chat, through the operator's own bot. A verified chat is also
   * recorded as a sighting, so a group bound by a typed id appears in the directory with its title.
   * Telegram failures that say nothing about the chat are thrown.
   */
  async verify(tenantId: string, chatId: bigint): Promise<ChatVerification> {
    const verification = await this.bot.verifyChat(tenantId, chatId);
    if (verification.ok) await this.discovery.recordVerified(tenantId, verification.chat);
    return verification;
  }

  /** Steps 2 and 3. See the file header. `chat` must come from `verify` moments ago. */
  async commit(input: ChatCommitInput): Promise<ChatCommitOutcome> {
    const { tenantId, purpose, chat } = input;

    const decided = await runWithTenant(tenantId, () =>
      this.prisma.runInTransaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId}::uuid FOR UPDATE`;
        const row = await tx.tenant.findUnique({
          where: { id: tenantId },
          select: { status: true, displayName: true, adminChatId: true, feedChatId: true },
        });
        if (row === null) return { kind: 'not-found' } as const;
        if (tenantId === TENANT_ZERO_ID) return { kind: 'platform' } as const;
        if (row.status === TenantStatus.CLOSED) return { kind: 'closed' } as const;

        // Unchanged is decided BEFORE the link is claimed: re-opening a link in the group that is
        // already bound changes nothing, so it writes nothing, and the link stays usable for the
        // group it was actually meant for.
        const previous =
          purpose === TelegramChatPurpose.STAFF ? boundChatOf(row.adminChatId) : row.feedChatId;
        if (previous === chat.chatId) {
          return { kind: 'unchanged', previous, displayName: row.displayName } as const;
        }

        if (input.linkId !== null) {
          const now = new Date();
          const claimed = await tx.telegramChatBindLink.updateMany({
            where: {
              id: input.linkId,
              tenantId,
              purpose,
              usedAt: null,
              revokedAt: null,
              expiresAt: { gt: now },
            },
            data: { usedAt: now, usedChatId: chat.chatId },
          });
          if (claimed.count !== 1) return { kind: 'link-unusable' } as const;
        }

        await tx.tenant.update({
          where: { id: tenantId },
          data:
            purpose === TelegramChatPurpose.STAFF
              ? { adminChatId: chat.chatId }
              : { feedChatId: chat.chatId },
          select: { id: true },
        });
        const auditId = await this.audit.write(tx, {
          action: TelegramChatAuditActions.BOUND,
          actor: input.actor,
          subjectType: TELEGRAM_CHAT_AUDIT_SUBJECT,
          subjectId: tenantId,
          before: { purpose, chatId: previous === null ? null : previous.toString() },
          after: {
            purpose,
            chatId: chat.chatId.toString(),
            chatType: chat.chatType,
            title: chat.title,
          },
          metadata: {
            via: input.via,
            linkId: input.linkId,
            telegramUserId: input.telegramUserId === null ? null : input.telegramUserId.toString(),
            botStatus: chat.facts.status,
          },
        });

        const waiting =
          purpose === TelegramChatPurpose.STAFF
            ? await tx.depositRequest.findMany({
                where: { tenantId, status: { in: [...WAITING_FOR_REVIEW] }, adminMessageId: null },
                select: { id: true },
                orderBy: { createdAt: 'asc' },
              })
            : [];

        return {
          kind: 'changed',
          previous,
          auditId,
          displayName: row.displayName,
          waiting: waiting.map((deposit) => deposit.id),
        } as const;
      }),
    );

    switch (decided.kind) {
      case 'not-found':
      case 'platform':
      case 'closed':
      case 'link-unusable':
        return decided;
      case 'unchanged':
        // From the console the unchanged TenantView is the answer. In the group, silence would look
        // like a broken link, so the owner is told it is already done.
        if (input.via === 'startgroup') {
          await this.sayAlreadyBound(tenantId, purpose, chat.chatId, decided.displayName);
        }
        return {
          kind: 'bound',
          changed: false,
          previousChatId: decided.previous,
          waitingDeposits: 0,
          cardsQueued: 0,
        };
      case 'changed':
        break;
    }

    // The summary first, so it arrives above the cards it announces.
    await this.confirmInChat(tenantId, purpose, chat.chatId, decided.displayName, decided.waiting.length);
    if (purpose === TelegramChatPurpose.STAFF) await this.pushAdminMenuQuietly(tenantId);
    const cardsQueued = await this.queueWaitingCards(tenantId, decided.waiting, decided.auditId);

    return {
      kind: 'bound',
      changed: true,
      previousChatId: decided.previous,
      waitingDeposits: decided.waiting.length,
      cardsQueued,
    };
  }

  /**
   * Removes a bound group. The staff group of an ACTIVE operator is refused ('serving'): an operator
   * with no staff group may not serve, so it has to be suspended first. The feed group can always go.
   */
  async unbind(
    tenantId: string,
    purpose: TelegramChatPurpose,
    actorAdminId: string,
  ): Promise<ChatUnbindOutcome> {
    return runWithTenant(tenantId, () =>
      this.prisma.runInTransaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId}::uuid FOR UPDATE`;
        const row = await tx.tenant.findUnique({
          where: { id: tenantId },
          select: { status: true, adminChatId: true, feedChatId: true },
        });
        if (row === null) return { kind: 'not-found' } as const;
        if (tenantId === TENANT_ZERO_ID) return { kind: 'platform' } as const;
        if (row.status === TenantStatus.CLOSED) return { kind: 'closed' } as const;

        const previous =
          purpose === TelegramChatPurpose.STAFF ? boundChatOf(row.adminChatId) : row.feedChatId;
        if (previous === null) return { kind: 'unbound', changed: false, previousChatId: null } as const;
        if (purpose === TelegramChatPurpose.STAFF && row.status === TenantStatus.ACTIVE) {
          return { kind: 'serving' } as const;
        }

        await tx.tenant.update({
          where: { id: tenantId },
          data:
            purpose === TelegramChatPurpose.STAFF
              ? { adminChatId: UNBOUND_CHAT_ID }
              : { feedChatId: null },
          select: { id: true },
        });
        await this.audit.write(tx, {
          action: TelegramChatAuditActions.UNBOUND,
          actor: adminActor(actorAdminId),
          subjectType: TELEGRAM_CHAT_AUDIT_SUBJECT,
          subjectId: tenantId,
          before: { purpose, chatId: previous.toString() },
          after: { purpose, chatId: null },
        });
        return { kind: 'unbound', changed: true, previousChatId: previous } as const;
      }),
    );
  }

  /**
   * The `/start@<bot> <nonce>` a startgroup link produced, in the group the bot was just added to.
   * Telegram failures that say nothing about the chat are thrown, so the update job retries; the link
   * is only used up by a successful commit, so a retry can still bind.
   */
  async bindFromStartGroup(
    tenantId: string,
    message: Message,
    nonceHash: string,
  ): Promise<StartGroupOutcome> {
    const chatId = BigInt(message.chat.id);
    const telegramUserId = message.from === undefined ? null : BigInt(message.from.id);

    // Pinned to THIS operator: a link another operator issued is unknown here, whoever's group it is.
    // By hash: the webhook already replaced the nonce with it (redactBindNonce).
    const link = await this.prisma.telegramChatBindLink.findFirst({
      where: { tenantId, nonceHash },
    });
    if (link === null) {
      // Silent in the group: an unknown payload tells whoever typed it nothing. Never the payload.
      this.logger.warn(
        `Tenant ${tenantId}: a bind command in chat ${chatId} matched no bind link of this operator; ignored`,
      );
      return 'ignored';
    }

    const refusal = (
      reason: BindRefusalReason,
      refusedChatId: bigint,
      detail: string | null,
    ): BindRefusalRecord => ({
      tenantId,
      purpose: link.purpose,
      reason,
      chatId: refusedChatId,
      actor: adminActor(link.issuedByAdminId),
      via: 'startgroup',
      linkId: link.id,
      telegramUserId,
      detail,
    });

    const unusable = linkRefusalOf(link, new Date());
    if (unusable !== null) {
      await this.refuseInChat(refusal(unusable, chatId, null));
      return 'refused';
    }

    const verification = await this.verify(tenantId, chatId);
    if (!verification.ok) {
      await this.refuseInChat(refusal(verification.reason, verification.chatId, verification.detail));
      return 'refused';
    }

    const outcome = await this.commit({
      tenantId,
      purpose: link.purpose,
      chat: verification.chat,
      actor: adminActor(link.issuedByAdminId),
      via: 'startgroup',
      linkId: link.id,
      telegramUserId,
    });
    switch (outcome.kind) {
      case 'bound':
        return 'bound';
      case 'link-unusable':
        await this.refuseInChat(refusal('LINK_USED', verification.chat.chatId, null));
        return 'refused';
      case 'platform':
      case 'closed':
        await this.refuseInChat(refusal('OPERATOR_CLOSED', verification.chat.chatId, null));
        return 'refused';
      case 'not-found':
        return 'ignored';
    }
  }

  /**
   * A refused bind attempt, in the operator's own log. Best effort: the refusal is already the answer,
   * and losing its evidence must not turn it into an error. Never the nonce.
   */
  async recordRefusal(record: BindRefusalRecord): Promise<void> {
    try {
      await runWithTenant(record.tenantId, () =>
        this.prisma.runInTransaction((tx) =>
          this.audit.write(tx, {
            action: TelegramChatAuditActions.BIND_REFUSED,
            actor: record.actor,
            subjectType: TELEGRAM_CHAT_AUDIT_SUBJECT,
            subjectId: record.tenantId,
            metadata: {
              purpose: record.purpose,
              reason: record.reason,
              chatId: record.chatId.toString(),
              via: record.via,
              linkId: record.linkId,
              telegramUserId:
                record.telegramUserId === null ? null : record.telegramUserId.toString(),
              detail: record.detail,
            },
          }),
        ),
      );
    } catch (error: unknown) {
      this.logger.error(
        `Tenant ${record.tenantId}: a refused bind (${record.reason}) was not recorded: ${describeError(error)}`,
      );
    }
  }

  private async refuseInChat(record: BindRefusalRecord): Promise<void> {
    await this.recordRefusal(record);
    try {
      await this.bot.sendMessage(record.tenantId, record.chatId, REFUSAL_REPLIES[record.reason], {
        linkPreview: false,
      });
    } catch (error: unknown) {
      // A bot that may not post is one of the reasons it was refused; the audit row is the evidence.
      this.logger.warn(
        `Tenant ${record.tenantId}: could not tell chat ${record.chatId} why its bind was refused: ${describeError(error)}`,
      );
    }
  }

  /** Plain text, never HTML: the operator's display name is typed by a person. */
  private async confirmInChat(
    tenantId: string,
    purpose: TelegramChatPurpose,
    chatId: bigint,
    displayName: string,
    waiting: number,
  ): Promise<void> {
    const lines =
      purpose === TelegramChatPurpose.STAFF
        ? [
            `✅ أصبحت هذه المجموعة مجموعة الموظفين لـ ${displayName}. ستصل بطاقات مراجعة الإيداعات والتنبيهات إلى هنا.`,
            `This group is now the staff group of ${displayName}. Deposit review cards and alerts will arrive here.`,
          ]
        : [
            `✅ أصبحت هذه المجموعة مجموعة النشر لـ ${displayName}.`,
            `This group is now the feed group of ${displayName}.`,
          ];
    if (waiting > 0) {
      lines.push(
        `📥 ${waiting} إيداع بانتظار المراجعة، وستصل بطاقاتها الآن.`,
        `${waiting} deposit(s) are waiting for review; their cards follow.`,
      );
    }
    try {
      await this.bot.sendMessage(tenantId, chatId, lines.join('\n'), { linkPreview: false });
    } catch (error: unknown) {
      this.logger.warn(
        `Tenant ${tenantId}: the ${purpose} group was bound but its confirmation was not sent: ${describeError(error)}`,
      );
    }
  }

  /** Plain text, like the confirmation. Best effort: nothing changed, so nothing is lost if it fails. */
  private async sayAlreadyBound(
    tenantId: string,
    purpose: TelegramChatPurpose,
    chatId: bigint,
    displayName: string,
  ): Promise<void> {
    const text =
      purpose === TelegramChatPurpose.STAFF
        ? `ℹ️ هذه المجموعة هي مجموعة الموظفين لـ ${displayName} بالفعل. لم يتغير شيء.\n` +
          `This group is already the staff group of ${displayName}. Nothing changed.`
        : `ℹ️ هذه المجموعة هي مجموعة النشر لـ ${displayName} بالفعل. لم يتغير شيء.\n` +
          `This group is already the feed group of ${displayName}. Nothing changed.`;
    try {
      await this.bot.sendMessage(tenantId, chatId, text, { linkPreview: false });
    } catch (error: unknown) {
      this.logger.warn(
        `Tenant ${tenantId}: could not tell chat ${chatId} it is already the ${purpose} group: ${describeError(error)}`,
      );
    }
  }

  /** The staff group's admins get the admin command menu. Reported in the log, never thrown. */
  private async pushAdminMenuQuietly(tenantId: string): Promise<void> {
    try {
      const result = await this.setup.pushMenus(tenantId);
      if (result.fatalError !== null || result.warnings.length > 0) {
        this.logger.warn(
          `Tenant ${tenantId}: menus after binding the staff group: ${
            result.fatalError ?? result.warnings.join('; ')
          }`,
        );
      }
    } catch (error: unknown) {
      this.logger.warn(`Tenant ${tenantId}: menus were not pushed after binding: ${describeError(error)}`);
    }
  }

  private async queueWaitingCards(
    tenantId: string,
    depositIds: readonly string[],
    bindAuditId: string,
  ): Promise<number> {
    let queued = 0;
    for (const depositRequestId of depositIds) {
      try {
        await this.queue.add(
          TASKS.TELEGRAM_ADMIN_CARD_UPDATE,
          { depositRequestId, reason: 'staff-group-bound' },
          // One job per deposit per bind: a replay of this bind collapses, a later rebind does not.
          { jobId: `deposit-card-bound-${depositRequestId}-${bindAuditId}` },
        );
        queued += 1;
      } catch (error: unknown) {
        this.logger.error(
          `Tenant ${tenantId}: the review card of waiting deposit ${depositRequestId} was not queued ` +
            `after binding the staff group: ${describeError(error)}`,
        );
      }
    }
    return queued;
  }
}

/** Why a stored link cannot be used now, or null when it can. */
export function linkRefusalOf(
  link: Pick<TelegramChatBindLink, 'usedAt' | 'revokedAt' | 'expiresAt'>,
  now: Date,
): LinkRefusalReason | null {
  if (link.usedAt !== null) return 'LINK_USED';
  if (link.revokedAt !== null) return 'LINK_REVOKED';
  if (link.expiresAt.getTime() <= now.getTime()) return 'LINK_EXPIRED';
  return null;
}
