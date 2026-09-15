/**
 * Pure rules for reading Telegram's chat updates: what the bot's membership means, which updates the
 * chat projection owns, how a bind link and its `/start` command look, and where a supergroup moved.
 * No Nest, no database, no network, so each rule is tested on its own.
 *
 * ══ canPost: THE RULE, AND WHY IT IS NOT `can_post_messages` ═════════════════════════════════════
 * In a group or supergroup posting is not an admin right: any member may post unless restricted.
 * `ChatMemberAdministrator.can_post_messages` exists for CHANNELS only, and ChatMemberAdministrator has
 * no `can_send_messages`, so reading either for a group admin says "cannot post" for every group the
 * bot administers. The Bot API's own fields give:
 *  - group / supergroup: present (creator, administrator, member, or restricted but still a member)
 *    and, when restricted, `can_send_messages`;
 *  - channel: creator, or administrator with `can_post_messages`.
 */
import { createHash, randomBytes } from 'node:crypto';

import { TelegramBotChatStatus, TelegramChatType } from '@prisma/client';
import { GrammyError } from 'grammy';
import type { ChatMember, Message, Update } from 'grammy/types';

import { BIND_ADMIN_RIGHTS } from '../telegram-chat.constants';

export interface MembershipFacts {
  status: TelegramBotChatStatus;
  isAdministrator: boolean;
  isPresent: boolean;
  canPost: boolean;
}

const STATUS_OF: Readonly<Record<ChatMember['status'], TelegramBotChatStatus>> = {
  creator: TelegramBotChatStatus.CREATOR,
  administrator: TelegramBotChatStatus.ADMINISTRATOR,
  member: TelegramBotChatStatus.MEMBER,
  restricted: TelegramBotChatStatus.RESTRICTED,
  left: TelegramBotChatStatus.LEFT,
  kicked: TelegramBotChatStatus.KICKED,
};

/** The recorded type of a Telegram chat, or null for a private chat, which is never recorded. */
export function chatTypeOf(type: string): TelegramChatType | null {
  switch (type) {
    case 'group':
      return TelegramChatType.GROUP;
    case 'supergroup':
      return TelegramChatType.SUPERGROUP;
    case 'channel':
      return TelegramChatType.CHANNEL;
    default:
      return null;
  }
}

/** What one ChatMember of the bot says, by the rule in the header. */
export function membershipFacts(chatType: TelegramChatType, member: ChatMember): MembershipFacts {
  const isAdministrator = member.status === 'creator' || member.status === 'administrator';
  const isPresent =
    isAdministrator ||
    member.status === 'member' ||
    (member.status === 'restricted' && member.is_member);

  const canPost =
    chatType === TelegramChatType.CHANNEL
      ? member.status === 'creator' ||
        (member.status === 'administrator' && member.can_post_messages === true)
      : isPresent && (member.status !== 'restricted' || member.can_send_messages);

  return { status: STATUS_OF[member.status], isAdministrator, isPresent, canPost };
}

/**
 * What `tenants.admin_chat_id` holds while no staff group is bound: the column is NOT NULL, Telegram
 * has no chat 0, and the migrations already wrote 0 for "not configured".
 */
export const UNBOUND_CHAT_ID = 0n;

/** A stored staff or feed chat id as the API speaks of it: null when nothing is bound. */
export function boundChatOf(chatId: bigint | null): bigint | null {
  return chatId === null || chatId === UNBOUND_CHAT_ID ? null : chatId;
}

// ── bind links ──────────────────────────────────────────────────────────────────────────────────

/** 24 CSPRNG bytes: 32 base64url characters, inside Telegram's 64-character startgroup payload. */
const BIND_NONCE_BYTES = 24;

/** Exactly the shape `newBindNonce` produces. Anything else is not one of ours and is ignored. */
export const BIND_NONCE_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export function newBindNonce(): string {
  return randomBytes(BIND_NONCE_BYTES).toString('base64url');
}

/** What is stored. The nonce has 192 bits of entropy, so a plain sha256 cannot be walked back. */
export function hashBindNonce(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('hex');
}

/** `https://t.me/<bot>?startgroup=<nonce>&admin=<rights>`. The nonce is URL-safe as generated. */
export function startGroupUrl(botUsername: string, nonce: string): string {
  return (
    `https://t.me/${encodeURIComponent(botUsername)}?startgroup=${nonce}` +
    `&admin=${BIND_ADMIN_RIGHTS.join('+')}`
  );
}

/**
 * `/start` or `/start@bot`, one space, one payload. Telegram sends exactly `/start@<bot> <payload>`
 * into the group a startgroup link added the bot to. The payload allows more than Telegram's 64
 * characters so the redacted form below (71) parses too; a real nonce is still exactly 32.
 */
const START_WITH_PAYLOAD = /^\/start(?:@([A-Za-z0-9_]{1,64}))?[ \t]+(\S{1,128})[ \t]*$/;

/**
 * ══ THE NONCE NEVER RESTS ANYWHERE ═══════════════════════════════════════════════════════════════
 * A link refused on chat grounds (the bot not yet an administrator) stays usable for its 15 minutes,
 * so the nonce in `/start@bot <nonce>` is a live credential in that window. The webhook therefore
 * replaces it with its sha256 (redactBindNonce) BEFORE the update is written to
 * `telegram_updates.payload` or queued in Redis, and the worker looks the link up by that hash, which
 * is exactly what `telegram_chat_bind_links.nonce_hash` already holds. A reader of the database or
 * Redis learns nothing a reader of the link table did not.
 *
 * Because the worker trusts the redacted form, a person typing it (`/start@bot sha256:<hash>`, with a
 * hash read from the database) must not bind anything: the webhook turns a typed redacted payload into
 * one that is neither shape. The webhook is the only producer of update jobs.
 */
