/**
 * WHY the fixture is generated rather than hard-coded: a captured real initData is bound to a real
 * bot token (which we will not commit) and to a real `auth_date` (which goes stale, so the suite
 * would start failing five minutes after it was written). Generating one per test with the same
 * published algorithm keeps the tests honest AND stable.
 *
 * The signer below is written independently of the service — straight from the spec text — so a
 * bug copied into both would have to be made twice, in two different shapes.
 */
import { createHmac } from 'node:crypto';
import { AppException } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';
import { type AppConfigService } from '../../config/config.service';
import { InitDataService } from './init-data.service';

const BOT_TOKEN = '123456789:AAF-fakeTokenForTestsOnly_0123456789abc';
const OTHER_BOT_TOKEN = '987654321:BBQ-anotherFakeToken_0123456789abcdef';

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

function makeService(botToken: string = BOT_TOKEN): InitDataService {
  const config = { telegram: { botToken } } as unknown as AppConfigService;
  return new InitDataService(config);
}

/** Asserts the call throws an AppException carrying exactly `code`. */
function expectRejection(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).errorCode).toBe(code);
    expect((error as AppException).httpStatus).toBe(401);
    return;
  }
  throw new Error(`Expected initData verification to fail with ${code}, but it succeeded`);
}

describe('InitDataService', () => {
  let service: InitDataService;

  beforeEach(() => {
    service = makeService();
  });

  describe('valid initData', () => {
    it('accepts a correctly signed payload and returns the authenticated user', () => {
      const result = service.verify(validInitData());

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

    it('returns auth_date as a Date matching the signed value', () => {
      const authDate = nowSeconds() - 30;
      const result = service.verify(validInitData({ auth_date: String(authDate) }));
      expect(result.authDate.getTime()).toBe(authDate * 1000);
    });

    it('surfaces start_param so deep links survive login', () => {
      const result = service.verify(validInitData({ start_param: 'deposit_K7Q2ZP9V3M' }));
      expect(result.startParam).toBe('deposit_K7Q2ZP9V3M');
    });

    it('handles names containing &, = and + — the case a hand-rolled split would corrupt', () => {
      // If the parser split on '&'/'=' instead of using URLSearchParams, this user's JSON would be
      // truncated and the computed hash would not match.
      const user = JSON.stringify({
        id: 42,
        first_name: 'A&B=C+D',
        last_name: '100% Sure',
        username: 'edge_case',
      });
      const result = service.verify(validInitData({ user }));
      expect(result.user.firstName).toBe('A&B=C+D');
      expect(result.user.lastName).toBe('100% Sure');
      expect(result.user.id).toBe(42n);
    });
  });

  describe('the signature field (Telegram third-party validation)', () => {
    it('accepts initData carrying a `signature` field, which is excluded from the check string', () => {
      // `signature` must be deleted alongside `hash`. If it were left in the data-check-string,
      // every modern client would fail verification while older fixtures kept passing.
      const initData = validInitData(
        {},
        { signature: 'HgZCbEwYqYNJ6t0Xk1nS3vQwErTyUiOpAsDfGhJkLzXcVbNm' },
      );
      const result = service.verify(initData);
      expect(result.user.id).toBe(279058397n);
    });

    it('is unaffected by the signature value, because it is not signed', () => {
      const fields = baseFields();
      const hash = signInitData(fields, BOT_TOKEN);

      const withOne = encodeInitData(fields, { signature: 'aaaa', hash });
      const withOther = encodeInitData(fields, { signature: 'zzzz', hash });

      expect(service.verify(withOne).hash).toBe(service.verify(withOther).hash);
    });
  });

  describe('tampering', () => {
    it('rejects a payload whose user was swapped after signing', () => {
      const fields = baseFields();
      const hash = signInitData(fields, BOT_TOKEN);

      // The attack this defends against: keep a valid hash, change who you claim to be.
      const tampered = encodeInitData(
        { ...fields, user: JSON.stringify({ id: 1, first_name: 'Attacker' }) },
        { hash },
      );

      expectRejection(() => service.verify(tampered), CommonErrorCodes.INIT_DATA_HASH_INVALID);
    });

    it('rejects a payload whose auth_date was pushed forward after signing', () => {
      const fields = baseFields({ auth_date: String(nowSeconds() - 10_000) });
      const hash = signInitData(fields, BOT_TOKEN);

      // Refreshing a stale capture by editing auth_date must break the signature.
      const tampered = encodeInitData({ ...fields, auth_date: String(nowSeconds()) }, { hash });

      expectRejection(() => service.verify(tampered), CommonErrorCodes.INIT_DATA_HASH_INVALID);
    });

    it('rejects an added field that was not part of the signed set', () => {
      const fields = baseFields();
      const hash = signInitData(fields, BOT_TOKEN);
      const tampered = encodeInitData({ ...fields, chat_type: 'private' }, { hash });

      expectRejection(() => service.verify(tampered), CommonErrorCodes.INIT_DATA_HASH_INVALID);
    });

    it('rejects data signed with a different bot token', () => {
      expectRejection(
        () => service.verify(validInitData({}, {}, OTHER_BOT_TOKEN)),
        CommonErrorCodes.INIT_DATA_HASH_INVALID,
      );
    });

    it('rejects a hash built with the HMAC key and message swapped', () => {
      // The classic implementation bug: HMAC(key=botToken, msg="WebAppData"). It produces a
      // perfectly well-formed digest, so only a negative test catches it.
      const fields = baseFields();
      const wrongSecret = createHmac('sha256', BOT_TOKEN).update('WebAppData').digest();
      const dcs = Object.entries(fields)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
      const wrongHash = createHmac('sha256', wrongSecret).update(dcs).digest('hex');

      expectRejection(
        () => service.verify(encodeInitData(fields, { hash: wrongHash })),
        CommonErrorCodes.INIT_DATA_HASH_INVALID,
      );
    });
  });

  describe('missing or malformed hash', () => {
    it('rejects initData with no hash at all', () => {
      const initData = encodeInitData(baseFields());
      expectRejection(() => service.verify(initData), CommonErrorCodes.INIT_DATA_HASH_MISSING);
    });

    it('rejects an empty hash', () => {
      const initData = encodeInitData(baseFields(), { hash: '' });
      expectRejection(() => service.verify(initData), CommonErrorCodes.INIT_DATA_HASH_MISSING);
    });

    it('rejects a non-hex hash instead of letting Buffer.from truncate it', () => {
      // Buffer.from('zz…', 'hex') returns an EMPTY buffer rather than throwing, so without the
      // explicit hex check this input would reach timingSafeEqual with a length mismatch.
      const initData = encodeInitData(baseFields(), { hash: 'z'.repeat(64) });
      expectRejection(() => service.verify(initData), CommonErrorCodes.INIT_DATA_HASH_INVALID);
    });

    it('rejects a truncated (short) hash', () => {
      const initData = encodeInitData(baseFields(), { hash: 'abc123' });
      expectRejection(() => service.verify(initData), CommonErrorCodes.INIT_DATA_HASH_INVALID);
    });

    it('rejects an empty initData string', () => {
      expectRejection(() => service.verify(''), CommonErrorCodes.INIT_DATA_MALFORMED);
    });
  });

  describe('freshness', () => {
    it('rejects initData older than the 300s window even though the signature is valid', () => {
      const stale = validInitData({ auth_date: String(nowSeconds() - 301) });
      expectRejection(() => service.verify(stale), CommonErrorCodes.INIT_DATA_EXPIRED);
    });

    it('accepts initData just inside the window', () => {
      const fresh = validInitData({ auth_date: String(nowSeconds() - 290) });
      expect(service.verify(fresh).user.id).toBe(279058397n);
    });

    it('honours a caller-supplied shorter max age', () => {
      const initData = validInitData({ auth_date: String(nowSeconds() - 120) });
      expect(service.verify(initData, 300).user.id).toBe(279058397n);
      expectRejection(() => service.verify(initData, 60), CommonErrorCodes.INIT_DATA_EXPIRED);
    });

    it('tolerates small clock skew but rejects a far-future auth_date', () => {
      const slightlyAhead = validInitData({ auth_date: String(nowSeconds() + 30) });
      expect(service.verify(slightlyAhead).user.id).toBe(279058397n);

      const farFuture = validInitData({ auth_date: String(nowSeconds() + 3_600) });
      expectRejection(() => service.verify(farFuture), CommonErrorCodes.INIT_DATA_EXPIRED);
    });

    it('rejects initData with no auth_date', () => {
      const fields: Record<string, string> = {
        query_id: 'x',
        user: JSON.stringify({ id: 1, first_name: 'A' }),
      };
      const hash = signInitData(fields, BOT_TOKEN);
      expectRejection(
        () => service.verify(encodeInitData(fields, { hash })),
        CommonErrorCodes.INIT_DATA_AUTH_DATE_MISSING,
      );
    });
  });

  describe('user payload', () => {
    it('rejects signed initData that carries no user', () => {
      const fields: Record<string, string> = { auth_date: String(nowSeconds()) };
      const hash = signInitData(fields, BOT_TOKEN);
      expectRejection(
        () => service.verify(encodeInitData(fields, { hash })),
        CommonErrorCodes.INIT_DATA_USER_MISSING,
      );
    });

    it('rejects a user field that is not valid JSON', () => {
      const initData = validInitData({ user: '{not json' });
      expectRejection(() => service.verify(initData), CommonErrorCodes.INIT_DATA_MALFORMED);
    });

    it('rejects a user id that is not a safe integer rather than rounding it', () => {
      // Rounding here would authenticate a DIFFERENT account than the one that signed in.
      const initData = validInitData({ user: '{"id":12345678901234567890,"first_name":"A"}' });
      expectRejection(() => service.verify(initData), CommonErrorCodes.INIT_DATA_MALFORMED);
    });

    it('returns the id as a bigint, never a number', () => {
      const result = service.verify(validInitData());
      expect(typeof result.user.id).toBe('bigint');
    });
  });
});
