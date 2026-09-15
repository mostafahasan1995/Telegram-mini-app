/**
 * The refusal every console path answers when Telegram says a chat cannot be bound.
 *
 * WHY THIS CODE: the dashboard already defines `TELEGRAM_CHAT_REJECTED` as a 400 whose
 * `details.reason` names what failed (API-CONTRACT.md, "Telegram destinations"), and its console
 * already has a sentence for each reason. Binding a staff or feed group fails for the same reasons,
 * fixed by the same people, so it answers the same way. One reason is added: CHANNEL_NOT_ALLOWED,
 * because a staff group has to be a group.
 *
 * `details`: `{ reason, purpose, field, chatId, detail }`. `field` names the request field that carried
 * the chat (`chatId`, `adminChatId`, `feedChatId`), `chatId` the id finally checked (a supergroup's,
 * when the group had moved), and `detail` Telegram's own words, when it gave any.
 */
import type { TelegramChatPurpose } from '@prisma/client';

import { ValidationError } from '@common/exceptions/app.exception';

import type { ChatRejectionReason } from '../utils/chat-verification.util';

export const TelegramChatErrorCodes = {
  TELEGRAM_CHAT_REJECTED: 'TELEGRAM_CHAT_REJECTED',
} as const;

const SENTENCES: Readonly<Record<ChatRejectionReason, string>> = {
  NOT_FOUND:
    'Telegram does not know this chat, or will not show it to this bot. Add the bot to the group first.',
  PRIVATE_CHAT: 'This is a one-to-one chat. A staff or feed group must be a group.',
  CHANNEL_NOT_ALLOWED:
    'This is a channel. A staff or feed group must be a group, where staff can tap the review buttons.',
  BOT_NOT_MEMBER: 'The bot is not a member of this group. Add it to the group, then try again.',
  BOT_NOT_ADMIN:
    'The bot is in this group but is not an administrator. Make it an administrator, then try again.',
  BOT_CANNOT_POST:
    'The bot is not allowed to send messages in this group. Allow it to post, then try again.',
};

export interface ChatRejectionInput {
  reason: ChatRejectionReason;
  purpose: TelegramChatPurpose;
  field: string;
  chatId: bigint;
  detail: string | null;
}

export function chatRejected(input: ChatRejectionInput): ValidationError {
  return new ValidationError(
    `${SENTENCES[input.reason]} Nothing was saved.`,
    {
      reason: input.reason,
      purpose: input.purpose,
      field: input.field,
      chatId: input.chatId.toString(),
      detail: input.detail,
    },
    TelegramChatErrorCodes.TELEGRAM_CHAT_REJECTED,
  );
}
