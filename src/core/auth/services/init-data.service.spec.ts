/**
 * WHY the fixture is generated rather than hard-coded: a captured real initData is bound to a real
 * bot token (which we will not commit) and to a real `auth_date` (which goes stale, so the suite
 * would start failing five minutes after it was written). Generating one per test with the same
 * published algorithm keeps the tests honest AND stable.
 *
 * The signer below is written independently of the service — straight from the spec text — so a
 * bug copied into both would have to be made twice, in two different shapes.
 *
 * The bot tokens are SEALED onto fake tenant rows with the real TenantSecretService, the way the
 * dashboard stores them, so the part of the service that finds an operator's token is exercised too.
 */
import { createHmac } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { AppException } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';
import { type PrismaService } from '../../prisma/prisma.service';
import { TenantSecretService } from '../../tenant/services/tenant-secret.service';
import { INIT_DATA_KEY_RECHECK_SECONDS, InitDataService } from './init-data.service';

const BOT_TOKEN = '123456789:AAF-fakeTokenForTestsOnly_0123456789abc';
const OTHER_BOT_TOKEN = '987654321:BBQ-anotherFakeToken_0123456789abcdef';
const ROTATED_BOT_TOKEN = '123456789:CCR-rotatedFakeToken_0123456789abcdef';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const TENANT_UNSET = '33333333-3333-4333-8333-333333333333';
const TENANT_MISSING = '44444444-4444-4444-8444-444444444444';

const secrets = new TenantSecretService('init-data-spec-root-secret-0123456789');

/** Reference implementation of the Telegram data-check-string signature. */
function signInitData(fields: Record<string, string>, botToken: string): string {
  const dataCheckString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  return createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
}

/** Serializes signed fields (plus anything excluded from the signature) into an initData string. */
function encodeInitData(
  fields: Record<string, string>,
  extras: Record<string, string> = {},
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) params.set(key, value);
  for (const [key, value] of Object.entries(extras)) params.set(key, value);
  return params.toString();
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function baseFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    auth_date: String(nowSeconds()),
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    user: JSON.stringify({
      id: 279058397,
      first_name: 'Test',
      last_name: 'User',
      username: 'testuser',
      language_code: 'en',
      is_premium: true,
      allows_write_to_pm: true,
    }),
    ...overrides,
  };
}

/** Signs `fields` and returns the complete initData string. */
function validInitData(
  overrides: Record<string, string> = {},
  extras: Record<string, string> = {},
  botToken: string = BOT_TOKEN,
): string {
  const fields = baseFields(overrides);
  const hash = signInitData(fields, botToken);
  return encodeInitData(fields, { ...extras, hash });
}

interface Harness {
  service: InitDataService;
  findUnique: jest.Mock;
  /** The sealed `bot_token_enc` of each fake tenant row, editable to simulate a dashboard change. */
  rows: Map<string, string>;
}

function makeHarness(): Harness {
  const rows = new Map<string, string>([
    [TENANT_A, secrets.sealBotToken(BOT_TOKEN)],
    [TENANT_B, secrets.sealBotToken(OTHER_BOT_TOKEN)],
    // What the multi-tenant migration writes before anybody sets a token.
    [TENANT_UNSET, 'REPLACE-ME-BOT-TOKEN'],
  ]);
  const findUnique = jest.fn((args: { where: { id: string } }) => {
    const sealed = rows.get(args.where.id);
    return Promise.resolve(sealed === undefined ? null : { botTokenEnc: sealed });
  });
  const service = new InitDataService(
    { tenant: { findUnique } } as unknown as PrismaService,
    secrets,
  );
  return { service, findUnique, rows };
}

/** Asserts the promise rejects with an AppException carrying exactly `code` and `status`. */
async function expectRejection(
  promise: Promise<unknown>,
  code: string,
  status: number = 401,
): Promise<AppException> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).errorCode).toBe(code);
    expect((error as AppException).httpStatus).toBe(status);
    return error as AppException;
  }
  throw new Error(`Expected initData verification to fail with ${code}, but it succeeded`);
}

