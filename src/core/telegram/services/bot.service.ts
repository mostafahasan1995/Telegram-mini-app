/**
 * WHY a facade instead of injecting a Bot everywhere: Telegram fails in ways that are NOT
 * failures of the thing that called it, and every call site would otherwise need the same four
 * try/catch branches. Getting that wrong is expensive here — a deposit is credited, we try to tell
 * the player, the player has blocked the bot, the send throws, the job fails, BullMQ retries, and
 * the credit is attempted a second time. Notification errors must never travel back into money
 * logic.
 *
 * WHY EVERY SEND NAMES ITS TENANT: each operator has its own bot, and a player or a group only
 * knows the bot they talk to. A card about operator A's deposit sent through operator B's bot is a
 * message from a stranger at best, and a leak of A's data into B's chats at worst. The tenant is a
 * required argument, taken from the row the message is about, never guessed from ambient context.
 * TenantBotRegistry resolves it to that operator's Bot.
 *
 * The rules encoded below:
 *  - 403 "bot was blocked" / "chat not found"  -> the message is undeliverable, forever. Not an
 *    error: return null and let the caller carry on.
 *  - 400 "message is not modified"             -> the edit already says what we wanted. Success.
 *  - 400 "message to edit not found"           -> the card was deleted. Return false, do not throw.
 *  - 400 with `migrate_to_chat_id`             -> the group became a supergroup with a new id. Every
 *    id stored for it is moved (TelegramChatMigrationService) and the call is retried ONCE against
 *    the new id. Telegram's words for this match none of the phrases above, so without it the send
 *    would be rethrown and retried against a dead id for as long as the job lived.
 *  - 429 / 5xx                                 -> already retried by autoRetry; if it still fails,
 *    it is a real error and IS thrown, because the caller may want to retry the whole job.
 *  - the operator has no working bot           -> TenantBotUnavailableError is thrown, like a 5xx:
 *    the caller's retry policy decides, and the error says whether retrying can help.
 */
import { Injectable, Logger } from '@nestjs/common';
import { type Bot, GrammyError } from 'grammy';
import { type Message, type ParseMode } from 'grammy/types';
import { PrismaService } from '../../prisma/prisma.service';
import { boundChatOf, migratedChatIdOf, numericChatId } from '../utils/chat-membership.util';
import { verifyTelegramChat, type ChatVerification } from '../utils/chat-verification.util';
import { TelegramChatMigrationService } from './telegram-chat-migration.service';
import { TenantBotRegistry } from './tenant-bot-registry.service';

/**
 * Where an operator's staff and its optional feed are notified, read off `tenants`. Null means "not
 * set": the column is absent (feed), or holds the 0 an operator is created with until its staff group
 * is bound (admin). Telegram has no chat 0, so 0 is never a destination.
 */
