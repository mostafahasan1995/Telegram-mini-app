/**
 * Telegram Mini App initData verification, hand-rolled.
 *
 * WHY hand-rolled: this is the ONLY thing standing between a stranger and a session on somebody
 * else's cashier account. A dependency here is a supply-chain risk on the authentication path, and
 * the algorithm is 20 lines. What it is NOT is obvious — every step below has a specific way of
 * being wrong that still "works" in testing and is exploitable in production.
 *
 * The algorithm (Telegram Mini Apps spec):
 *   secret_key       = HMAC_SHA256(key: "WebAppData", message: bot_token)
 *   data_check_string = the remaining "key=value" pairs, sorted by key, joined with "\n"
 *   expected          = hex(HMAC_SHA256(key: secret_key, message: data_check_string))
 *   valid            <=> expected == received hash
 *
 * Note the inversion in the first line: the STRING "WebAppData" is the HMAC key and the BOT TOKEN
 * is the message. Swapping them produces a stable, plausible-looking digest that never matches a
 * real client — and, worse, would match a forged one built the same wrong way.
 */
import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { UnauthorizedError } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';
import { AppConfigService } from '../../config/config.service';
import {
  INIT_DATA_CLOCK_SKEW_SECONDS,
  INIT_DATA_MAX_AGE_SECONDS,
  TELEGRAM_HMAC_KEY,
} from '../auth.constants';
import { type TelegramInitDataUser, type VerifiedInitData } from '../auth.types';

/** A sha256 hex digest and nothing else. */
const HEX_64 = /^[0-9a-f]{64}$/i;

interface RawTelegramUser {
  id?: unknown;
  is_bot?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  username?: unknown;
  language_code?: unknown;
  is_premium?: unknown;
  allows_write_to_pm?: unknown;
  photo_url?: unknown;
}

@Injectable()
export class InitDataService {
  /**
   * Derived once at construction: it depends only on the bot token, and re-deriving it per request
   * would be pure waste on the hottest auth path.
   */
  private readonly secretKey: Buffer;

  constructor(config: AppConfigService) {
    this.secretKey = createHmac('sha256', TELEGRAM_HMAC_KEY)
      .update(config.telegram.botToken)
      .digest();
  }

  /**
   * Verifies raw initData and returns its authenticated contents.
   * Throws UnauthorizedError with a stable code on every failure path — never returns a partial or
   * "probably fine" result.
   *
   * @param raw the exact `Telegram.WebApp.initData` string, untouched by the client.
   */
  verify(raw: string, maxAgeSeconds: number = INIT_DATA_MAX_AGE_SECONDS): VerifiedInitData {
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new UnauthorizedError(
        CommonErrorCodes.INIT_DATA_MALFORMED,
        'Telegram initData is missing.',
      );
    }

    // STEP 1 — Parse with URLSearchParams, never by splitting on '&' and '='.
    // Values are percent-encoded and the `user` field is JSON containing '&', '=' and '+' in real
    // names. A hand-rolled split silently truncates those, producing a data-check-string that
    // disagrees with Telegram's for exactly the users whose names contain punctuation.
    // URLSearchParams also returns values already DECODED, which is what the spec requires.
    const params = new URLSearchParams(raw);

    // STEP 2 — Pull out the hash. Its absence is a hard failure, not "no hash, no check".
    const hash = params.get('hash');
    if (hash === null || hash.length === 0) {
      throw new UnauthorizedError(
        CommonErrorCodes.INIT_DATA_HASH_MISSING,
        'Telegram initData has no hash.',
      );
    }
    // Reject a non-hex hash up front: Buffer.from('zz', 'hex') does NOT throw, it returns a
    // truncated buffer. That would silently turn the length check below into the whole comparison.
    if (!HEX_64.test(hash)) {
      throw new UnauthorizedError(
        CommonErrorCodes.INIT_DATA_HASH_INVALID,
        'Telegram initData hash is malformed.',
      );
    }

    // STEP 3 — Remove BOTH 'hash' AND 'signature' before building the data-check-string.
    // 'hash' is obvious. 'signature' is the newer Ed25519 field Telegram added for third-party
    // validation; it is NOT part of the HMAC data-check-string. Leaving it in makes verification
    // fail for every modern client while still passing against older fixtures — a bug that looks
    // like "some users can't log in".
    params.delete('hash');
    params.delete('signature');

    // STEP 4 — Sort remaining keys ascending and join "k=v" with '\n'.
    // The sort MUST be by UTF-16 code unit (plain `<`), not `localeCompare`: under a locale like
    // tr-TR, 'i' and 'I' collate differently and the string stops matching Telegram's.
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    // STEP 5 + 6 — secret is HMAC(key="WebAppData", msg=botToken) (done once, in the constructor);
    // expected is HMAC(key=secret, msg=dataCheckString), hex encoded.
    const expected = createHmac('sha256', this.secretKey).update(dataCheckString).digest();
    const provided = Buffer.from(hash, 'hex');

