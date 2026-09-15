/**
 * The shapes of an operator's staff and feed groups on the platform surface: the chat directory
 * (GET /:id/telegram/chats), a bind link (POST /:id/telegram/bind-links) and the `chats` block of
 * GET /:id/health. Ids leave as strings, as every Telegram id on this API does.
 *
 * `DiscoveredChatView` is the dashboard's DiscoveredChatView (src/types/telegram-destination.ts) plus
 * what binding a staff group needs: which of this operator's purposes the chat is bound as, who last
 * changed the bot's membership (so a stranger's group is recognisable before anybody picks it), and
 * where a group that became a supergroup moved to (the old row is kept and should not be picked).
 * `alreadyBound` means "bound as this operator's staff or feed group" here, not "an active destination".
 */
import {
  TelegramChatPurpose,
  type TelegramBotChatStatus,
  type TelegramChatType,
  type TelegramDiscoveredChat,
} from '@prisma/client';

export interface DiscoveredChatView {
  chatId: string;
  chatType: TelegramChatType;
  title: string | null;
  username: string | null;
  status: TelegramBotChatStatus;
  isAdministrator: boolean;
  isPresent: boolean;
  canPost: boolean;
  alreadyBound: boolean;
  boundAs: TelegramChatPurpose[];
  migratedToChatId: string | null;
  lastChangedByTelegramUserId: string | null;
  lastChangedByUsername: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** POST /:id/telegram/bind-links. The nonce is inside `url` only, and is never stored or logged. */
export interface TelegramBindLinkView {
  purpose: TelegramChatPurpose;
  /** `https://t.me/<bot>?startgroup=<nonce>&admin=<rights>`. One use, until `expiresAt`. */
  url: string;
  botUsername: string;
  expiresAt: string;
  /** The rights the link asks Telegram to give the bot, as in its `admin=` parameter. */
  adminRights: string[];
}

/**
 * One bound group in health. Everything but `chatId` is the last sighting, null when the bot was never
 * seen there (a group bound before sightings were recorded). `isPresent: false` is "the bot was removed
 * from this group": the binding is kept, and nothing reaches the group until a human acts.
 */
export interface BoundChatHealthView {
  chatId: string | null;
  title: string | null;
  status: TelegramBotChatStatus | null;
  isPresent: boolean | null;
  isAdministrator: boolean | null;
  canPost: boolean | null;
  lastSeenAt: string | null;
}

export interface TenantChatsHealthView {
  staff: BoundChatHealthView;
  feed: BoundChatHealthView;
}

/** The operator's bound chats, null for "not bound". */
export interface BoundChats {
  staff: bigint | null;
  feed: bigint | null;
}

export function toDiscoveredChatView(
  row: TelegramDiscoveredChat,
  bound: BoundChats,
): DiscoveredChatView {
  const boundAs: TelegramChatPurpose[] = [
    ...(bound.staff === row.chatId ? [TelegramChatPurpose.STAFF] : []),
    ...(bound.feed === row.chatId ? [TelegramChatPurpose.FEED] : []),
  ];
  return {
    chatId: row.chatId.toString(),
    chatType: row.chatType,
    title: row.title,
    username: row.username,
    status: row.status,
    isAdministrator: row.isAdministrator,
    isPresent: row.isPresent,
    canPost: row.canPost,
    alreadyBound: boundAs.length > 0,
    boundAs,
    migratedToChatId: row.migratedToChatId === null ? null : row.migratedToChatId.toString(),
    lastChangedByTelegramUserId:
      row.lastChangedByTelegramUserId === null ? null : row.lastChangedByTelegramUserId.toString(),
    lastChangedByUsername: row.lastChangedByUsername,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

export function boundChatHealth(
  chatId: bigint | null,
  sighting: TelegramDiscoveredChat | undefined,
): BoundChatHealthView {
  return {
    chatId: chatId === null ? null : chatId.toString(),
    title: sighting?.title ?? null,
    status: sighting?.status ?? null,
    isPresent: sighting?.isPresent ?? null,
    isAdministrator: sighting?.isAdministrator ?? null,
    canPost: sighting?.canPost ?? null,
    lastSeenAt: sighting === undefined ? null : sighting.lastSeenAt.toISOString(),
  };
}
