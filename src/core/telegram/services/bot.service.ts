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
 *  - 429 / 5xx                                 -> already retried by autoRetry; if it still fails,
 *    it is a real error and IS thrown, because the caller may want to retry the whole job.
 *  - the operator has no working bot           -> TenantBotUnavailableError is thrown, like a 5xx:
 *    the caller's retry policy decides, and the error says whether retrying can help.
 */
import { Injectable, Logger } from '@nestjs/common';
import { type Bot, GrammyError } from 'grammy';
import { type Message, type ParseMode } from 'grammy/types';
import { AppConfigService } from '../../config/config.service';
import { TenantBotRegistry } from './tenant-bot-registry.service';

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

  constructor(
    private readonly bots: TenantBotRegistry,
    private readonly config: AppConfigService,
  ) {}

  /**
   * The operator's own Bot, for the few places that genuinely need the raw client (file downloads,
   * etc.). Throws TenantBotUnavailableError when that operator has no working bot.
   */
  forTenant(tenantId: string): Promise<Bot> {
    return this.bots.get(tenantId);
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
      return await bot.api.sendMessage(this.toChatId(chatId), text, {
        parse_mode: options.parseMode,
        disable_notification: options.disableNotification,
        message_thread_id: options.messageThreadId,
        link_preview_options: options.linkPreview === false ? { is_disabled: true } : undefined,
        reply_markup: options.replyMarkup as never,
      });
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
      await bot.api.editMessageText(this.toChatId(chatId), messageId, text, {
        parse_mode: options.parseMode,
        link_preview_options: options.linkPreview === false ? { is_disabled: true } : undefined,
        reply_markup: options.replyMarkup as never,
      });
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
      await bot.api.editMessageReplyMarkup(this.toChatId(chatId), messageId, {
        reply_markup: replyMarkup as never,
      });
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
      return await bot.api.sendPhoto(this.toChatId(chatId), photo, {
        caption,
        parse_mode: options.parseMode,
        message_thread_id: options.messageThreadId,
        reply_markup: options.replyMarkup as never,
      });
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
   * Posts to the admin chat through THIS operator's bot — the review queue and the operator's
   * alerts. The chat id is still the deployment-wide TELEGRAM_ADMIN_CHAT_ID until every operator's
   * own `tenants.admin_chat_id` is wired in.
   */
  async notifyAdmins(
    tenantId: string,
    text: string,
    options: SendOptions = {},
  ): Promise<Message.TextMessage | null> {
    return this.sendMessage(tenantId, this.config.telegram.adminChatId, text, options);
  }

  /**
   * Posts to the OPTIONAL feed chat through this operator's bot — the customer-visible group that
   * mirrors credited deposits.
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
    const feedChatId = this.config.telegram.feedChatId;
    if (feedChatId === null) return null;
    return this.sendMessage(tenantId, feedChatId, text, options);
  }

  /**
   * An alert about the PLATFORM rather than one operator (an Ichancy outage, a ledger invariant, the
   * deployment-wide activity report). It is not sent: tenant zero has no bot, no global bot exists,
   * and where platform alerts should go has not been decided. It returns null, which callers already
   * treat as "the chat is unreachable", and warns so the missing alert is visible in the logs.
   */
  notifyPlatformAdmins(text: string, _options: SendOptions = {}): Promise<null> {
    this.warnPlatformUndeliverable('admin', text);
    return Promise.resolve(null);
  }

  /** The feed-chat twin of notifyPlatformAdmins, with the same answer for the same reason. */
  notifyPlatformFeed(text: string, _options: SendOptions = {}): Promise<null> {
    this.warnPlatformUndeliverable('feed', text);
    return Promise.resolve(null);
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

  private warnPlatformUndeliverable(target: 'admin' | 'feed', text: string): void {
    // The first line only: enough to recognise which alert was lost, without copying a report's
    // figures into the log.
    const firstLine = text.split('\n', 1)[0] ?? '';
    this.logger.warn(
      `Platform ${target} alert not sent: no Telegram bot serves the platform. ` +
        `First line: ${firstLine.slice(0, 120)}`,
    );
  }

  /**
   * Telegram chat ids are 64-bit and we store them as bigint, but the Bot API client takes
   * number | string. Stringifying a bigint is lossless; Number() would not be.
   */
  private toChatId(chatId: bigint | number | string): number | string {
    return typeof chatId === 'bigint' ? chatId.toString() : chatId;
  }
}
