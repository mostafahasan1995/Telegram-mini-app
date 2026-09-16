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
 *
 * ══ WHOSE BOT TOKEN ═════════════════════════════════════════════════════════════════════════════
 * initData is signed with the token of the bot whose web app the player opened, and every operator
 * has its own bot, sealed in `tenants.bot_token_enc`. There is no deployment-wide token. So the
 * caller names the operator, and the key is derived from THAT operator's token.
 *
 * WHY NOTHING HAPPENS AT CONSTRUCTION: AuthModule is loaded by the api AND the worker. Deriving a key
 * in the constructor meant a missing or unreadable token stopped both processes from booting, for a
 * route the worker never serves. The key is resolved on the first request that needs it, and a
 * token that cannot be opened fails THAT request with a 503, not the process.
 *
 * CACHED PER TENANT, EVICTED ON TOKEN CHANGE: the derived key is kept with the sealed value it came
 * from. At most every INIT_DATA_KEY_RECHECK_SECONDS the sealed column is re-read (one primary-key
 * lookup); a different value — the token was changed in the dashboard, possibly through another
 * process — drops the old key before it can verify anything else. `invalidate()` does the same at
 * once for a change made in this process.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ServiceUnavailableError, UnauthorizedError } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';
import { PrismaService } from '../../prisma/prisma.service';
import {
  TenantSecretService,
  isTenantSecretError,
} from '../../tenant/services/tenant-secret.service';
import {
  INIT_DATA_CLOCK_SKEW_SECONDS,
  INIT_DATA_MAX_AGE_SECONDS,
  TELEGRAM_HMAC_KEY,
} from '../auth.constants';
import { type TelegramInitDataUser, type VerifiedInitData } from '../auth.types';

/** A sha256 hex digest and nothing else. */
const HEX_64 = /^[0-9a-f]{64}$/i;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How long a derived key is trusted before its sealed token is re-read. The same bound, for the same
 * reason, as TENANT_BOT_RECHECK_SECONDS: a token changed from the dashboard lands in another process.
 * Restated rather than imported, because core/auth has no business depending on core/telegram.
 */
export const INIT_DATA_KEY_RECHECK_SECONDS = 30;

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

interface DerivedKey {
  /** The `bot_token_enc` value the key was derived from; a different value means a new token. */
  sealedToken: string;
  key: Buffer;
  /** Date.now() when the sealed value was last confirmed unchanged. */
  verifiedAt: number;
}

@Injectable()
export class InitDataService {
  private readonly logger = new Logger(InitDataService.name);