export interface TenantChats {
  adminChatId: bigint | null;
  feedChatId: bigint | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SendOptions {
  parseMode?: ParseMode;
  /**
   * An InlineKeyboard/Keyboard from grammY, or a raw markup object. Left as `unknown` on purpose:
   * the four Bot API markup unions differ per method, and pinning one here would force callers to
   * cast at every call site instead of once, here.
   */
  replyMarkup?: unknown;
  disableNotification?: boolean;
  /** Forum topic id, for admin groups that use topics. */
  messageThreadId?: number;
  linkPreview?: boolean;
}

/** Telegram descriptions that mean "this chat can never receive our messages". */
const PERMANENTLY_UNDELIVERABLE = [
  'bot was blocked by the user',
  'user is deactivated',
  'chat not found',
  'bot was kicked',
  'have no rights to send a message',
  'not enough rights',
];

/** Telegram descriptions that mean "the edit is pointless but nothing is wrong". */
const EDIT_IS_NOOP = ['message is not modified'];

/** Telegram descriptions that mean "the target message is gone". */
const EDIT_TARGET_GONE = [
  'message to edit not found',
  "message can't be edited",
  'message identifier is not specified',
];

function describes(error: unknown, needles: string[]): boolean {
  if (!(error instanceof GrammyError)) return false;
  const description = error.description.toLowerCase();
  return needles.some((needle) => description.includes(needle));
}

@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name);
  /** Operators already warned about for having no admin chat, so a busy one logs once. */
  private readonly warnedNoAdminChat = new Set<string>();

  constructor(
    private readonly bots: TenantBotRegistry,
    private readonly prisma: PrismaService,
    private readonly migrations: TelegramChatMigrationService,
  ) {}

  /**
   * The operator's admin and feed chats, read fresh from its row.
   *
   * WHY NOT CACHED: this runs once per notification, not per request, and a chat changed from the
   * dashboard (PATCH /v1/admin/tenants/:id) must take effect on the very next card rather than after
   * a TTL in some other process's memory. `Tenant` is not a tenant-scoped model, so no context is
   * needed and none is assumed.
   */
  async chatsOf(tenantId: string): Promise<TenantChats> {
    const row = UUID.test(tenantId)
      ? await this.prisma.tenant.findUnique({
          where: { id: tenantId },
          select: { adminChatId: true, feedChatId: true },
        })
      : null;
    if (row === null) return { adminChatId: null, feedChatId: null };
    return { adminChatId: boundChatOf(row.adminChatId), feedChatId: boundChatOf(row.feedChatId) };
  }

  /**
   * The operator's own Bot, for the few places that genuinely need the raw client (file downloads,
   * etc.). Throws TenantBotUnavailableError when that operator has no working bot.
   */
  forTenant(tenantId: string): Promise<Bot> {
    return this.bots.get(tenantId);
  }

  /**
   * Asks Telegram, through THIS operator's bot, whether `chatId` can be its staff or feed group (see
   * verifyTelegramChat for the checks). When the group had become a supergroup, whatever was stored
   * under the old id is moved before the answer is returned, and the answer names the new id.
   */
  async verifyChat(tenantId: string, chatId: bigint): Promise<ChatVerification> {
    const bot = await this.bots.get(tenantId);
    const verification = await verifyTelegramChat(bot.api, bot.botInfo.id, chatId);
    if (verification.migratedFrom !== null) {
      const movedTo = verification.ok ? verification.chat.chatId : verification.chatId;
      await this.migrations.migrate(tenantId, verification.migratedFrom, movedTo, 'verification');
    }
    return verification;
  }

  /**
   * Sends a message. Returns null when the chat is permanently unreachable, so a caller can record
   * "notified: no" without treating it as a failure of the operation it was reporting on.
   */
  async sendMessage(
    tenantId: string,
    chatId: bigint | number | string,
    text: string,
    options: SendOptions = {},
  ): Promise<Message.TextMessage | null> {
    const bot = await this.bots.get(tenantId);
    try {
      return await this.followingMigration(tenantId, chatId, (target) =>
        bot.api.sendMessage(target, text, {
          parse_mode: options.parseMode,
          disable_notification: options.disableNotification,
          message_thread_id: options.messageThreadId,
          link_preview_options: options.linkPreview === false ? { is_disabled: true } : undefined,
          reply_markup: options.replyMarkup as never,
        }),
      );
    } catch (error: unknown) {
      if (describes(error, PERMANENTLY_UNDELIVERABLE)) {
        this.logger.warn(
          `Chat ${String(chatId)} is unreachable for tenant ${tenantId}: ${
            error instanceof GrammyError ? error.description : ''
          }`,
        );
        return null;
      }
      throw error;
    }
  }

  /**
   * Edits a message's text. Returns true if the message now reads as intended — including the case
   * where it already did ("message is not modified"), which is what makes a retried job idempotent.
   * Returns false when the target no longer exists.
   */
  async editMessageText(
    tenantId: string,
    chatId: bigint | number | string,
    messageId: number,
    text: string,
    options: SendOptions = {},
  ): Promise<boolean> {
    const bot = await this.bots.get(tenantId);
    try {
      await this.followingMigration(tenantId, chatId, (target) =>
        bot.api.editMessageText(target, messageId, text, {
          parse_mode: options.parseMode,
          link_preview_options: options.linkPreview === false ? { is_disabled: true } : undefined,
          reply_markup: options.replyMarkup as never,
        }),
      );
      return true;
    } catch (error: unknown) {
      // The desired end state is already the actual state. Treating this as an error would fail
      // jobs on every replay.
      if (describes(error, EDIT_IS_NOOP)) return true;

      if (describes(error, EDIT_TARGET_GONE) || describes(error, PERMANENTLY_UNDELIVERABLE)) {
        this.logger.warn(`Message ${messageId} in chat ${String(chatId)} can no longer be edited`);
        return false;
      }
      throw error;
    }
  }

  /** Replaces a message's inline keyboard, e.g. to grey out buttons after a decision. */
  async editMessageReplyMarkup(
    tenantId: string,
    chatId: bigint | number | string,
    messageId: number,
    replyMarkup?: unknown,
  ): Promise<boolean> {
    const bot = await this.bots.get(tenantId);
    try {
      await this.followingMigration(tenantId, chatId, (target) =>
        bot.api.editMessageReplyMarkup(target, messageId, {
          reply_markup: replyMarkup as never,
        }),
      );
      return true;
    } catch (error: unknown) {
      if (describes(error, EDIT_IS_NOOP)) return true;
      if (describes(error, EDIT_TARGET_GONE) || describes(error, PERMANENTLY_UNDELIVERABLE)) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Acknowledges a callback query. ALWAYS call this — an unanswered button spins for 30 seconds in
   * the client and reads as a broken bot. Never throws: the answer is cosmetic, and a stale
   * `callback_query_id` (older than ~60s) is an expected, harmless failure. That includes the
   * operator's bot being unavailable, which the update processor has already reported.
   */
  async answerCallback(
    tenantId: string,
    callbackQueryId: string,
    text?: string,
    showAlert = false,
  ): Promise<void> {
    try {
      const bot = await this.bots.get(tenantId);
      await bot.api.answerCallbackQuery(callbackQueryId, {
        text,
        show_alert: showAlert,
      });
    } catch (error: unknown) {
      this.logger.debug(
        `answerCallbackQuery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async sendPhoto(
    tenantId: string,
    chatId: bigint | number | string,
    photo: string,
    caption?: string,
    options: SendOptions = {},
  ): Promise<Message.PhotoMessage | null> {
    const bot = await this.bots.get(tenantId);
    try {
      return await this.followingMigration(tenantId, chatId, (target) =>
        bot.api.sendPhoto(target, photo, {
          caption,
          parse_mode: options.parseMode,
          message_thread_id: options.messageThreadId,
          reply_markup: options.replyMarkup as never,
        }),
      );
    } catch (error: unknown) {
      if (describes(error, PERMANENTLY_UNDELIVERABLE)) return null;
      throw error;
    }
  }

  async deleteMessage(
    tenantId: string,
    chatId: bigint | number | string,
    messageId: number,
  ): Promise<boolean> {
    try {
      const bot = await this.bots.get(tenantId);
      await bot.api.deleteMessage(this.toChatId(chatId), messageId);
      return true;
    } catch {
      // Deletion is best-effort: the message may already be gone, or too old to delete.
      return false;
    }
  }

  /**
   * Posts to THIS operator's admin chat (`tenants.admin_chat_id`) through THIS operator's bot — the
   * review queue and the operator's alerts.
   *
   * Returns null without touching the Bot API when the operator has no admin chat set yet, exactly
   * like an unreachable chat, so every caller's existing "not delivered" branch covers it. Warned
   * once per operator: a card that goes nowhere must be visible in the logs.
   */
  async notifyAdmins(
    tenantId: string,
    text: string,
    options: SendOptions = {},
  ): Promise<Message.TextMessage | null> {
    const { adminChatId } = await this.chatsOf(tenantId);
    if (adminChatId === null) {
      if (!this.warnedNoAdminChat.has(tenantId)) {
        this.warnedNoAdminChat.add(tenantId);
        this.logger.warn(
          `Tenant ${tenantId} has no admin chat set; its staff notifications are not delivered ` +
            'until one is set from the dashboard',
        );
      }
      return null;
    }
    this.warnedNoAdminChat.delete(tenantId);
    return this.sendMessage(tenantId, adminChatId, text, options);
  }

  /**
   * Posts to this operator's OPTIONAL feed chat (`tenants.feed_chat_id`) through its bot — the
   * customer-visible group that mirrors credited deposits.
   *
   * Returns null WITHOUT touching the Bot API when no feed chat is configured, so call sites stay
   * unconditional and the unconfigured case is indistinguishable from the "chat is unreachable"
   * case they already handle. Never throws for being unconfigured: the feed is a nice-to-have and
   * must not be able to fail a money job.
   *
   * NOTHING operational goes here — see notifyAdmins for alerts. This chat may contain customers.
   */
  async notifyFeed(
    tenantId: string,
    text: string,
    options: SendOptions = {},
  ): Promise<Message.TextMessage | null> {
    const { feedChatId } = await this.chatsOf(tenantId);
    if (feedChatId === null) return null;
    return this.sendMessage(tenantId, feedChatId, text, options);
  }

  /** Registers an operator's webhook URL on that operator's bot. */
  async setWebhook(
    tenantId: string,
    url: string,
    secretToken: string,
    allowedUpdates: readonly string[],
    dropPendingUpdates = false,
  ): Promise<boolean> {
    const bot = await this.bots.get(tenantId);
    return bot.api.setWebhook(url, {
      secret_token: secretToken,
      allowed_updates: [...allowedUpdates] as never,
      drop_pending_updates: dropPendingUpdates,
    });
  }

  async deleteWebhook(tenantId: string, dropPendingUpdates = false): Promise<boolean> {
    const bot = await this.bots.get(tenantId);
    return bot.api.deleteWebhook({ drop_pending_updates: dropPendingUpdates });
  }

  async getWebhookInfo(
    tenantId: string,
  ): Promise<Awaited<ReturnType<Bot['api']['getWebhookInfo']>>> {
    const bot = await this.bots.get(tenantId);
    return bot.api.getWebhookInfo();
  }

  /**
   * Runs one Bot API call against `chatId`. When Telegram answers that the group became a supergroup,
   * the operator's stored ids are moved and the call runs once more against the new id. Any other
   * failure, and a failure of the retry, is the caller's to classify.
   */
  private async followingMigration<T>(
    tenantId: string,
    chatId: bigint | number | string,
    call: (target: number | string) => Promise<T>,
  ): Promise<T> {
    try {
      return await call(this.toChatId(chatId));
    } catch (error: unknown) {
      const movedTo = migratedChatIdOf(error);
      const from = numericChatId(chatId);
      if (movedTo === null || from === null) throw error;
      await this.migrations.migrate(tenantId, from, movedTo, 'send_error');
      return call(movedTo.toString());
    }
  }

  /**
   * Telegram chat ids are 64-bit and we store them as bigint, but the Bot API client takes
   * number | string. Stringifying a bigint is lossless; Number() would not be.
   */
  private toChatId(chatId: bigint | number | string): number | string {
    return typeof chatId === 'bigint' ? chatId.toString() : chatId;
  }
}
