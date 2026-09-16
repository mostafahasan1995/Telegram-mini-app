import {
  REDACTED_PATH_SEGMENT,
  redactRequestUrl,
  redactWebhookPathToken,
} from './request-url-redaction.util';

const TOKEN = 'wh_9f8e7d6c5b4a39281706f5e4d3c2b1a0';

describe('redactRequestUrl', () => {
  it('masks the webhook path token', () => {
    const logged = redactRequestUrl(`/telegram/webhook/${TOKEN}`);

    expect(logged).toBe(`/telegram/webhook/${REDACTED_PATH_SEGMENT}`);
    expect(logged).not.toContain(TOKEN);
  });

  it('masks the token and drops the query string', () => {
    const logged = redactRequestUrl(`/telegram/webhook/${TOKEN}?x=1`);

    expect(logged).toBe(`/telegram/webhook/${REDACTED_PATH_SEGMENT}`);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain('x=1');
  });

  it('drops a fragment as well as a query string', () => {
    expect(redactRequestUrl(`/telegram/webhook/${TOKEN}#frag`)).toBe(
      `/telegram/webhook/${REDACTED_PATH_SEGMENT}`,
    );
  });

  it.each(['/v1/deposits', '/health/ready', '/', '/telegram/webhook', '/telegram/webhooks/abc'])(
    'leaves %s untouched',
    (url) => {
      expect(redactRequestUrl(url)).toBe(url);
    },
  );

  it('strips only the query string from other URLs', () => {
    expect(redactRequestUrl('/v1/deposits?page=2&status=PENDING')).toBe('/v1/deposits');
  });

  it('returns an empty string for a missing URL', () => {
    expect(redactRequestUrl(undefined)).toBe('');
  });
});

describe('redactWebhookPathToken', () => {
  it('masks the token inside an absolute URL embedded in a message', () => {
    const message = `Webhook set to https://api.example.test/telegram/webhook/${TOKEN} (ok)`;
    const logged = redactWebhookPathToken(message);

    expect(logged).toBe(
      `Webhook set to https://api.example.test/telegram/webhook/${REDACTED_PATH_SEGMENT} (ok)`,
    );
  });

  it('masks every occurrence, not only the first', () => {
    const logged = redactWebhookPathToken(`/telegram/webhook/${TOKEN} and /telegram/webhook/other`);

    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain('other');
  });

  it('leaves text without a webhook path untouched', () => {
    const message = 'POST /v1/withdrawals?x=1 failed';
    expect(redactWebhookPathToken(message)).toBe(message);
  });
});