  private readonly keys = new Map<string, DerivedKey>();
  private readonly loading = new Map<string, Promise<Buffer>>();
  /**
   * tenantId -> how many times invalidate() was called for it. A load that started before an
   * invalidate() read the row BEFORE the change, so it must not put its key back into `keys`
   * afterwards; comparing generations is how it knows.
   */
  private readonly generations = new Map<string, number>();
  /** tenantId -> the failure already logged, so a misconfigured operator logs once, not per tap. */
  private readonly loggedFailures = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: TenantSecretService,
  ) {}

  /**
   * Verifies raw initData against the bot of `tenantId` and returns its authenticated contents.
   * Throws UnauthorizedError with a stable code on every verification failure — never returns a
   * partial or "probably fine" result — and ServiceUnavailableError (INIT_DATA_BOT_UNAVAILABLE) when
   * that operator has no bot token this process can use.
   *
   * @param raw the exact `Telegram.WebApp.initData` string, untouched by the client.
   * @param tenantId the operator whose bot's web app produced it.
   */
  async verify(
    raw: string,
    tenantId: string,
    maxAgeSeconds: number = INIT_DATA_MAX_AGE_SECONDS,
  ): Promise<VerifiedInitData> {
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

    // STEP 5 + 6 — secret is HMAC(key="WebAppData", msg=this operator's bot token), resolved only
    // now: everything above rejects garbage without a database read. Expected is
    // HMAC(key=secret, msg=dataCheckString), hex encoded.
    const secretKey = await this.secretKeyFor(tenantId);
    const expected = createHmac('sha256', secretKey).update(dataCheckString).digest();
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

  /**
   * Forget the key derived for this operator. MUST be called by whatever changes its bot token in
   * this process; other processes notice within INIT_DATA_KEY_RECHECK_SECONDS.
   */
  invalidate(tenantId: string): void {
    this.generations.set(tenantId, this.generationOf(tenantId) + 1);
    this.keys.delete(tenantId);
    // A load already in flight read the old row; the next request must not join it.
    this.loading.delete(tenantId);
    this.loggedFailures.delete(tenantId);
  }

  private generationOf(tenantId: string): number {
    return this.generations.get(tenantId) ?? 0;
  }

  private secretKeyFor(tenantId: string): Promise<Buffer> {
    const cached = this.keys.get(tenantId);
    if (
      cached !== undefined &&
      Date.now() - cached.verifiedAt < INIT_DATA_KEY_RECHECK_SECONDS * 1_000
    ) {
      return Promise.resolve(cached.key);
    }

    // Concurrent sign-ins for one operator share one read.
    const pending = this.loading.get(tenantId);
    if (pending !== undefined) return pending;

    const load = this.loadKey(tenantId, this.generationOf(tenantId)).finally(() => {
      // Only its own entry: after an invalidate() the slot may already hold a newer load.
      if (this.loading.get(tenantId) === load) this.loading.delete(tenantId);
    });
    this.loading.set(tenantId, load);
    return load;
  }

  private async loadKey(tenantId: string, generation: number): Promise<Buffer> {
    // A malformed id would make Postgres raise 22P02 instead of returning no row.
    const row = UUID.test(tenantId)
      ? await this.prisma.tenant.findUnique({
          where: { id: tenantId },
          select: { botTokenEnc: true },
        })
      : null;

    // invalidate() ran while the row was being read. This request began before it, so it may finish
    // with what it read — but nothing it read is cached, and the key cache is left as invalidate()
    // left it. The next request loads afresh.
    const superseded = generation !== this.generationOf(tenantId);

    if (row === null) {
      if (!superseded) this.keys.delete(tenantId);
      throw this.unavailable(tenantId, 'NO_TENANT', `there is no tenant ${tenantId}`);
    }

    const cached = superseded ? undefined : this.keys.get(tenantId);
    if (cached !== undefined && cached.sealedToken === row.botTokenEnc) {
      cached.verifiedAt = Date.now();
      return cached.key;
    }
    // A different sealed value is a different token: the old key must not verify one more request.
    if (!superseded) this.keys.delete(tenantId);

    let token: string;
    try {
      token = this.secrets.openBotToken({ id: tenantId, botTokenEnc: row.botTokenEnc });
    } catch (error: unknown) {
      if (!isTenantSecretError(error)) throw error;
      // TenantSecretError messages name the field and the tenant, never a value.
      throw this.unavailable(tenantId, error.code, error.message);
    }

    const key = createHmac('sha256', TELEGRAM_HMAC_KEY).update(token).digest();
    if (!superseded) {
      this.keys.set(tenantId, { sealedToken: row.botTokenEnc, key, verifiedAt: Date.now() });
      this.loggedFailures.delete(tenantId);
    }
    return key;
  }

  private unavailable(tenantId: string, reason: string, detail: string): ServiceUnavailableError {
    if (this.loggedFailures.get(tenantId) !== reason) {
      this.loggedFailures.set(tenantId, reason);
      this.logger.error(
        `Mini App sign-in is unavailable for tenant ${tenantId} (${reason}): ${detail}. ` +
          'Set that operator’s bot token from the dashboard. Logged once until it changes.',
      );
    }
    return new ServiceUnavailableError(
      CommonErrorCodes.INIT_DATA_BOT_UNAVAILABLE,
      'Sign-in through Telegram is not available for this operator right now.',
    );
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
