/**
 * The arithmetic half of the schedule: given a configured interval, how long does the "already
 * posted" marker live?
 *
 * WHY Redis is NOT tested here: the atomicity this cron depends on is `SET NX EX`, which is Redis's
 * guarantee, not ours. A fake would only prove that the fake behaves like the comment says Redis
 * does. What IS ours — and what silently rots — is the conversion from an operator's "every 6 hours"
 * into a TTL, including the one-tick subtraction that stops the report walking later around the
 * clock every period. That is what this file pins.
 */
import { Logger } from '@nestjs/common';

import { type LockService } from '@core/cache/lock.service';
import { type RedisService } from '@core/cache/redis.service';
import { type AppConfigService } from '@core/config/config.service';
import { type BotService, type TenantChats } from '@core/telegram/services/bot.service';
import { type OperatorRef, type TenantRegistryService, getEffectiveTenantId } from '@core/tenant';

import { REPORT_SCHEDULE_TICK_MS, reportLastPostedKey } from '../admin.constants';
import { ActivityReportService } from './activity-report.service';
import {
  ReportScheduleCron,
  reportMarkerTtlSeconds,
  SCHEDULED_REPORT_HEADER,
  SCHEDULED_REPORT_PERIOD,
} from './report-schedule.cron';

const HOUR_SECONDS = 3600;
const TICK_SECONDS = REPORT_SCHEDULE_TICK_MS / 1000;

/** The documented range of REPORT_SCHEDULE_HOURS: one hour to one week. */
const CONFIGURABLE_HOURS = Array.from({ length: 168 }, (_, index) => index + 1);

