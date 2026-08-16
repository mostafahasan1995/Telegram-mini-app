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
import { REPORT_SCHEDULE_TICK_MS } from '../admin.constants';
import { ActivityReportService } from './activity-report.service';
import {
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
