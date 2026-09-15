import { GrammyError, HttpError } from 'grammy';
import type { WebhookInfo } from 'grammy/types';

import { AppException } from '@common/exceptions/app.exception';
import {
  TenantBotErrorCodes,
  TenantBotUnavailableError,
} from '@core/telegram/tenant-bot.errors';

import { telegramFailure } from '../utils/telegram-failure';

import {
  botHealthFromWebhookInfo,
  botHealthUnavailable,
  ichancyHealthNotChecked,
  toWebhookView,
} from './tenant-operations.view';

const TOKEN = 'p10ViewSpecPathToken0123456789abcdefghijklmn';
const EXPECTED = `https://api.example.app/telegram/webhook/${TOKEN}`;

const info = (overrides: Partial<WebhookInfo> = {}): WebhookInfo => ({
  url: EXPECTED,
  has_custom_certificate: false,
  pending_update_count: 0,
  ...overrides,
});

const grammyError = (code: number, description: string): GrammyError =>
  new GrammyError(
    `Call to 'setWebhook' failed! (${code}: ${description})`,
    { ok: false, error_code: code, description },
    'setWebhook',
    {},
  );

describe('toWebhookView', () => {
  it('answers the registered webhook with its path token masked, and its error date as ISO', () => {
    const view = toWebhookView(
      info({
        pending_update_count: 4,
        last_error_message: `Wrong response from the webhook ${EXPECTED}: 403 Forbidden`,
        last_error_date: 1_757_900_000,
      }),
    );
    expect(view).toEqual({
      url: 'https://api.example.app/telegram/webhook/[REDACTED]',
      registered: true,
      pendingUpdateCount: 4,
      // The shared log redaction masks the whole path segment, up to the next space, so the colon
      // that followed the token goes with it. The point is that the token does.
      lastErrorMessage: expect.stringMatching(
        /^Wrong response from the webhook https:\/\/api\.example\.app\/telegram\/webhook\/\[REDACTED\]:? 403 Forbidden$/,
      ),
      lastErrorDate: new Date(1_757_900_000_000).toISOString(),
    });
    expect(JSON.stringify(view)).not.toContain(TOKEN);
  });

  it('reads Telegram’s empty url as null and not registered', () => {
    expect(toWebhookView(info({ url: '' }))).toEqual({
      url: null,
      registered: false,
      pendingUpdateCount: 0,
      lastErrorMessage: null,
      lastErrorDate: null,
    });
  });
});

describe('bot health', () => {
  it('is ok only with a username, a webhook matching this deployment and no delivery error', () => {
    expect(botHealthFromWebhookInfo('north_bot', info(), EXPECTED)).toMatchObject({
      ok: true,
      webhookMatches: true,
      webhookUrl: 'https://api.example.app/telegram/webhook/[REDACTED]',
    });

    expect(botHealthFromWebhookInfo(null, info(), EXPECTED).ok).toBe(false);
    expect(botHealthFromWebhookInfo('north_bot', info(), null)).toMatchObject({
      ok: false,
      webhookMatches: false,
    });

    const failing = botHealthFromWebhookInfo(
      'north_bot',
      info({ last_error_message: 'Connection timed out', last_error_date: 1_757_900_000 }),
      EXPECTED,
    );
    expect(failing).toMatchObject({ ok: false, webhookMatches: true, lastErrorMessage: 'Connection timed out' });
  });

  it('does not match a webhook pointing at another deployment, or at another token on this one', () => {
    const elsewhere = botHealthFromWebhookInfo(
      'north_bot',
      info({ url: `https://old-staging.example/telegram/webhook/${TOKEN}` }),
      EXPECTED,
    );
    expect(elsewhere).toMatchObject({ ok: false, webhookMatches: false });

    // Masked, the two URLs would print the same. Compared unmasked, they are not the same webhook,
    // and the reported URL says so without revealing either token.
    const otherToken = botHealthFromWebhookInfo(
      'north_bot',
      info({ url: 'https://api.example.app/telegram/webhook/someOtherOperatorsToken0000' }),
      EXPECTED,
    );
    expect(otherToken.webhookMatches).toBe(false);
    expect(otherToken.webhookUrl).toBe(
      'https://api.example.app/telegram/webhook/[REDACTED:NOT-THIS-OPERATOR]',
    );
    expect(JSON.stringify(otherToken)).not.toContain('someOtherOperatorsToken0000');

    // Another deployment keeps the plain mask: the host already shows it is elsewhere.
    expect(elsewhere.webhookUrl).toBe('https://old-staging.example/telegram/webhook/[REDACTED]');
  });

  it('reports a bot that cannot be asked as not ok, with the reason and no delivery claims', () => {
    expect(botHealthUnavailable('north_bot', 'The bot token has not been set')).toEqual({
      ok: false,
      username: 'north_bot',
      webhookUrl: null,
      webhookMatches: false,
      pendingUpdateCount: 0,
      lastErrorMessage: 'The bot token has not been set',
      lastErrorDate: null,
    });
  });

  it('reports the Ichancy half as not checked, never as healthy', () => {
    const checkedAt = new Date('2026-09-15T10:00:00.000Z');
    expect(
      ichancyHealthNotChecked({
        baseUrl: 'https://agents.ichancy.com',
        username: 'agent_north',
        agentId: '10045',
        sharesAgentWith: ['south-branch'],
        reason: 'Not checked',
        checkedAt,
      }),
    ).toEqual({
      ok: false,
      baseUrl: 'https://agents.ichancy.com',
      username: 'agent_north',
      agentId: '10045',
      checkedAt: checkedAt.toISOString(),
      error: 'Not checked',
      floatMinor: null,
      belowWatermark: false,
      sharesAgentWith: ['south-branch'],
    });
  });
});

