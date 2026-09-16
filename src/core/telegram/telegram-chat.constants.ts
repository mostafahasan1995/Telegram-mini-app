/**
 * The identifiers of an operator's two Telegram chats: the staff group (review cards and alerts,
 * `tenants.admin_chat_id`) and the feed group (`tenants.feed_chat_id`).
 *
 * WHO MAY CHANGE THEM (owner decision 3, 2026-09-15): the PLATFORM_ADMIN only. Every path that writes
 * either column is a platform route or a one-time link a platform admin issued, and every write is
 * audited with one of the verbs below in that operator's own log.
 */

/** Stable `<entity>.<action>` verbs, the same shape every other audit row uses. */
export const TelegramChatAuditActions = {
  /** A staff or feed group was bound (or rebound) after Telegram verified it. */
  BOUND: 'tenant.telegramChat.bound',
  /** A staff or feed group was removed from an operator. */
  UNBOUND: 'tenant.telegramChat.unbound',
  /** An attempt to bind that did not bind: which link, which chat, and the reason. Never the nonce. */
  BIND_REFUSED: 'tenant.telegramChat.bindRefused',
  /** A one-time "Add bot to group" link was issued. The nonce is never recorded, only the link id. */
  BIND_LINK_ISSUED: 'tenant.telegramChat.bindLinkIssued',
  /** A bound group became a supergroup and every stored id was moved to the new one. */
  MIGRATED: 'tenant.telegramChat.migrated',
} as const;

/** The audit subject of every chat row written for an operator. */
export const TELEGRAM_CHAT_AUDIT_SUBJECT = 'Tenant';

/**
 * How long a bind link can be used. Short, because the link is a bearer credential for pointing an
 * operator's review cards (player names, amounts) at a chat: an owner opens it within a minute or two
 * of clicking the button, and a link found in a browser history a day later must be dead.
 */
export const BIND_LINK_TTL_MINUTES = 15;

/**
 * The admin rights the "Add bot to group" link asks for, in the `admin=` syntax of Telegram's bot
 * deep links (core.telegram.org/api/links, "Bot links": identifiers joined by `+`).
 *  - `manage_chat`: makes the bot an administrator at all, which binding requires; an administrator
 *    also receives every message regardless of privacy mode, and can always be asked about itself.
 *  - `delete_messages`, `pin_messages`: tidy a busy review group.
 *  - `post_messages`: only meaningful in channels, where posting IS an admin right. Harmless in a group
 *    and kept so the same link works if Telegram ever offers a channel for it.
 */
export const BIND_ADMIN_RIGHTS = [
  'post_messages',
  'delete_messages',
  'pin_messages',
  'manage_chat',
] as const;

/** `telegram_updates.handler` for an update the chat projection handled and grammY never saw. */
export const TELEGRAM_CHAT_PROJECTION_HANDLER = 'TelegramChatProjection';
