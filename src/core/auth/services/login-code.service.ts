/**
 * One-time login codes that let the NATIVE player app sign in as the Telegram account talking to
 * the bot (`/login` in a bot chat, then `POST /v1/auth/bot-code`).
 *
 * THE ADMIN HALF IS GONE. The staff console used to sign in the same way, through the bot's
 * `/console` command and `POST /v1/admin/auth/bot-code`. Both were removed on 2026-09-05 (dashboard
 * API-CONTRACT.md §2a): staff are username+password accounts, most have no Telegram account, and a
 * bot that hands out console credentials leaves them in a chat log. Nothing may mint or redeem an
 * admin code again, which is why 'admin' is no longer a scope this service accepts.
 *
 * WHY A NATIVE APP NEEDS THIS AT ALL: the only other way in is `POST /v1/auth/telegram`, which
 * verifies Telegram initData. initData is produced by the Telegram webview and signed with the bot
 * token; an Android or iOS binary cannot forge it. The bot, however, already knows exactly who is
 * talking to it — Telegram signed the update — so a code minted in a bot chat and redeemed over HTTP
 * carries that proof across to the app.
 *
 * WHY THE SCOPE IS STILL PART OF THE KEY: it keeps the Redis key layout (`login-code:player:...`)
 * that live codes were minted under, and it keeps any future audience structurally apart — a code
 * minted under one scope is simply not found when looked up under another.
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

/**
 * Which audience a code was minted for. Part of the Redis key. Only the player app remains; the
 * retired admin scope must not come back (see the header).
 */
export type LoginCodeScope = 'player';

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