describe('telegramFailure', () => {
  const mapped = (error: unknown): { status: number; code: string; message: string } => {
    const failure = telegramFailure(error, 'register the webhook');
    if (!(failure instanceof AppException)) throw new Error('expected a contract error');
    return { status: failure.httpStatus, code: failure.errorCode, message: failure.message };
  };

  it('turns a refused URL into 422 TENANT_TELEGRAM_REJECTED with Telegram’s words, token masked', () => {
    expect(
      mapped(grammyError(400, `Bad Request: bad webhook: Failed to resolve host for ${EXPECTED}`)),
    ).toEqual({
      status: 422,
      code: 'TENANT_TELEGRAM_REJECTED',
      message:
        'Telegram refused to register the webhook: Bad Request: bad webhook: Failed to resolve ' +
        'host for https://api.example.app/telegram/webhook/[REDACTED]',
    });
  });

  it('turns a revoked token into TENANT_BOT_UNAVAILABLE and an outage into a 503', () => {
    expect(mapped(grammyError(401, 'Unauthorized'))).toMatchObject({
      status: 422,
      code: 'TENANT_BOT_UNAVAILABLE',
    });
    expect(mapped(grammyError(502, 'Bad Gateway'))).toMatchObject({
      status: 503,
      code: 'TENANT_TELEGRAM_UNREACHABLE',
    });
    expect(mapped(new HttpError("Network request for 'setWebhook' failed!", new Error('x')))).toMatchObject({
      status: 503,
      code: 'TENANT_TELEGRAM_UNREACHABLE',
    });
  });

  it('keeps a registry failure’s own reason, and its retryability', () => {
    const unset = new TenantBotUnavailableError(
      TenantBotErrorCodes.TENANT_BOT_UNCONFIGURED,
      'tenant-1',
      false,
      'The bot token of tenant tenant-1 has not been set; set it from the dashboard',
    );
    expect(mapped(unset)).toEqual({
      status: 422,
      code: 'TENANT_BOT_UNAVAILABLE',
      message:
        "This operator's bot cannot be used to register the webhook: The bot token of tenant " +
        'tenant-1 has not been set; set it from the dashboard',
    });

    const timeout = new TenantBotUnavailableError(
      TenantBotErrorCodes.TENANT_BOT_UNREACHABLE,
      'tenant-1',
      true,
      'getMe for tenant tenant-1 failed: timeout',
    );
    expect(mapped(timeout).status).toBe(503);
  });

  it('answers null for anything that is not Telegram’s, so it is rethrown unchanged', () => {
    expect(telegramFailure(new Error('connection refused'), 'register the webhook')).toBeNull();
  });
});
