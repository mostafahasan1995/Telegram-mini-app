/**
 * WHY this contract lives in `common` and not in `core/auth`: the guards that ATTACH the principal
 * are in core, but the param decorators that READ it are in common, and common may not import core.
 * Putting the shape here makes the request-attachment contract explicit and lets both sides depend
 * on it without a layering violation.
 *
 * Telegram ids are bigint on purpose — they exceed 2^53 and `players.telegram_user_id` is a BigInt
 * column. Never narrow one to `number` on the way through.
 */
import { type AdminRole } from '@prisma/client';

/** Request property the AuthGuard writes the player principal to. */
export const REQUEST_PLAYER_KEY = 'player' as const;

/** Request property the AuthGuard writes the admin principal to. */
export const REQUEST_ADMIN_KEY = 'admin' as const;

export interface AuthenticatedPlayer {
  playerId: string;
  telegramUserId: bigint;
  /** PlayerSession.id behind the access token — needed to revoke exactly this device. */
  sessionId: string;
}

export interface AuthenticatedAdmin {
  /** The identity. An HTTP request resolves an admin by (home tenant, this id) and nothing else. */
  adminUserId: string;
  /**
   * Null for a console-only account (username + password). Never use it to decide WHO an HTTP
   * caller is; it exists so the bot can recognise the staff who have a Telegram account.
   */
  telegramUserId: bigint | null;
  /**
   * The operator this admin's row lives in — their HOME tenant, never the one an X-Tenant-Id
   * header asked for. Carried on the principal because authority is measured here: a
   * PLATFORM_ADMIN is only platform staff if this is tenant zero.
   */
  tenantId: string;
  /** Re-read from the database on every request (60s cache), never trusted from the token. */
  role: AdminRole;
  displayName: string;
}

/**
 * An admin found BY Telegram id — the bot's view of staff. The id cannot be null here: the row was
 * matched on it, and a NULL never equals a Telegram id. Typing that fact lets bot-only code (login
 * codes, chat menus) use the id without a null check that could never fire.
 */
export interface TelegramAuthenticatedAdmin extends AuthenticatedAdmin {
  telegramUserId: bigint;
}

/**
 * What a route demands of its caller. `undefined` means "no explicit requirement", which the guard
 * treats as "any authenticated principal" — fail closed, never fail open.
 */
export type AuthRequirement = { kind: 'PLAYER' } | { kind: 'ADMIN'; roles: readonly AdminRole[] };

export interface RequestPrincipals {
  [REQUEST_PLAYER_KEY]?: AuthenticatedPlayer;
  [REQUEST_ADMIN_KEY]?: AuthenticatedAdmin;
}