describe('reportMarkerTtlSeconds — the elapsed-interval decision', () => {
  it('says OFF for 0, which is the documented disable switch', () => {
    expect(reportMarkerTtlSeconds(0)).toBeNull();
  });

  it('says OFF rather than "post on every tick" for a value the schema would never allow', () => {
    // Defensive: a null here is a quiet schedule, whereas any number would be a report every ten
    // minutes forever. Only one of those two failure modes is survivable in a group chat.
    expect(reportMarkerTtlSeconds(-1)).toBeNull();
    expect(reportMarkerTtlSeconds(Number.NaN)).toBeNull();
    expect(reportMarkerTtlSeconds(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('claims the configured window MINUS one tick', () => {
    expect(reportMarkerTtlSeconds(6)).toBe(6 * HOUR_SECONDS - TICK_SECONDS);
    expect(reportMarkerTtlSeconds(1)).toBe(HOUR_SECONDS - TICK_SECONDS);
    expect(reportMarkerTtlSeconds(168)).toBe(168 * HOUR_SECONDS - TICK_SECONDS);
  });

  /**
   * The anti-drift property, stated as a property rather than as three examples: a post always lands
   * in (interval − tick, interval] of the previous one. If the TTL were the interval itself the
   * marker would expire just after a tick, the post would slip to the next one, and each period
   * would re-anchor from a later timestamp — the report would walk right around the clock.
   */
  it('keeps the configured interval an UPPER bound for every value an operator may set', () => {
    for (const hours of CONFIGURABLE_HOURS) {
      const ttl = reportMarkerTtlSeconds(hours);
      const interval = hours * HOUR_SECONDS;

      expect(ttl).not.toBeNull();
      expect(ttl).toBeLessThan(interval);
      expect(ttl).toBeGreaterThanOrEqual(interval - TICK_SECONDS);
    }
  });

  it('never hands Redis a TTL it would reject, even if the tick outgrew the interval', () => {
    // `EX 0` is an error and a negative TTL expires instantly — which would post on every tick.
    expect(reportMarkerTtlSeconds(1, 2 * HOUR_SECONDS * 1000)).toBe(1);
    expect(reportMarkerTtlSeconds(1, HOUR_SECONDS * 1000)).toBe(1);
  });

  it('returns whole seconds, because EX has no other resolution', () => {
    for (const hours of CONFIGURABLE_HOURS) {
      expect(Number.isInteger(reportMarkerTtlSeconds(hours))).toBe(true);
    }
    // A tick that is not a whole number of seconds must round UP, never leaving the marker alive
    // past its window by a remainder.
    expect(reportMarkerTtlSeconds(1, 1_500)).toBe(HOUR_SECONDS - 2);
  });
});

describe('what the schedule posts', () => {
  /**
   * The cron asks ActivityReportService to resolve its period so the Arabic label comes from the one
   * table that owns it. That call has a null branch for an unknown period; this is what keeps the
   * branch unreachable rather than merely unlikely. resolveReportPeriod() touches none of the three
   * injected dependencies, so an empty container is enough.
   */
  it('asks for a period the report service actually recognises', () => {
    const service = new ActivityReportService({} as never, {} as never, {} as never);

    const period = service.resolveReportPeriod(SCHEDULED_REPORT_PERIOD);

    expect(period).not.toBeNull();
    expect(period?.key).toBe('day');
    // The label is the report's, never restated here.
    expect(period?.label).toBe('اليوم');
  });

  it('is labelled so it can never be read as a report an admin just ran', () => {
    expect(SCHEDULED_REPORT_HEADER).toContain('تقرير دوري');
    // HTML parse mode, like every other bold line this bot sends.
    expect(SCHEDULED_REPORT_HEADER).toContain('<b>');
  });
});

/**
 * WHERE it goes, and whose numbers. Redis here is a set of keys with SET NX semantics — the
 * atomicity is Redis's, as the header says; what is ours is which key each operator claims.
 */
describe('one report per operator', () => {
  const OPERATOR_A: OperatorRef = { id: '11111111-1111-4111-8111-111111111111', slug: 'alpha' };
  const OPERATOR_B: OperatorRef = { id: '22222222-2222-4222-8222-222222222222', slug: 'beta' };

  function build(options: { feedFullDetail?: boolean; chats?: Record<string, TenantChats> } = {}): {
    cron: ReportScheduleCron;
    sendMessage: jest.Mock;
    buildReport: jest.Mock;
    keys: Set<string>;
    builtIn: Array<string | undefined>;
  } {
    const keys = new Set<string>();
    const redis = {
      set: jest.fn((key: string) => {
        if (keys.has(key)) return Promise.resolve(null);
        keys.add(key);
        return Promise.resolve('OK');
      }),
      del: jest.fn((key: string) => Promise.resolve(keys.delete(key) ? 1 : 0)),
    };
    const builtIn: Array<string | undefined> = [];
    const buildReport = jest.fn(() => {
      builtIn.push(getEffectiveTenantId());
      return Promise.resolve(`numbers of ${getEffectiveTenantId() ?? 'nobody'}`);
    });
    const chats = options.chats ?? {
      [OPERATOR_A.id]: { adminChatId: -1001n, feedChatId: null },
      [OPERATOR_B.id]: { adminChatId: -1002n, feedChatId: -1092n },
    };
    const sendMessage = jest.fn().mockResolvedValue({ message_id: 1 });

    const cron = new ReportScheduleCron(
      {
        resolveReportPeriod: () => ({ key: 'day', label: 'اليوم' }),
        buildReport,
      } as unknown as ActivityReportService,
      {
        acquire: jest.fn().mockResolvedValue({ key: 'k', token: 't', acquiredAt: 0, ttlMs: 1 }),
        release: jest.fn().mockResolvedValue(true),
      } as unknown as LockService,
      redis as unknown as RedisService,
      {
        chatsOf: (tenantId: string) =>
          Promise.resolve(chats[tenantId] ?? { adminChatId: null, feedChatId: null }),
        sendMessage,
      } as unknown as BotService,
      {
        listActiveOperators: jest.fn().mockResolvedValue([OPERATOR_A, OPERATOR_B]),
      } as unknown as TenantRegistryService,
      {
        app: { isWorker: true },
        telegram: { reportScheduleHours: 6, feedFullDetail: options.feedFullDetail ?? false },
      } as unknown as AppConfigService,
    );
    return { cron, sendMessage, buildReport, keys, builtIn };
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('builds each operator’s report in that operator’s context and posts it through its own bot', async () => {
    const h = build();

    await h.cron.tick();

    expect(h.builtIn).toEqual([OPERATOR_A.id, OPERATOR_B.id]);
    expect((h.sendMessage.mock.calls as unknown[][]).map((call) => [call[0], call[1]])).toEqual([
      [OPERATOR_A.id, -1001n],
      // A masked feed may contain customers, and the report carries the float: admin group.
      [OPERATOR_B.id, -1002n],
    ]);
    expect(h.sendMessage.mock.calls[1]?.[2]).toContain(`numbers of ${OPERATOR_B.id}`);
    expect([...h.keys].sort()).toEqual(
      [reportLastPostedKey(OPERATOR_A.id), reportLastPostedKey(OPERATOR_B.id)].sort(),
    );
  });

  it('uses an operator’s feed group only when feed groups are declared staff-only', async () => {
    const h = build({ feedFullDetail: true });

    await h.cron.tick();

    expect((h.sendMessage.mock.calls as unknown[][]).map((call) => call[1])).toEqual([
      -1001n,
      -1092n,
    ]);
  });

  it('posts once per window per operator', async () => {
    const h = build();

    await h.cron.tick();
    await h.cron.tick();

    expect(h.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('does not let one operator’s failed send stop the next, and keeps the failed claim', async () => {
    const h = build();
    h.sendMessage.mockImplementation((tenantId: string) =>
      tenantId === OPERATOR_A.id
        ? Promise.reject(new Error('bot token revoked'))
        : Promise.resolve({}),
    );

    await h.cron.tick();
    await h.cron.tick();

    // A was tried once (a maybe-sent report is never re-posted); B was posted.
    expect((h.sendMessage.mock.calls as unknown[][]).map((call) => call[0])).toEqual([
      OPERATOR_A.id,
      OPERATOR_B.id,
    ]);
  });

  it('skips an operator with no chat set, without touching its bot', async () => {
    const h = build({
      chats: {
        [OPERATOR_A.id]: { adminChatId: null, feedChatId: null },
        [OPERATOR_B.id]: { adminChatId: -1002n, feedChatId: null },
      },
    });

    await h.cron.tick();

    expect((h.sendMessage.mock.calls as unknown[][]).map((call) => call[0])).toEqual([
      OPERATOR_B.id,
    ]);
  });

  it('hands back only the claim of the operator whose report could not be built', async () => {
    const h = build();
    h.buildReport.mockImplementationOnce(() => Promise.reject(new Error('database is slow')));

    await h.cron.tick();

    expect([...h.keys]).toEqual([reportLastPostedKey(OPERATOR_B.id)]);
  });
});
