/**
 * The optional Telegram behaviour variables, end to end: raw string -> zod -> AppConfigService.
 *
 * WHY these get a spec when the required variables do not: a required variable that breaks refuses
 * to boot, loudly, on the first deploy. An OPTIONAL one that breaks boots perfectly and silently does
 * nothing — which is exactly how ICHANCY_FAKE came to be inert while appearing to be set (see the
 * note on it in env.schema.ts).
 *
 * Note what this does NOT cover: @nestjs/config dropping transformed values from process.env. That
 * hazard lives in config.module.ts, which captures the validated object instead of re-reading
 * process.env — the reason nothing outside these two files may read a transformed var directly.
 */
import { applyTestEnv } from '../../../test/setup/test-env';
import { AppConfigService } from './config.service';
import { LEGACY_TELEGRAM_ENV_KEYS, legacyTelegramEnvKeys, validateEnv } from './env.schema';

/** A complete, valid environment plus whatever the case under test wants to say about Telegram. */
function telegramConfigFor(feed: Record<string, string>): AppConfigService['telegram'] {
  applyTestEnv({
    DATABASE_URL: 'postgresql://app:app@localhost:5432/ichancy?schema=public',
    REDIS_URL: 'redis://localhost:6379',
  });
  return new AppConfigService(validateEnv({ ...process.env, ...feed })).telegram;
}

/** Every value the single-bot deployment's env file held, shaped as that schema demanded. */
const LEGACY_TELEGRAM_ENV: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: '123456789:AAF-oldGlobalTokenFromAnOldEnvFile_000',
  TELEGRAM_WEBHOOK_SECRET: 'old_webhook_secret_0123456789abcdef',
  TELEGRAM_WEBHOOK_PATH_TOKEN: 'old_webhook_path_token_0123',
  TELEGRAM_ADMIN_CHAT_ID: '-1001234567890',
  TELEGRAM_FEED_CHAT_ID: '-1009876543210',
};

describe('no Telegram identity in the environment', () => {
  it('boots with none of the retired TELEGRAM_* variables set', () => {
    applyTestEnv({
      DATABASE_URL: 'postgresql://app:app@localhost:5432/ichancy?schema=public',
      REDIS_URL: 'redis://localhost:6379',
    });
    const env = { ...process.env };
    for (const key of LEGACY_TELEGRAM_ENV_KEYS) delete env[key];

    expect(() => validateEnv(env)).not.toThrow();
  });

  it('still boots an old env file that carries them, and reads none of them', () => {
    const telegram = telegramConfigFor(LEGACY_TELEGRAM_ENV);

    // The whole Telegram section is behaviour, never identity: no token, path, secret or chat.
    expect(Object.keys(telegram).sort()).toEqual(['feedFullDetail', 'reportScheduleHours']);
    expect(JSON.stringify(telegram)).not.toContain('oldGlobalToken');
  });

  it('keeps booting even when an old value no longer has the shape the old schema demanded', () => {
    // A leftover line is dead: validating it would turn a harmless leftover into an outage.
    expect(() =>
      telegramConfigFor({ TELEGRAM_BOT_TOKEN: 'garbage', TELEGRAM_ADMIN_CHAT_ID: 'not-an-id' }),
    ).not.toThrow();
  });

  it('names the retired keys that are present — names only — for the boot warning', () => {
    expect(legacyTelegramEnvKeys({ ...LEGACY_TELEGRAM_ENV, JWT_SECRET: 'x' })).toEqual([
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_WEBHOOK_SECRET',
      'TELEGRAM_WEBHOOK_PATH_TOKEN',
      'TELEGRAM_ADMIN_CHAT_ID',
      'TELEGRAM_FEED_CHAT_ID',
    ]);
    expect(legacyTelegramEnvKeys({ TELEGRAM_FEED_FULL_DETAIL: 'true' })).toEqual([]);
  });
});

