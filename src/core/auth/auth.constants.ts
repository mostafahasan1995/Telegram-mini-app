/**
 * WHY the 300s window is a constant and not a config knob: it is the number Telegram's own docs
 * name for `auth_date` freshness, and it is also the TTL of the replay nonce. If the two ever
 * drifted apart there would be a gap in which an initData is still accepted but its nonce has
 * already expired — i.e. a replay window that reopens. Keeping one constant makes that impossible.
 */

/** Telegram's own recommended freshness bound for `auth_date`. */
export const INIT_DATA_MAX_AGE_SECONDS = 300;

/**
 * Nonce TTL. MUST equal INIT_DATA_MAX_AGE_SECONDS: shorter reopens the replay window, longer just
 * wastes Redis memory on entries that can no longer be presented.
 */
export const INIT_DATA_NONCE_TTL_SECONDS = INIT_DATA_MAX_AGE_SECONDS;

/**
 * Tolerance for an `auth_date` in the FUTURE. Telegram stamps it on their clock, we compare on
 * ours; without a little slack a 3-second NTP drift locks every user out.
 */
export const INIT_DATA_CLOCK_SKEW_SECONDS = 60;

/** 32 bytes = 256 bits of entropy. Stored only as a sha256 digest. */
export const REFRESH_TOKEN_BYTES = 32;

/** Key derivation constant from the Telegram Mini Apps spec. Do not "fix" the capitalisation. */
export const TELEGRAM_HMAC_KEY = 'WebAppData';

/** One-shot marker proving a given initData hash has never been redeemed before. */
export const initDataNonceKey = (hash: string): string => `auth:initdata:${hash}`;

/**
 * Revocation tombstone for a session whose access token has not expired yet. Checked on every
 * authenticated request, so logout and admin-forced revocation take effect immediately instead of
 * after the access token's remaining lifetime.
 */
export const sessionRevocationKey = (sessionId: string): string => `auth:revoked:${sessionId}`;

/** Cached AdminUser lookup by Telegram id (positive AND negative). */
export const adminIdentityKey = (telegramUserId: bigint): string => `admin:tg:${telegramUserId}`;

export const ADMIN_IDENTITY_TTL_SECONDS = 60;

/**
 * `900s` / `15m` / `1h` / `7d` -> seconds. The env schema already guarantees the shape.
 *
 * WHY seconds and not the raw string: `jsonwebtoken`'s types accept `expiresIn` as a `ms`-style
 * template literal, which a plain `string` from config does not satisfy — and casting to it would
 * hide a genuinely malformed value. A number is unambiguous (jsonwebtoken reads a bare number as
 * seconds) and is the same unit the Redis revocation TTL needs, so both derive from one function.
 */
export function ttlToSeconds(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl);
  const amount = match?.[1];
  const unit = match?.[2];
  if (amount === undefined || unit === undefined) {
    throw new Error(`"${ttl}" is not a valid duration (expected e.g. 900s, 15m, 1h, 7d)`);
  }
  const value = Number(amount);
  switch (unit) {
    case 's':
      return value;
    case 'm':
      return value * 60;
    case 'h':
      return value * 3_600;
    default:
      return value * 86_400;
  }
}
