import { REDACTED, REDACT_PATHS, redactSecrets, scrubSecretsFromString } from './redaction';

const BOT_TOKEN = '123456789:AAF-fakeTokenForTestsOnly_0123456789abc';

describe('scrubSecretsFromString', () => {
  it('removes a bot token embedded in a Telegram API URL', () => {
    // This is how the token actually escapes: grammY puts it in the request URL, so it shows up in
    // error messages and HTTP traces, not in a field called "botToken".
    const message = `Error calling https://api.telegram.org/bot${BOT_TOKEN}/sendMessage: 400`;
    const scrubbed = scrubSecretsFromString(message);

    expect(scrubbed).not.toContain(BOT_TOKEN);
    expect(scrubbed).toContain('<BOT_TOKEN>');
    expect(scrubbed).toContain('sendMessage');
  });

  it('removes a bare JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMxMjMifQ.c2lnbmF0dXJlLWhlcmU';
    const scrubbed = scrubSecretsFromString(`token=${jwt} failed`);

    expect(scrubbed).not.toContain(jwt);
    expect(scrubbed).toContain('<JWT>');
  });

  it('removes the credential from an Authorization header value but keeps the scheme', () => {
    const scrubbed = scrubSecretsFromString('Bearer abcdef0123456789abcdef');
    expect(scrubbed).toBe(`Bearer ${REDACTED}`);
  });

  it('leaves ordinary text untouched', () => {
    const text = 'Deposit K7Q2ZP9V3M credited 1500.00 NSP';
    expect(scrubSecretsFromString(text)).toBe(text);
  });
});

describe('redactSecrets', () => {
  it('redacts sensitive keys wherever they appear', () => {
    const result = redactSecrets({
      username: 'agent1',
      password: 'hunter2',
      accessToken: 'abc',
      refreshToken: 'def',
      initData: 'query_id=x&hash=y',
      nested: { apiKey: 'k', totpSecret: 's' },
    }) as Record<string, unknown>;

    expect(result.username).toBe('agent1');
    expect(result.password).toBe(REDACTED);
    expect(result.accessToken).toBe(REDACTED);
    expect(result.refreshToken).toBe(REDACTED);
    expect(result.initData).toBe(REDACTED);

    const nested = result.nested as Record<string, unknown>;
    expect(nested.apiKey).toBe(REDACTED);
    expect(nested.totpSecret).toBe(REDACTED);
  });

  it('matches key names case-insensitively and in snake_case', () => {
    const result = redactSecrets({
      init_data: 'x',
      PASSWORD: 'y',
      Authorization: 'z',
    }) as Record<string, unknown>;

    expect(result.init_data).toBe(REDACTED);
    expect(result.PASSWORD).toBe(REDACTED);
    expect(result.Authorization).toBe(REDACTED);
  });

  it('scrubs secrets that are values rather than keys', () => {
    // An Ichancy error message that happens to quote a token still gets cleaned.
    const result = redactSecrets({
      note: `called https://api.telegram.org/bot${BOT_TOKEN}/getMe`,
    }) as Record<string, unknown>;

    expect(String(result.note)).not.toContain(BOT_TOKEN);
  });

  it('does not mutate the input', () => {
    const input = { password: 'hunter2', keep: 'me' };
    redactSecrets(input);
    expect(input.password).toBe('hunter2');
  });

  it('converts bigint money values to strings instead of throwing', () => {
    // JSON.stringify on a bigint throws; a logger must never be the thing that breaks a request.
    const result = redactSecrets({ amountMinor: 150000n }) as Record<string, unknown>;
    expect(result.amountMinor).toBe('150000');
  });

  it('renders Dates as ISO strings', () => {
    const result = redactSecrets({ at: new Date('2026-01-02T03:04:05.000Z') }) as Record<
      string,
      unknown
    >;
    expect(result.at).toBe('2026-01-02T03:04:05.000Z');
  });

  it('flattens Errors and scrubs their message', () => {
    const result = redactSecrets(
      new Error(`request to https://api.telegram.org/bot${BOT_TOKEN}/getMe failed`),
    ) as Record<string, unknown>;

    expect(result.name).toBe('Error');
    expect(String(result.message)).not.toContain(BOT_TOKEN);
  });

  it('walks arrays', () => {
    const result = redactSecrets([{ password: 'a' }, { safe: 'b' }]) as Record<string, unknown>[];
    expect(result[0]?.password).toBe(REDACTED);
    expect(result[1]?.safe).toBe('b');
  });

  it('survives circular references', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;

    expect(() => redactSecrets(node)).not.toThrow();
    const result = redactSecrets(node) as Record<string, unknown>;
    expect(result.self).toBe('[CIRCULAR]');
  });

  it('bounds recursion depth', () => {
    // A deeply nested Telegram update must not blow the stack inside a logger.
    let deep: Record<string, unknown> = { bottom: true };
    for (let i = 0; i < 40; i += 1) deep = { next: deep };

    expect(() => redactSecrets(deep)).not.toThrow();
    expect(JSON.stringify(redactSecrets(deep))).toContain('[TRUNCATED]');
  });

  it('passes null and undefined through unchanged', () => {
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeUndefined();
  });
});

describe('REDACT_PATHS', () => {
  it('covers the headers that actually carry credentials', () => {
    expect(REDACT_PATHS).toContain('req.headers.authorization');
    expect(REDACT_PATHS).toContain('req.headers["x-telegram-bot-api-secret-token"]');
    expect(REDACT_PATHS).toContain('req.headers.cookie');
  });

  it('covers initData wherever pino finds it', () => {
    expect(REDACT_PATHS).toContain('req.body.initData');
    expect(REDACT_PATHS).toContain('*.initData');
  });
});