const REDACTED_BIND_PAYLOAD = /^sha256:([0-9a-f]{64})$/;
const REDACTED_PREFIX = 'sha256:';
/** What a typed redacted payload becomes: not a nonce, not a hash, so never a bind. */
const NEUTRALISED_PAYLOAD = '[not-a-bind-link]';

export interface BindCommand {
  /** The bot the command names, without `@`, or null when it names none. */
  mention: string | null;
  /** sha256 hex of the nonce: the only form in which the rest of the pipeline sees it. */
  nonceHash: string;
}

interface StartCommand {
  mention: string | null;
  payload: string;
}

/** `/start[@bot] <payload>` in a group or supergroup message, or null. */
function groupStartCommandOf(message: Message | undefined): StartCommand | null {
  if (message === undefined || message === null || typeof message !== 'object') return null;
  // Read as Partial: this runs on an authenticated body BEFORE its shape is otherwise checked, and a
  // malformed one must be dropped, not crash the webhook into a Telegram retry loop.
  const partial = message as Partial<Message>;
  const chatType = partial.chat?.type;
  if (chatType !== 'group' && chatType !== 'supergroup') return null;
  if (typeof partial.text !== 'string') return null;
  const match = START_WITH_PAYLOAD.exec(partial.text);
  if (match === null) return null;
  return { mention: match[1] ?? null, payload: match[2] ?? '' };
}

/**
 * The bind command in a group message, or null. A private chat never binds anything, and a payload
 * that is neither a nonce nor its redacted hash is some other `/start` (a referral, a deep link) and
 * is left alone. A raw nonce is still read, for a job queued before redaction existed.
 */
export function bindCommandOf(message: Message | undefined): BindCommand | null {
  const command = groupStartCommandOf(message);
  if (command === null) return null;
  if (BIND_NONCE_PATTERN.test(command.payload)) {
    return { mention: command.mention, nonceHash: hashBindNonce(command.payload) };
  }
  const redacted = REDACTED_BIND_PAYLOAD.exec(command.payload);
  if (redacted?.[1] !== undefined) return { mention: command.mention, nonceHash: redacted[1] };
  return null;
}

/**
 * The update as it may be stored and queued: a bind command's nonce replaced by its hash, and a typed
 * redacted payload neutralised (see THE NONCE NEVER RESTS ANYWHERE). Every other update is returned
 * as the same object. Never mutates its argument; the entity offsets stay valid because only the
 * payload after `/start@bot ` changes.
 */
export function redactBindNonce(update: Update): Update {
  const message = (update as Partial<Update> | null | undefined)?.message;
  const command = groupStartCommandOf(message);
  if (message === undefined || command === null) return update;

  let payload: string;
  if (BIND_NONCE_PATTERN.test(command.payload)) {
    payload = `${REDACTED_PREFIX}${hashBindNonce(command.payload)}`;
  } else if (REDACTED_BIND_PAYLOAD.test(command.payload)) {
    payload = NEUTRALISED_PAYLOAD;
  } else {
    return update;
  }
  const head = command.mention === null ? '/start' : `/start@${command.mention}`;
  return { ...update, message: { ...message, text: `${head} ${payload}` } };
}

/**
 * The updates the chat projection owns, and the ONLY ones a SUSPENDED or CLOSED operator's webhook
 * keeps: the bot's membership in a group or channel, a group becoming a supergroup (either half of the
 * service message pair), and the bind command a startgroup link produces. Everything else such an
 * operator receives is still dropped, because it would run bot handlers, money actions included.
 */
export function isChatProjectionUpdate(update: Update | undefined): boolean {
  if (update === undefined || update === null) return false;
  const membership = update.my_chat_member;
  if (membership !== undefined) {
    const chatType = (membership as Partial<typeof membership>).chat?.type;
    return chatType !== undefined && chatTypeOf(chatType) !== null;
  }
  const message = update.message;
  if (message === undefined) return false;
  if (message.migrate_to_chat_id !== undefined || message.migrate_from_chat_id !== undefined) {
    return true;
  }
  return bindCommandOf(message) !== null;
}

// ── supergroup migration ────────────────────────────────────────────────────────────────────────

/**
 * The supergroup a failed call's chat became, when Telegram said so (ResponseParameters
 * `migrate_to_chat_id`), else null. Telegram's description for it matches none of the phrases that
 * mean "undeliverable", so without this the send is rethrown and retried against a dead id forever.
 */
export function migratedChatIdOf(error: unknown): bigint | null {
  if (!(error instanceof GrammyError)) return null;
  const target = error.parameters?.migrate_to_chat_id;
  return typeof target === 'number' && Number.isSafeInteger(target) ? BigInt(target) : null;
}

/** A chat id as a bigint, or null for a `@username` or anything else that is not a number. */
export function numericChatId(chatId: bigint | number | string): bigint | null {
  if (typeof chatId === 'bigint') return chatId;
  if (typeof chatId === 'number') return Number.isSafeInteger(chatId) ? BigInt(chatId) : null;
  return /^-?\d{1,19}$/.test(chatId) ? BigInt(chatId) : null;
}