    // STEP 7 — Constant-time comparison. `===` on the hex strings leaks, through timing, how many
    // leading characters were right, which is enough to forge a hash byte by byte given enough
    // attempts. timingSafeEqual THROWS on a length mismatch, so the lengths are checked first
    // (both are 32 bytes here by construction, but the guard is what makes that safe to assume).
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new UnauthorizedError(
        CommonErrorCodes.INIT_DATA_HASH_INVALID,
        'Telegram initData failed signature verification.',
      );
    }

    // ---- everything below this line is now AUTHENTICATED data ----

    // STEP 8 — Freshness. A valid signature is forever; without this check, an initData captured
    // from a log or a shared screenshot logs the attacker in months later.
    const authDateRaw = params.get('auth_date');
    if (authDateRaw === null || !/^\d+$/.test(authDateRaw)) {
      throw new UnauthorizedError(
        CommonErrorCodes.INIT_DATA_AUTH_DATE_MISSING,
        'Telegram initData has no usable auth_date.',
      );
    }
    const authDateSeconds = Number(authDateRaw);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const ageSeconds = nowSeconds - authDateSeconds;

    if (ageSeconds > maxAgeSeconds) {
      throw new UnauthorizedError(
        CommonErrorCodes.INIT_DATA_EXPIRED,
        'Telegram initData has expired. Please reopen the app.',
      );
    }
    // A far-future auth_date means a broken or hostile clock; a little skew is normal.
    if (ageSeconds < -INIT_DATA_CLOCK_SKEW_SECONDS) {
      throw new UnauthorizedError(
        CommonErrorCodes.INIT_DATA_EXPIRED,
        'Telegram initData is not yet valid.',
      );
    }

    // STEP 9 — Only NOW parse the user JSON. Doing it before the hash check would hand an
    // unauthenticated string to JSON.parse and then to whatever reads `user.id` — the classic
    // "parse first, authenticate later" mistake.
    const userRaw = params.get('user');
    if (userRaw === null || userRaw.length === 0) {
      throw new UnauthorizedError(
        CommonErrorCodes.INIT_DATA_USER_MISSING,
        'Telegram initData contains no user.',
      );
    }

    const result: VerifiedInitData = {
      user: this.parseUser(userRaw),
      authDate: new Date(authDateSeconds * 1000),
      hash,
    };

    const queryId = params.get('query_id');
    if (queryId !== null) result.queryId = queryId;
    const startParam = params.get('start_param');
    if (startParam !== null) result.startParam = startParam;
    const chatType = params.get('chat_type');
    if (chatType !== null) result.chatType = chatType;
    const chatInstance = params.get('chat_instance');
    if (chatInstance !== null) result.chatInstance = chatInstance;

    return result;
  }

  private parseUser(userRaw: string): TelegramInitDataUser {
    let parsed: RawTelegramUser;
    try {
      parsed = JSON.parse(userRaw) as RawTelegramUser;
    } catch {
      throw new UnauthorizedError(
        CommonErrorCodes.INIT_DATA_MALFORMED,
        'Telegram initData user payload is not valid JSON.',
      );
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new UnauthorizedError(
        CommonErrorCodes.INIT_DATA_MALFORMED,
        'Telegram initData user payload is not an object.',
      );
    }

    // The id arrives as a JSON number. Telegram ids are below 2^53 today, but they are documented
    // as 64-bit, so anything that is not exactly representable is refused rather than rounded into
    // a DIFFERENT user's account.
    const id = parsed.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      throw new UnauthorizedError(
        CommonErrorCodes.INIT_DATA_MALFORMED,
        'Telegram initData user id is not a valid Telegram id.',
      );
    }

    const user: TelegramInitDataUser = {
      id: BigInt(id),
      isBot: parsed.is_bot === true,
      firstName: typeof parsed.first_name === 'string' ? parsed.first_name : '',
    };

    if (typeof parsed.last_name === 'string') user.lastName = parsed.last_name;
    if (typeof parsed.username === 'string') user.username = parsed.username;
    if (typeof parsed.language_code === 'string') user.languageCode = parsed.language_code;
    if (typeof parsed.is_premium === 'boolean') user.isPremium = parsed.is_premium;
    if (typeof parsed.allows_write_to_pm === 'boolean') {
      user.allowsWriteToPm = parsed.allows_write_to_pm;
    }
    if (typeof parsed.photo_url === 'string') user.photoUrl = parsed.photo_url;

    return user;
  }
}