describe('TELEGRAM_FEED_FULL_DETAIL', () => {
  it('is masked when nothing is configured', () => {
    expect(telegramConfigFor({}).feedFullDetail).toBe(false);
  });

  /** Emptying the line is how an operator turns the feature off; it must not refuse to boot. */
  it('treats a blank value the same as an absent one', () => {
    expect(telegramConfigFor({ TELEGRAM_FEED_FULL_DETAIL: '' }).feedFullDetail).toBe(false);
  });

  it('only unmasks the feed when asked to, in any of the spellings an operator might type', () => {
    for (const yes of ['true', '1', 'yes', 'on']) {
      expect(telegramConfigFor({ TELEGRAM_FEED_FULL_DETAIL: yes }).feedFullDetail).toBe(true);
    }
    for (const no of ['false', '0', 'no', 'off']) {
      expect(telegramConfigFor({ TELEGRAM_FEED_FULL_DETAIL: no }).feedFullDetail).toBe(false);
    }
  });

  it('refuses to start on a malformed value rather than silently disabling the feature', () => {
    expect(() => telegramConfigFor({ TELEGRAM_FEED_FULL_DETAIL: 'maybe' })).toThrow(
      /TELEGRAM_FEED_FULL_DETAIL/,
    );
  });
});

/**
 * Same reasoning as the block above, plus one twist that belongs to this variable alone: ABSENT and
 * BLANK mean DIFFERENT things here (default vs off), and that is exactly the kind of distinction a
 * refactor flattens by accident — after which either the schedule silently stops or an operator who
 * emptied the line keeps getting reports they asked to stop.
 */
describe('REPORT_SCHEDULE_HOURS', () => {
  it('defaults to every six hours when the line is absent', () => {
    expect(telegramConfigFor({}).reportScheduleHours).toBe(6);
  });

  it('is OFF at 0 — and an EMPTY line means the same thing, not the default', () => {
    expect(telegramConfigFor({ REPORT_SCHEDULE_HOURS: '0' }).reportScheduleHours).toBe(0);
    expect(telegramConfigFor({ REPORT_SCHEDULE_HOURS: '' }).reportScheduleHours).toBe(0);
    expect(telegramConfigFor({ REPORT_SCHEDULE_HOURS: '   ' }).reportScheduleHours).toBe(0);
  });

  it('accepts the documented range, ends included', () => {
    expect(telegramConfigFor({ REPORT_SCHEDULE_HOURS: '1' }).reportScheduleHours).toBe(1);
    expect(telegramConfigFor({ REPORT_SCHEDULE_HOURS: '24' }).reportScheduleHours).toBe(24);
    expect(telegramConfigFor({ REPORT_SCHEDULE_HOURS: '168' }).reportScheduleHours).toBe(168);
  });

  it('refuses to start on a value outside that range rather than choosing one', () => {
    for (const bad of ['169', '-1', '6.5', 'often']) {
      expect(() => telegramConfigFor({ REPORT_SCHEDULE_HOURS: bad })).toThrow(
        /REPORT_SCHEDULE_HOURS/,
      );
    }
  });
});

/** A complete, valid environment plus whatever the case under test wants to say about Ichancy. */
function ichancyEnvFor(overrides: Record<string, string>): ReturnType<typeof validateEnv> {
  applyTestEnv({
    DATABASE_URL: 'postgresql://app:app@localhost:5432/ichancy?schema=public',
    REDIS_URL: 'redis://localhost:6379',
  });
  return validateEnv({ ...process.env, ...overrides });
}

describe('ICHANCY_USER_AGENT / ICHANCY_COOKIE', () => {
  /**
   * REGRESSION. .env.example tells operators to leave both blank once the server IP is allowlisted,
   * and `ICHANCY_USER_AGENT=` parses as an EMPTY STRING, not undefined — a `.default()` fills only
   * undefined. The first version of this schema therefore refused to boot on its own documented
   * configuration, with "Too small: expected string to have >=1 characters".
   */
  it('treats a blank ICHANCY_USER_AGENT as unset and falls back to the default', () => {
    expect(ichancyEnvFor({ ICHANCY_USER_AGENT: '' }).ICHANCY_USER_AGENT).toContain('Mozilla/5.0');
  });

  it('treats whitespace the same way', () => {
    expect(ichancyEnvFor({ ICHANCY_USER_AGENT: '   ' }).ICHANCY_USER_AGENT).toContain(
      'Mozilla/5.0',
    );
  });

  it('keeps an explicit User-Agent, trimmed', () => {
    expect(ichancyEnvFor({ ICHANCY_USER_AGENT: '  CustomAgent/1.0  ' }).ICHANCY_USER_AGENT).toBe(
      'CustomAgent/1.0',
    );
  });

  it('accepts a blank cookie — the allowlisted-IP case needs none', () => {
    expect(() => ichancyEnvFor({ ICHANCY_COOKIE: '' })).not.toThrow();
  });
});

