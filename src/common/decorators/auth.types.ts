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
  adminUserId: string;
  telegramUserId: bigint;
  /** Re-read from the database on every request (60s cache), never trusted from the token. */
  role: AdminRole;
  displayName: string;
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
