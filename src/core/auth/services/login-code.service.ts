/**
 * One-time login codes that let a NATIVE app sign in as the Telegram account talking to the bot.
 *
 * WHY THIS LIVES IN core/auth AND NOT IN A MODULE: both `modules/admin` (staff console) and
 * `modules/player` (the player app) need it, and `eslint-plugin-boundaries` makes
 * modules/player -> modules/admin a build failure. Core is the only place both may import, and the
 * mechanism is genuinely identical for the two audiences — only what the redeemed id resolves to
 * differs.
 *
 * WHY A NATIVE APP NEEDS THIS AT ALL: the only other way in is `POST /v1/auth/telegram`, which
 * verifies Telegram initData. initData is produced by the Telegram webview and signed with the bot
 * token; an Android or iOS binary cannot forge it. The bot, however, already knows exactly who is
 * talking to it — Telegram signed the update — so a code minted in a bot chat and redeemed over HTTP
 * carries that proof across to the app.
 *
 * WHY THE SCOPE IS PART OF THE KEY: an admin code must never be redeemable on the player route, nor
 * the reverse. Scoping the Redis key makes that structural rather than a check someone can forget:
 * a code minted for 'player' is simply not found when looked up under 'admin'.
 *
 * WHY THE CODE IS HASHED: the stored value is `sha256(normalized code)`, never the code. A dump of
 * Redis — or a SCAN by anything sharing the instance — would otherwise hand over live credentials
 * for every account that logged in during the last five minutes.
 *
 * WHY REDEMPTION IS `GETDEL`: `GET` then `DEL` lets two racing requests both pass the read and both
 * redeem. GETDEL is one atomic step, so exactly one caller can ever win — the same insert-first
 * reasoning the deposit path uses.
 *
 * WHY MINTING REVOKES THE PREVIOUS CODE: somebody who taps /login three times because the first
 * message was slow should not leave two spare credentials alive until they expire.
 *
 * WHY THE ALPHABET OMITS I, O, 0 and 1: a person reads this off one screen and types it into
 * another, usually on a phone. Ambiguous glyphs turn a working code into a support conversation.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomInt } from 'node:crypto';

import { RedisService } from '../../cache/redis.service';

/** Which audience a code was minted for. Part of the Redis key, so the two can never cross. */
export type LoginCodeScope = 'admin' | 'player';

/** No I, O, 0 or 1 — see the header. 32 symbols keeps the maths easy to reason about. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 32^8 ≈ 1.1e12. With a 5-minute TTL, single use, and the route throttled, that is ample. */
const CODE_LENGTH = 8;

/**
 * Long enough to switch apps and type it; short enough that a shoulder-surfed code dies fast.
 * Declared in MINUTES and multiplied up so callers can print the figure without dividing — this
 * codebase bans `Math.round` outright to keep it away from money.
 */
export const LOGIN_CODE_TTL_MINUTES = 5;
export const LOGIN_CODE_TTL_SECONDS = LOGIN_CODE_TTL_MINUTES * 60;

const codeKey = (scope: LoginCodeScope, hash: string): string => `login-code:${scope}:${hash}`;
const ownerKey = (scope: LoginCodeScope, telegramUserId: string): string =>
  `login-code:${scope}:owner:${telegramUserId}`;

/**
 * Uppercase and drop everything outside the alphabet, so `abcd-efgh`, `ABCD EFGH` and `ABCDEFGH`
 * are the same code. The bot prints the grouped form; people paste back whatever their keyboard
 * produced.
 */
const normalize = (raw: string): string => raw.toUpperCase().replace(/[^A-Z0-9]/g, '');

const hashCode = (normalized: string): string =>
  createHash('sha256').update(normalized, 'utf8').digest('hex');

export interface MintedLoginCode {
  /** Grouped for reading: `ABCD-EFGH`. Redemption accepts it with or without the hyphen. */
  readonly code: string;
  readonly expiresInSeconds: number;
}

@Injectable()
export class LoginCodeService {
  private readonly logger = new Logger(LoginCodeService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Issues a fresh code for a Telegram account and invalidates that account's previous one.
   *
   * The CALLER must have established who this is first — this method trusts its argument. Today
   * both callers are bot handlers, where identity comes from Telegram's own signed update.
   */
  async mint(scope: LoginCodeScope, telegramUserId: bigint): Promise<MintedLoginCode> {
    const plain = Array.from(
      { length: CODE_LENGTH },
      () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
    ).join('');

    const subject = telegramUserId.toString();
    const owner = ownerKey(scope, subject);

    // Retire the previous code before publishing the new one. Read-then-delete is safe here: the
    // worst case of a lost race is one extra code expiring on its own TTL.
    const previous = await this.redis.get(owner);
    if (previous !== null) {
      await this.redis.del(codeKey(scope, previous));
    }

    const hash = hashCode(plain);
    await this.redis.set(codeKey(scope, hash), subject, 'EX', LOGIN_CODE_TTL_SECONDS);
    await this.redis.set(owner, hash, 'EX', LOGIN_CODE_TTL_SECONDS);

    this.logger.log(`Issued ${scope} login code for Telegram ${subject}`);

    return {
      code: `${plain.slice(0, 4)}-${plain.slice(4)}`,
      expiresInSeconds: LOGIN_CODE_TTL_SECONDS,
    };
  }

  /**
   * Redeems a code exactly once and returns the Telegram id behind it, or null.
   *
   * Null covers unknown, already-redeemed, wrong-scope and expired alike — and the caller must not
   * tell them apart to the client, because "that code was real but late" confirms a guess.
   *
   * Returning the TELEGRAM id rather than a resolved account id is deliberate: the caller looks the
   * account up itself, so authority is read at sign-in time and an account deactivated since the
   * code was minted cannot use it.
   */
  async redeem(scope: LoginCodeScope, rawCode: string): Promise<bigint | null> {
    const normalized = normalize(rawCode);
    if (normalized.length !== CODE_LENGTH) return null;

    // Atomic: exactly one concurrent caller can win a code. Requires Redis >= 6.2 (we run 7).
    const subject = await this.redis.getdel(codeKey(scope, hashCode(normalized)));
    if (subject === null) return null;

    await this.redis.del(ownerKey(scope, subject));

    try {
      return BigInt(subject);
    } catch {
      // Only reachable if something else wrote this key. Treat as no code rather than throwing a
      // 500 at someone who typed a valid-looking string.
      this.logger.warn(`Login code resolved to a non-numeric subject: ${subject}`);
      return null;
    }
  }
}