describe('ICHANCY_TRANSPORT', () => {
  /**
   * THE DEFAULT IS THE FIX. A pasted cf_clearance was measured surviving ~17 minutes on 2026-08-19
   * and, hours later, exactly one request, because Cloudflare's trust score for an IP decays with
   * every challenge that IP fails. On 2026-08-20 the same curve blocked the integration for hours
   * and stranded a player at PENDING_ICHANCY. A deployment that says nothing must get the transport
   * that solves the challenge for itself, not the one that counts down.
   */
  it('defaults to the browser transport', () => {
    expect(ichancyEnvFor({}).ICHANCY_TRANSPORT).toBe('browser');
  });

  it('still lets a deployment choose the fetch fallback explicitly', () => {
    // An IP-allowlisted host, or ICHANCY_FAKE=true, needs no browser — and the fallback has to stay
    // one line away, because the preflight now refuses to boot without Chromium.
    expect(ichancyEnvFor({ ICHANCY_TRANSPORT: 'fetch' }).ICHANCY_TRANSPORT).toBe('fetch');
  });

  it('refuses a transport nobody implements', () => {
    expect(() => ichancyEnvFor({ ICHANCY_TRANSPORT: 'curl' })).toThrow();
  });
});

describe('ICHANCY_PROXY_URL / _USERNAME / _PASSWORD', () => {
  const proxyOf = (overrides: Record<string, string>): AppConfigService['ichancy']['proxy'] =>
    new AppConfigService(ichancyEnvFor(overrides)).ichancy.proxy;

  it('is DIRECT (null) when unset — the default, unchanged behaviour', () => {
    expect(proxyOf({})).toBeNull();
  });

  it('treats a blank URL as unset (emptying the line turns the feature off)', () => {
    expect(proxyOf({ ICHANCY_PROXY_URL: '', ICHANCY_PROXY_USERNAME: 'u' })).toBeNull();
  });

  it('carries server + credentials, with the credentials kept OUT of the server string', () => {
    const proxy = proxyOf({
      ICHANCY_PROXY_URL: 'http://proxy.example:3128',
      ICHANCY_PROXY_USERNAME: 'exit',
      ICHANCY_PROXY_PASSWORD: 's3cr3t',
    });
    expect(proxy).toEqual({ server: 'http://proxy.example:3128', username: 'exit', password: 's3cr3t' });
    // The password must NOT be inside `server` — that field is printed in logs and describeTransport.
    expect(proxy?.server).not.toContain('s3cr3t');
  });

  it('allows a credential-free proxy (open, or IP-authenticated)', () => {
    expect(proxyOf({ ICHANCY_PROXY_URL: 'socks5://exit.example:1080' })).toEqual({
      server: 'socks5://exit.example:1080',
      username: null,
      password: null,
    });
  });

  it('REFUSES credentials embedded in the URL — they would leak into every egress log line', () => {
    expect(() => ichancyEnvFor({ ICHANCY_PROXY_URL: 'http://user:pass@proxy.example:3128' })).toThrow(
      /ICHANCY_PROXY_URL/,
    );
  });

  it('refuses a URL with no port, or an unsupported scheme', () => {
    expect(() => ichancyEnvFor({ ICHANCY_PROXY_URL: 'http://proxy.example' })).toThrow();
    expect(() => ichancyEnvFor({ ICHANCY_PROXY_URL: 'ftp://proxy.example:21' })).toThrow();
  });
});
