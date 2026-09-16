/**
 * Asks Telegram, at this moment, whether an operator's bot can be bound to a chat as its staff or feed
 * group. Nothing is ever bound on the strength of a sighting, a form value or a link alone: this runs
 * first, every time, through the bot that will do the posting.
 *
 * THE CHECKS, in the order a human fixes them, each its own reason (the dashboard's destination
 * reasons, API-CONTRACT.md "Telegram destinations"):
 *  - NOT_FOUND           Telegram does not know the chat, or will not show it to this bot;
 *  - PRIVATE_CHAT        it is a one-to-one chat;
 *  - CHANNEL_NOT_ALLOWED it is a channel: review buttons are tapped by staff in a group, and a channel
 *                        has no members who can tap them (owner decision: groups only);
 *  - BOT_NOT_MEMBER      the bot is not in it, or left, or was removed;
 *  - BOT_NOT_ADMIN       it is in it, but not an administrator;
 *  - BOT_CANNOT_POST     an administrator that may still not post (see chat-membership.util canPost).
 *
 * A GROUP THAT BECAME A SUPERGROUP has a new id, and Telegram answers the old one with
 * `migrate_to_chat_id`. The check follows it once and reports both ids, so the caller binds the new id
 * and moves anything stored under the old one, never saving the dead id.
 *
 * WHAT IS THROWN, NOT REPORTED: a Telegram that cannot be reached, a 429/5xx, and a token Telegram no
 * longer accepts. None of them says anything about the chat, so the caller maps them (a 503, a 422 for
 * the token) or lets a job retry.
 */
import { TelegramChatType } from '@prisma/client';
import { type Api, GrammyError } from 'grammy';
import type { ChatFullInfo, ChatMember } from 'grammy/types';

import {
  chatTypeOf,
  membershipFacts,
  migratedChatIdOf,
  type MembershipFacts,
} from './chat-membership.util';

export const CHAT_REJECTION_REASONS = [
  'NOT_FOUND',
  'PRIVATE_CHAT',
  'CHANNEL_NOT_ALLOWED',
  'BOT_NOT_MEMBER',
  'BOT_NOT_ADMIN',
  'BOT_CANNOT_POST',
] as const;

export type ChatRejectionReason = (typeof CHAT_REJECTION_REASONS)[number];

/** The two calls the check makes. A structural slice of grammY's Api, so a spec can stub it. */
export type ChatLookupApi = Pick<Api, 'getChat' | 'getChatMember'>;

export interface VerifiedChat {
  chatId: bigint;
  chatType: TelegramChatType;
  title: string | null;
  username: string | null;
  facts: MembershipFacts;
}

export type ChatVerification =
  | { ok: true; chat: VerifiedChat; migratedFrom: bigint | null }
  | {
      ok: false;
      reason: ChatRejectionReason;
      /** Telegram's own words when it gave any, never a paraphrase. */
      detail: string | null;
      /** The id that was checked last: the supergroup's, when the group had moved. */
      chatId: bigint;
      migratedFrom: bigint | null;
    };

type Lookup =
  | { kind: 'found'; chat: ChatFullInfo; chatId: bigint; migratedFrom: bigint | null }
  | Extract<ChatVerification, { ok: false }>;

/** Telegram's refusals of a lookup that are about the chat or the bot's place in it. */
function refusedLookup(
  error: unknown,
  chatId: bigint,
  migratedFrom: bigint | null,
  forbidden: ChatRejectionReason,
): Extract<ChatVerification, { ok: false }> | null {
  if (!(error instanceof GrammyError)) return null;
  if (error.error_code === 400) {
    return { ok: false, reason: 'NOT_FOUND', detail: error.description, chatId, migratedFrom };
  }
  if (error.error_code === 403) {
    return { ok: false, reason: forbidden, detail: error.description, chatId, migratedFrom };
  }
  return null;
}

async function lookUpChat(api: ChatLookupApi, chatId: bigint): Promise<Lookup> {
  try {
    return { kind: 'found', chat: await api.getChat(chatId.toString()), chatId, migratedFrom: null };
  } catch (error: unknown) {
    const movedTo = migratedChatIdOf(error);
    if (movedTo === null) {
      const refused = refusedLookup(error, chatId, null, 'BOT_NOT_MEMBER');
      if (refused === null) throw error;
      return refused;
    }
    // Followed once: a supergroup does not migrate again.
    try {
      const chat = await api.getChat(movedTo.toString());
      return { kind: 'found', chat, chatId: movedTo, migratedFrom: chatId };
    } catch (second: unknown) {
      const refused = refusedLookup(second, movedTo, chatId, 'BOT_NOT_MEMBER');
      if (refused === null) throw second;
      return refused;
    }
  }
}

function titleOf(chat: ChatFullInfo): string | null {
  return chat.type === 'private' ? null : chat.title;
}

function usernameOf(chat: ChatFullInfo): string | null {
  return chat.type === 'group' ? null : (chat.username ?? null);
}

export async function verifyTelegramChat(
  api: ChatLookupApi,
  botId: number,
  chatId: bigint,
): Promise<ChatVerification> {
  const lookup = await lookUpChat(api, chatId);
  if ('ok' in lookup) return lookup;
  const { chat, migratedFrom } = lookup;
  const target = lookup.chatId;
  const refuse = (reason: ChatRejectionReason, detail: string | null = null): ChatVerification => ({
    ok: false,
    reason,
    detail,
    chatId: target,
    migratedFrom,
  });

  const chatType = chatTypeOf(chat.type);
  if (chatType === null) return refuse('PRIVATE_CHAT');
  if (chatType === TelegramChatType.CHANNEL) return refuse('CHANNEL_NOT_ALLOWED');

  let member: ChatMember;
  try {
    // The bot asking about itself, which Telegram answers whether or not it is an administrator.
    member = await api.getChatMember(target.toString(), botId);
  } catch (error: unknown) {
    const refused = refusedLookup(error, target, migratedFrom, 'BOT_NOT_MEMBER');
    if (refused === null) throw error;
    // A 400 here is "member not found": the chat exists, the bot is simply not in it.
    return refuse('BOT_NOT_MEMBER', refused.detail);
  }

  const facts = membershipFacts(chatType, member);
  if (!facts.isPresent) return refuse('BOT_NOT_MEMBER');
  if (!facts.isAdministrator) return refuse('BOT_NOT_ADMIN');
  if (!facts.canPost) return refuse('BOT_CANNOT_POST');

  return {
    ok: true,
    chat: { chatId: target, chatType, title: titleOf(chat), username: usernameOf(chat), facts },
    migratedFrom,
  };
}