describe('InitDataService', () => {
  let harness: Harness;
  let service: InitDataService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    harness = makeHarness();
    service = harness.service;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('valid initData', () => {
    it('accepts a correctly signed payload and returns the authenticated user', async () => {
      const result = await service.verify(validInitData(), TENANT_A);

      expect(result.user.id).toBe(279058397n);
      expect(result.user.firstName).toBe('Test');
      expect(result.user.lastName).toBe('User');
      expect(result.user.username).toBe('testuser');
      expect(result.user.languageCode).toBe('en');
      expect(result.user.isPremium).toBe(true);
      expect(result.user.isBot).toBe(false);
      expect(result.queryId).toBe('AAHdF6IQAAAAAN0XohDhrOrc');
      expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns auth_date as a Date matching the signed value', async () => {
      const authDate = nowSeconds() - 30;
      const result = await service.verify(validInitData({ auth_date: String(authDate) }), TENANT_A);
      expect(result.authDate.getTime()).toBe(authDate * 1000);
    });

    it('surfaces start_param so deep links survive login', async () => {
      const result = await service.verify(
        validInitData({ start_param: 'deposit_K7Q2ZP9V3M' }),
        TENANT_A,
      );
      expect(result.startParam).toBe('deposit_K7Q2ZP9V3M');
    });

    it('handles names containing &, = and + — the case a hand-rolled split would corrupt', async () => {
      // If the parser split on '&'/'=' instead of using URLSearchParams, this user's JSON would be
      // truncated and the computed hash would not match.
      const user = JSON.stringify({
        id: 42,
        first_name: 'A&B=C+D',
        last_name: '100% Sure',
        username: 'edge_case',
      });
      const result = await service.verify(validInitData({ user }), TENANT_A);
      expect(result.user.firstName).toBe('A&B=C+D');
      expect(result.user.lastName).toBe('100% Sure');
      expect(result.user.id).toBe(42n);
    });
  });

  describe('the signature field (Telegram third-party validation)', () => {
    it('accepts initData carrying a `signature` field, which is excluded from the check string', async () => {
      // `signature` must be deleted alongside `hash`. If it were left in the data-check-string,
      // every modern client would fail verification while older fixtures kept passing.
      const initData = validInitData(
        {},
        { signature: 'HgZCbEwYqYNJ6t0Xk1nS3vQwErTyUiOpAsDfGhJkLzXcVbNm' },
      );
      const result = await service.verify(initData, TENANT_A);
      expect(result.user.id).toBe(279058397n);
    });

    it('is unaffected by the signature value, because it is not signed', async () => {
      const fields = baseFields();
      const hash = signInitData(fields, BOT_TOKEN);

      const withOne = encodeInitData(fields, { signature: 'aaaa', hash });
      const withOther = encodeInitData(fields, { signature: 'zzzz', hash });

      expect((await service.verify(withOne, TENANT_A)).hash).toBe(
        (await service.verify(withOther, TENANT_A)).hash,
      );
    });
  });

  describe('tampering', () => {
    it('rejects a payload whose user was swapped after signing', async () => {
      const fields = baseFields();
      const hash = signInitData(fields, BOT_TOKEN);

      // The attack this defends against: keep a valid hash, change who you claim to be.
      const tampered = encodeInitData(
        { ...fields, user: JSON.stringify({ id: 1, first_name: 'Attacker' }) },
        { hash },
      );

      await expectRejection(
        service.verify(tampered, TENANT_A),
        CommonErrorCodes.INIT_DATA_HASH_INVALID,
      );
    });

    it('rejects a payload whose auth_date was pushed forward after signing', async () => {
      const fields = baseFields({ auth_date: String(nowSeconds() - 10_000) });
      const hash = signInitData(fields, BOT_TOKEN);

      // Refreshing a stale capture by editing auth_date must break the signature.
      const tampered = encodeInitData({ ...fields, auth_date: String(nowSeconds()) }, { hash });

      await expectRejection(
        service.verify(tampered, TENANT_A),
        CommonErrorCodes.INIT_DATA_HASH_INVALID,
      );
    });

    it('rejects an added field that was not part of the signed set', async () => {
      const fields = baseFields();
      const hash = signInitData(fields, BOT_TOKEN);
      const tampered = encodeInitData({ ...fields, chat_type: 'private' }, { hash });

      await expectRejection(
        service.verify(tampered, TENANT_A),
        CommonErrorCodes.INIT_DATA_HASH_INVALID,
      );
    });

    it('rejects data signed with a different bot token', async () => {
      await expectRejection(
        service.verify(validInitData({}, {}, OTHER_BOT_TOKEN), TENANT_A),
        CommonErrorCodes.INIT_DATA_HASH_INVALID,
      );
    });

    it('rejects a hash built with the HMAC key and message swapped', async () => {
      // The classic implementation bug: HMAC(key=botToken, msg="WebAppData"). It produces a
      // perfectly well-formed digest, so only a negative test catches it.
      const fields = baseFields();
      const wrongSecret = createHmac('sha256', BOT_TOKEN).update('WebAppData').digest();
      const dcs = Object.entries(fields)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
      const wrongHash = createHmac('sha256', wrongSecret).update(dcs).digest('hex');

      await expectRejection(
        service.verify(encodeInitData(fields, { hash: wrongHash }), TENANT_A),
        CommonErrorCodes.INIT_DATA_HASH_INVALID,
      );
    });
  });

  describe('missing or malformed hash', () => {
    it('rejects initData with no hash at all', async () => {
      const initData = encodeInitData(baseFields());
      await expectRejection(
        service.verify(initData, TENANT_A),
        CommonErrorCodes.INIT_DATA_HASH_MISSING,
      );
    });

    it('rejects an empty hash', async () => {
      const initData = encodeInitData(baseFields(), { hash: '' });
      await expectRejection(
        service.verify(initData, TENANT_A),
        CommonErrorCodes.INIT_DATA_HASH_MISSING,
      );
    });

    it('rejects a non-hex hash instead of letting Buffer.from truncate it', async () => {
      // Buffer.from('zz…', 'hex') returns an EMPTY buffer rather than throwing, so without the
      // explicit hex check this input would reach timingSafeEqual with a length mismatch.
      const initData = encodeInitData(baseFields(), { hash: 'z'.repeat(64) });
      await expectRejection(
        service.verify(initData, TENANT_A),
        CommonErrorCodes.INIT_DATA_HASH_INVALID,
      );
    });

    it('rejects a truncated (short) hash', async () => {
      const initData = encodeInitData(baseFields(), { hash: 'abc123' });
      await expectRejection(
        service.verify(initData, TENANT_A),
        CommonErrorCodes.INIT_DATA_HASH_INVALID,
      );
    });

    it('rejects an empty initData string', async () => {
      await expectRejection(service.verify('', TENANT_A), CommonErrorCodes.INIT_DATA_MALFORMED);
    });

    it('rejects all of the above without reading any tenant row', async () => {
      // A stranger posting garbage must not cost a database query.
      await expectRejection(service.verify('', TENANT_A), CommonErrorCodes.INIT_DATA_MALFORMED);
      await expectRejection(
        service.verify(encodeInitData(baseFields()), TENANT_A),
        CommonErrorCodes.INIT_DATA_HASH_MISSING,
      );
      await expectRejection(
        service.verify(encodeInitData(baseFields(), { hash: 'abc123' }), TENANT_A),
        CommonErrorCodes.INIT_DATA_HASH_INVALID,
      );
      expect(harness.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('freshness', () => {
    it('rejects initData older than the 300s window even though the signature is valid', async () => {
      const stale = validInitData({ auth_date: String(nowSeconds() - 301) });
      await expectRejection(service.verify(stale, TENANT_A), CommonErrorCodes.INIT_DATA_EXPIRED);
    });

    it('accepts initData just inside the window', async () => {
      const fresh = validInitData({ auth_date: String(nowSeconds() - 290) });
      expect((await service.verify(fresh, TENANT_A)).user.id).toBe(279058397n);
    });

    it('honours a caller-supplied shorter max age', async () => {
      const initData = validInitData({ auth_date: String(nowSeconds() - 120) });
      expect((await service.verify(initData, TENANT_A, 300)).user.id).toBe(279058397n);
      await expectRejection(
        service.verify(initData, TENANT_A, 60),
        CommonErrorCodes.INIT_DATA_EXPIRED,
      );
    });

    it('tolerates small clock skew but rejects a far-future auth_date', async () => {
      const slightlyAhead = validInitData({ auth_date: String(nowSeconds() + 30) });
      expect((await service.verify(slightlyAhead, TENANT_A)).user.id).toBe(279058397n);

      const farFuture = validInitData({ auth_date: String(nowSeconds() + 3_600) });
      await expectRejection(
        service.verify(farFuture, TENANT_A),
        CommonErrorCodes.INIT_DATA_EXPIRED,
      );
    });

    it('rejects initData with no auth_date', async () => {
      const fields: Record<string, string> = {
        query_id: 'x',
        user: JSON.stringify({ id: 1, first_name: 'A' }),
      };
      const hash = signInitData(fields, BOT_TOKEN);
      await expectRejection(
        service.verify(encodeInitData(fields, { hash }), TENANT_A),
        CommonErrorCodes.INIT_DATA_AUTH_DATE_MISSING,
      );
    });
  });

  describe('user payload', () => {
    it('rejects signed initData that carries no user', async () => {
      const fields: Record<string, string> = { auth_date: String(nowSeconds()) };
      const hash = signInitData(fields, BOT_TOKEN);
      await expectRejection(
        service.verify(encodeInitData(fields, { hash }), TENANT_A),
        CommonErrorCodes.INIT_DATA_USER_MISSING,
      );
    });

    it('rejects a user field that is not valid JSON', async () => {
      const initData = validInitData({ user: '{not json' });
      await expectRejection(
        service.verify(initData, TENANT_A),
        CommonErrorCodes.INIT_DATA_MALFORMED,
      );
    });

    it('rejects a user id that is not a safe integer rather than rounding it', async () => {
      // Rounding here would authenticate a DIFFERENT account than the one that signed in.
      const initData = validInitData({ user: '{"id":12345678901234567890,"first_name":"A"}' });
      await expectRejection(
        service.verify(initData, TENANT_A),
        CommonErrorCodes.INIT_DATA_MALFORMED,
      );
    });

    it('returns the id as a bigint, never a number', async () => {
      const result = await service.verify(validInitData(), TENANT_A);
      expect(typeof result.user.id).toBe('bigint');
    });
  });

  describe('whose bot token', () => {
    it('reads nothing at construction, so a process with no usable token still boots', () => {
      // The api AND the worker construct this service. The old one derived its key from a global
      // env token in the constructor, which is exactly what took a whole process down.
      const fresh = makeHarness();
      expect(fresh.findUnique).not.toHaveBeenCalled();
    });

    it('checks the signature against the named operator’s own bot token', async () => {
      const signedByB = validInitData({}, {}, OTHER_BOT_TOKEN);

      // Operator B's player is refused as operator A's, and accepted as B's.
      await expectRejection(
        service.verify(signedByB, TENANT_A),
        CommonErrorCodes.INIT_DATA_HASH_INVALID,
      );
      expect((await service.verify(signedByB, TENANT_B)).user.id).toBe(279058397n);
    });

    it('opens the sealed token once and reuses the derived key', async () => {
      await service.verify(validInitData(), TENANT_A);
      await service.verify(validInitData(), TENANT_A);
      await Promise.all([
        service.verify(validInitData(), TENANT_A),
        service.verify(validInitData(), TENANT_A),
      ]);

      expect(harness.findUnique).toHaveBeenCalledTimes(1);
    });

    it('drops the old key once a changed token is noticed, and verifies with the new one', async () => {
      const start = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
      const signedWithOld = (): string => validInitData();
      const signedWithNew = (): string => validInitData({}, {}, ROTATED_BOT_TOKEN);

      await service.verify(signedWithOld(), TENANT_A);

      // The token is changed from the dashboard, i.e. in ANOTHER process: only the row changes.
      harness.rows.set(TENANT_A, secrets.sealBotToken(ROTATED_BOT_TOKEN));

      // Inside the recheck window the cached key still answers; that bound is the documented cost.
      expect((await service.verify(signedWithOld(), TENANT_A)).user.id).toBe(279058397n);

      clock.mockReturnValue(start + (INIT_DATA_KEY_RECHECK_SECONDS + 1) * 1_000);
      await expectRejection(
        service.verify(signedWithOld(), TENANT_A),
        CommonErrorCodes.INIT_DATA_HASH_INVALID,
      );
      expect((await service.verify(signedWithNew(), TENANT_A)).user.id).toBe(279058397n);
    });

    it('invalidate() drops the key at once for a change made in this process', async () => {
      await service.verify(validInitData(), TENANT_A);
      harness.rows.set(TENANT_A, secrets.sealBotToken(ROTATED_BOT_TOKEN));

      service.invalidate(TENANT_A);

      await expectRejection(
        service.verify(validInitData(), TENANT_A),
        CommonErrorCodes.INIT_DATA_HASH_INVALID,
      );
      expect(
        (await service.verify(validInitData({}, {}, ROTATED_BOT_TOKEN), TENANT_A)).user.id,
      ).toBe(279058397n);
    });

    it('does not let a load that was in flight during invalidate() put the old key back', async () => {
      // The row is read, the token is changed and invalidate() runs, and only THEN does the read
      // return — with the old sealed value. Caching that would let the old token verify for the
      // whole recheck window after a change this process was told about.
      const oldSealed = harness.rows.get(TENANT_A) ?? '';
      let release: () => void = () => undefined;
      harness.findUnique.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => {
              resolve({ botTokenEnc: oldSealed });
            };
          }),
      );

      const inFlight = service.verify(validInitData(), TENANT_A);
      harness.rows.set(TENANT_A, secrets.sealBotToken(ROTATED_BOT_TOKEN));
      service.invalidate(TENANT_A);
      release();

      // The request that began before the change may finish with what it read...
      expect((await inFlight).user.id).toBe(279058397n);
      // ...but the very next one reads the row again and knows only the new token.
      await expectRejection(
        service.verify(validInitData(), TENANT_A),
        CommonErrorCodes.INIT_DATA_HASH_INVALID,
      );
      expect(
        (await service.verify(validInitData({}, {}, ROTATED_BOT_TOKEN), TENANT_A)).user.id,
      ).toBe(279058397n);
      expect(harness.findUnique).toHaveBeenCalledTimes(2);
    });

    it('answers 503, not 401, when the operator has no usable bot token, and leaks nothing', async () => {
      const error = await expectRejection(
        service.verify(validInitData(), TENANT_UNSET),
        CommonErrorCodes.INIT_DATA_BOT_UNAVAILABLE,
        503,
      );
      // A 401 would tell the app a perfectly valid initData was forged.
      expect(JSON.stringify(error)).not.toContain('REPLACE-ME');
      expect(error.message).not.toContain(BOT_TOKEN);
    });

    it('answers 503 for an operator that does not exist, and for an id that is not a uuid', async () => {
      await expectRejection(
        service.verify(validInitData(), TENANT_MISSING),
        CommonErrorCodes.INIT_DATA_BOT_UNAVAILABLE,
        503,
      );
      await expectRejection(
        service.verify(validInitData(), 'not-a-uuid'),
        CommonErrorCodes.INIT_DATA_BOT_UNAVAILABLE,
        503,
      );
    });

    it('recovers as soon as the missing token is set', async () => {
      await expectRejection(
        service.verify(validInitData(), TENANT_UNSET),
        CommonErrorCodes.INIT_DATA_BOT_UNAVAILABLE,
        503,
      );
      harness.rows.set(TENANT_UNSET, secrets.sealBotToken(BOT_TOKEN));

      // A failure is not cached: nothing was derived, so the next request reads the row again.
      expect((await service.verify(validInitData(), TENANT_UNSET)).user.id).toBe(279058397n);
    });
  });
});
