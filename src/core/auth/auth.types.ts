/**
 * WHY `tgid` is a STRING in the JWT: Telegram user ids are 64-bit. `JSON.parse` on a claim set
 * containing `"tgid": 7123456789012345` silently rounds it, and the value we would then look up in
 * `players.telegram_user_id` (a BigInt column) is not the id anyone logged in with. Strings in the
 * token, bigint in the process, never a JS number in between.
 *
 * WHY the role claim is not trusted for admins: it is a snapshot from issue time. An admin demoted
 * from FINANCE_ADMIN to VIEWER would keep approving deposits until their token expired. The guard
 * therefore re-reads the role through AdminIdentityService (60s cache) and uses the token's role
 * only to decide WHICH kind of principal to resolve.
 */
import { type AdminRole } from '@prisma/client';

export const PLAYER_ROLE = 'PLAYER' as const;

export type TokenRole = typeof PLAYER_ROLE | AdminRole;

export interface AccessTokenClaims {
  /** Player.id or AdminUser.id, depending on `role`. */
  sub: string;
  /** Telegram user id as a decimal string. */
  tgid: string;
  role: TokenRole;
  /** PlayerSession.id for players; a random per-token id for admins (they have no session table). */
  sid: string;
  iat: number;
  exp: number;
}

/** The `user` object embedded in Telegram initData. Only fields we actually consume are typed. */
export interface TelegramInitDataUser {
  id: bigint;
  isBot: boolean;
  firstName: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
  isPremium?: boolean;
  allowsWriteToPm?: boolean;
  photoUrl?: string;
}

export interface VerifiedInitData {
  user: TelegramInitDataUser;
  authDate: Date;
  /** The verified hash. Doubles as the replay-nonce identity — do not log it. */
  hash: string;
  queryId?: string;
  /** `start_param`, i.e. the payload from a `t.me/bot/app?startapp=...` deep link. */
  startParam?: string;
  chatType?: string;
  chatInstance?: string;
}

export interface SessionContext {
  ip?: string | null;
  userAgent?: string | null;
  /** `auth_date` from the initData that produced this session; kept to audit stale logins. */
  telegramAuthDate?: Date | null;
}

export interface IssuedSession {
  accessToken: string;
  /**
   * The opaque refresh token, returned EXACTLY ONCE. Only its sha256 is persisted, so it cannot be
   * recovered from the database or from a backup.
   */
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
  sessionId: string;
}
