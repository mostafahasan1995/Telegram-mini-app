/**
 * WHY a facade instead of injecting the Bot everywhere: Telegram fails in ways that are NOT
 * failures of the thing that called it, and every call site would otherwise need the same four
 * try/catch branches. Getting that wrong is expensive here — a deposit is credited, we try to tell
 * the player, the player has blocked the bot, the send throws, the job fails, BullMQ retries, and
 * the credit is attempted a second time. Notification errors must never travel back into money
 * logic.
 *
 * The rules encoded below:
 *  - 403 "bot was blocked" / "chat not found"  -> the message is undeliverable, forever. Not an
 *    error: return null and let the caller carry on.
 *  - 400 "message is not modified"             -> the edit already says what we wanted. Success.
 *  - 400 "message to edit not found"           -> the card was deleted. Return false, do not throw.
 *  - 429 / 5xx                                 -> already retried by autoRetry; if it still fails,
 *    it is a real error and IS thrown, because the caller may want to retry the whole job.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Bot, GrammyError } from 'grammy';
import { type Message, type ParseMode } from 'grammy/types';
import { AppConfigService } from '../../config/config.service';
import { TELEGRAM_BOT } from '../telegram.constants';

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
    @Inject(TELEGRAM_BOT) private readonly bot: Bot,
    private readonly config: AppConfigService,
  ) {}

  /** Direct access for the few places that genuinely need the raw client (file downloads, etc.). */
  get api(): Bot['api'] {
    return this.bot.api;
  }

  get instance(): Bot {
    return this.bot;
  }

  /**
   * Sends a message. Returns null when the chat is permanently unreachable, so a caller can record
   * "notified: no" without treating it as a failure of the operation it was reporting on.
   */
  async sendMessage(
    chatId: bigint | number | string,
    text: string,
    options: SendOptions = {},
  ): Promise<Message.TextMessage | null> {
    try {
      return await this.bot.api.sendMessage(this.toChatId(chatId), text, {
        parse_mode: options.parseMode,
        disable_notification: options.disableNotification,
        message_thread_id: options.messageThreadId,
        link_preview_options: options.linkPreview === false ? { is_disabled: true } : undefined,
        reply_markup: options.replyMarkup as never,
      });
    } catch (error: unknown) {
      if (describes(error, PERMANENTLY_UNDELIVERABLE)) {
        this.logger.warn(
          `Chat ${String(chatId)} is unreachable: ${error instanceof GrammyError ? error.description : ''}`,
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
    chatId: bigint | number | string,
    messageId: number,
    text: string,
    options: SendOptions = {},
  ): Promise<boolean> {
    try {
      await this.bot.api.editMessageText(this.toChatId(chatId), messageId, text, {
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
    chatId: bigint | number | string,
    messageId: number,
    replyMarkup?: unknown,
  ): Promise<boolean> {
    try {
      await this.bot.api.editMessageReplyMarkup(this.toChatId(chatId), messageId, {
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
   * `callback_query_id` (older than ~60s) is an expected, harmless failure.
   */
  async answerCallback(callbackQueryId: string, text?: string, showAlert = false): Promise<void> {
    try {
      await this.bot.api.answerCallbackQuery(callbackQueryId, {
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
    chatId: bigint | number | string,
    photo: string,
    caption?: string,
    options: SendOptions = {},
  ): Promise<Message.PhotoMessage | null> {
    try {
      return await this.bot.api.sendPhoto(this.toChatId(chatId), photo, {
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

  async deleteMessage(chatId: bigint | number | string, messageId: number): Promise<boolean> {
    try {
      await this.bot.api.deleteMessage(this.toChatId(chatId), messageId);
      return true;
    } catch {
      // Deletion is best-effort: the message may already be gone, or too old to delete.
      return false;
    }
  }

  /** Posts to the configured admin chat — the review queue and every operational alert. */
  async notifyAdmins(text: string, options: SendOptions = {}): Promise<Message.TextMessage | null> {
    return this.sendMessage(this.config.telegram.adminChatId, text, options);
  }

  /** Registers our webhook URL. Used by the `webhook:set` CLI command. */
  async setWebhook(
    url: string,
    secretToken: string,
    allowedUpdates: readonly string[],
    dropPendingUpdates = false,
  ): Promise<boolean> {
    return this.bot.api.setWebhook(url, {
      secret_token: secretToken,
      allowed_updates: [...allowedUpdates] as never,
      drop_pending_updates: dropPendingUpdates,
    });
  }

  async deleteWebhook(dropPendingUpdates = false): Promise<boolean> {
    return this.bot.api.deleteWebhook({ drop_pending_updates: dropPendingUpdates });
  }

  async getWebhookInfo(): Promise<Awaited<ReturnType<Bot['api']['getWebhookInfo']>>> {
    return this.bot.api.getWebhookInfo();
  }

  /**
   * Telegram chat ids are 64-bit and we store them as bigint, but the Bot API client takes
   * number | string. Stringifying a bigint is lossless; Number() would not be.
   */
  private toChatId(chatId: bigint | number | string): number | string {
    return typeof chatId === 'bigint' ? chatId.toString() : chatId;
  }
}
