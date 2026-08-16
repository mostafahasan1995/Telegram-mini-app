/**
 * The optional feed-group variables, end to end: raw string -> zod -> AppConfigService.
 *
 * WHY these two get a spec when the required variables do not: a required variable that breaks
 * refuses to boot, loudly, on the first deploy. An OPTIONAL one that breaks boots perfectly and
 * silently does nothing — which is exactly how ICHANCY_FAKE came to be inert while appearing to be
 * set (see the note on it in env.schema.ts). TELEGRAM_FEED_CHAT_ID transforms to bigint, so it has
 * the same shape as the trap that bit us; this locks in that a configured feed is a bigint on the
 * far side and an unconfigured one is null rather than undefined.
 *
 * Note what this does NOT cover: @nestjs/config dropping transformed values from process.env. That
 * hazard lives in config.module.ts, which captures the validated object instead of re-reading
 * process.env — the reason nothing outside these two files may read a transformed var directly.
 */
import { applyTestEnv } from '../../../test/setup/test-env';
import { AppConfigService } from './config.service';
import { validateEnv } from './env.schema';

/** A complete, valid environment plus whatever the case under test wants to say about the feed. */
function telegramConfigFor(feed: Record<string, string>): AppConfigService['telegram'] {
  applyTestEnv({
    DATABASE_URL: 'postgresql://app:app@localhost:5432/ichancy?schema=public',
    REDIS_URL: 'redis://localhost:6379',
  });
  return new AppConfigService(validateEnv({ ...process.env, ...feed })).telegram;
}

describe('TELEGRAM_FEED_CHAT_ID / TELEGRAM_FEED_FULL_DETAIL', () => {
  it('is off, and masked, when nothing is configured', () => {
    const telegram = telegramConfigFor({});
    expect(telegram.feedChatId).toBeNull();
    expect(telegram.feedFullDetail).toBe(false);
  });

  /** Emptying the line is how an operator turns the feed off; it must not refuse to boot. */
  it('treats a blank value the same as an absent one', () => {
    const telegram = telegramConfigFor({
      TELEGRAM_FEED_CHAT_ID: '   ',
      TELEGRAM_FEED_FULL_DETAIL: '',
    });
    expect(telegram.feedChatId).toBeNull();
    expect(telegram.feedFullDetail).toBe(false);
  });

  it('survives the transform as a bigint, exactly like the admin chat id', () => {
    const telegram = telegramConfigFor({ TELEGRAM_FEED_CHAT_ID: '-1009876543210' });
    expect(telegram.feedChatId).toBe(-1009876543210n);
    expect(telegram.adminChatId).toBe(-1001234567890n);
    // The two are distinct groups; nothing may quietly alias one to the other.
    expect(telegram.feedChatId).not.toBe(telegram.adminChatId);
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
    expect(() => telegramConfigFor({ TELEGRAM_FEED_CHAT_ID: 'not-an-id' })).toThrow(
      /TELEGRAM_FEED_CHAT_ID/,
    );
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
