/**
 * THE WHOLE OUTAGE, END TO END — the real breaker wired to the real alarm.
 *
 * ══ WHY THIS FILE EXISTS ALONGSIDE ichancy-health.cron.spec.ts ════════════════════════════════
 * That file mocks `IchancyHealthService.snapshot()` and returns a FIXED snapshot, so every tick it
 * simulates carries the same `since`. That proves the cron de-duplicates on a stable anchor — and
 * proves nothing at all about whether the anchor IS stable, which is the half the state machine
 * owns. Three defects lived in exactly that gap:
 *
 *   1. a recovery left `kind` in the hash, so the NEXT outage inherited the previous outage's
 *      `since`, produced the marker key that outage had already claimed, and alarmed NOBODY;
 *   2. `recoveredAt` was never cleared, so when the 24 h marker expired the recovery message was
 *      posted again — and again every 24 h, forever;
 *   3. a change of failure KIND mid-outage moved `since` while the state stayed DOWN, minting a
 *      fresh marker key and a second alarm for one continuous outage. A Cloudflare block that
 *      occasionally times out instead of 403-ing does this every few minutes.
 *
 * So the assertions here are counted MESSAGES across a simulated timeline, driven by classified
 * calls rather than by hand-written snapshots. Nothing is stubbed between the two halves.
 */
import { type LockService } from '@core/cache/lock.service';
import { type RedisService } from '@core/cache/redis.service';
import { type AppConfigService } from '@core/config/config.service';
import { type IchancyClassification } from '@core/ichancy/error-map';
import { ICHANCY_DOWN_THRESHOLD, IchancyHealthService } from '@core/ichancy/ichancy-health.service';
import { type PrismaService } from '@core/prisma/prisma.service';
import { type BotService } from '@core/telegram/services/bot.service';

import { ICHANCY_HEALTH_ANNOUNCE_TTL_SECONDS } from '../reconciliation.constants';
import { IchancyHealthAlertCron } from './ichancy-health.cron';

const HANDLE = { key: 'lock:cron:ichancy-health-alert', token: 't', acquiredAt: 0, ttlMs: 1_000 };

const CHALLENGE: IchancyClassification = {
  outcome: 'ambiguous',
  code: 'CLOUDFLARE_CHALLENGE',
  message: 'Cloudflare answered with a challenge (HTTP 403) instead of the agent API.',
  rule: 'CLOUDFLARE_CHALLENGE',
};

const TIMED_OUT: IchancyClassification = {
  outcome: 'ambiguous',
  code: 'UNKNOWN',
  message: 'Request timed out',
  rule: 'TIMEOUT',
};

const OK: IchancyClassification = { outcome: 'ok' };

/**
 * Hashes and strings, with EXPIRY, because the 24-hour re-announce defect is only visible once a
 * marker is allowed to die. Time is the caller's `now()`, so a test can skip a day in one line.
 */
class FakeRedis {
  readonly hashes = new Map<string, Map<string, string>>();
  private readonly strings = new Map<string, { value: string; expiresAtMs: number }>();

  constructor(private readonly now: () => number) {}

  private bucket(key: string): Map<string, string> {
    let existing = this.hashes.get(key);
    if (existing === undefined) {
      existing = new Map<string, string>();
      this.hashes.set(key, existing);
    }
    return existing;
  }

  hgetall(key: string): Promise<Record<string, string>> {
    return Promise.resolve(Object.fromEntries(this.bucket(key)));
  }

  hget(key: string, field: string): Promise<string | null> {
    return Promise.resolve(this.bucket(key).get(field) ?? null);
  }

  hset(key: string, fields: Record<string, string>): Promise<number> {
    for (const [field, value] of Object.entries(fields)) this.bucket(key).set(field, value);
    return Promise.resolve(Object.keys(fields).length);
  }

  hdel(key: string, ...fields: string[]): Promise<number> {
    for (const field of fields) this.bucket(key).delete(field);
    return Promise.resolve(fields.length);
  }

  set(
    key: string,
    value: string,
    _ex: string,
    ttlSeconds: number,
    _nx: string,
  ): Promise<'OK' | null> {
    const existing = this.strings.get(key);
    if (existing !== undefined && existing.expiresAtMs > this.now()) return Promise.resolve(null);
    this.strings.set(key, { value, expiresAtMs: this.now() + ttlSeconds * 1000 });
    return Promise.resolve('OK');
  }

  del(key: string): Promise<number> {
    return Promise.resolve(this.strings.delete(key) ? 1 : 0);
  }
}

interface Harness {
  readonly health: IchancyHealthService;
  readonly posts: string[];
  /** Advance the simulated clock, which drives both `new Date()` and the fake's TTLs. */
  advance(ms: number): void;
  /** One classified agent-API call, exactly as IchancyHttpClient would report it. */
  call(classification: IchancyClassification): Promise<void>;
  /** One cron tick. */
  tick(): Promise<void>;
}

function build(): Harness {
  // Jest's modern fake timers, so `new Date()` and `Date.now()` cannot disagree — the hash stores
  // ISO strings written by the former while the marker TTLs are compared against the latter, and a
  // half-mocked clock would make this whole file test the mock instead of the code.
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
  jest.setSystemTime(Date.parse('2026-08-20T04:00:00.000Z'));

  const redis = new FakeRedis(() => Date.now());
  const config = {
    app: { isWorker: true },
    ichancy: { fake: false },
  } as unknown as AppConfigService;

  const health = new IchancyHealthService(redis as unknown as RedisService, config);

  const posts: string[] = [];
  const notifyAdmins = jest.fn((text: string) => {
    posts.push(text);
    return Promise.resolve({ message_id: posts.length });
  });

  const cron = new IchancyHealthAlertCron(
    health,
    { notifyAdmins } as unknown as BotService,
    {
      acquire: jest.fn().mockResolvedValue(HANDLE),
      release: jest.fn().mockResolvedValue(true),
    } as unknown as LockService,
    redis as unknown as RedisService,
    { player: { count: jest.fn().mockResolvedValue(0) } } as unknown as PrismaService,
    config,
  );

  return {
    health,
    posts,
    advance: (ms: number): void => {
      jest.setSystemTime(Date.now() + ms);
    },
    call: (classification: IchancyClassification): Promise<void> =>
      health.record('registerPlayer', classification),
    tick: (): Promise<void> => cron.tick(),
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('Ichancy outage lifecycle (real breaker + real alarm)', () => {
  it('raises ONE alarm and ONE recovery across a four-hour outage', async () => {
    const h = build();

    // Four hours of the incident: the ambient float sync every 5 minutes, all challenged, with the
    // alert cron ticking every minute the whole time.
    for (let minute = 0; minute < 4 * 60; minute += 1) {
      if (minute % 5 === 0) await h.call(CHALLENGE);
      await h.tick();
      h.advance(MINUTE);
    }
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toContain('متوقف');

    // Ichancy comes back, and we keep ticking for another hour.
    await h.call(OK);
    for (let minute = 0; minute < 60; minute += 1) {
      await h.tick();
      h.advance(MINUTE);
    }

    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]).toContain('عاد');
    // Measured from the FIRST failed call, not from the tick that tripped the breaker.
    expect(h.posts[1]).toContain('4 ساعة');
  });

  it('does not re-announce a recovery when the 24-hour marker expires', async () => {
    const h = build();

    for (let i = 0; i < ICHANCY_DOWN_THRESHOLD; i += 1) await h.call(CHALLENGE);
    await h.tick();
    await h.call(OK);
    await h.tick();
    expect(h.posts).toHaveLength(2);

    // A quiet day passes. The marker's TTL lapses; the recovery must NOT be posted a second time.
    h.advance(ICHANCY_HEALTH_ANNOUNCE_TTL_SECONDS * 1000 + MINUTE);
    await h.tick();
    await h.tick();

    expect(h.posts).toHaveLength(2);
  });

  it('alarms again for a SECOND outage on the same day', async () => {
    // The silent-failure case: outage two inheriting outage one's `since` reproduces a marker key
    // that is still alive, the claim is refused, and nobody is ever told about outage two.
    const h = build();

    for (let i = 0; i < ICHANCY_DOWN_THRESHOLD; i += 1) await h.call(CHALLENGE);
    await h.tick();
    await h.call(OK);
    await h.tick();
    expect(h.posts).toHaveLength(2);

    h.advance(2 * HOUR);
    for (let i = 0; i < ICHANCY_DOWN_THRESHOLD; i += 1) await h.call(CHALLENGE);
    await h.tick();

    expect(h.posts).toHaveLength(3);
    expect(h.posts[2]).toContain('متوقف');
  });

  it('reports the SECOND outage duration from its own start, not the first outage', async () => {
    const h = build();

    for (let i = 0; i < ICHANCY_DOWN_THRESHOLD; i += 1) await h.call(CHALLENGE);
    await h.tick();
    await h.call(OK);
    await h.tick();

    h.advance(5 * HOUR);
    for (let i = 0; i < ICHANCY_DOWN_THRESHOLD; i += 1) await h.call(CHALLENGE);
    await h.tick();
    h.advance(30 * MINUTE);
    await h.call(OK);
    await h.tick();

    // 30 minutes, not five and a half hours.
    expect(h.posts).toHaveLength(4);
    expect(h.posts[3]).toContain('30 دقيقة');
    expect(h.posts[3]).not.toContain('ساعة');
  });

  it('stays at ONE alarm when the failure KIND flaps mid-outage', async () => {
    // A blocked host does not fail identically every time: the browser transport times out while
    // it is trying to solve the challenge, so 403s and timeouts interleave. That is one outage.
    const h = build();

    for (let i = 0; i < ICHANCY_DOWN_THRESHOLD; i += 1) await h.call(CHALLENGE);
    await h.tick();
    expect(h.posts).toHaveLength(1);

    for (let round = 0; round < 20; round += 1) {
      await h.call(round % 2 === 0 ? TIMED_OUT : CHALLENGE);
      await h.tick();
      h.advance(MINUTE);
    }

    expect(h.posts).toHaveLength(1);
    // The breaker never re-closed on its own: only an ANSWERED call may do that.
    expect(await h.health.isDown()).toBe(true);
  });

  it('names the CURRENT failure kind even though the alarm was raised for the previous one', async () => {
    const h = build();

    for (let i = 0; i < ICHANCY_DOWN_THRESHOLD; i += 1) await h.call(CHALLENGE);
    await h.tick();
    await h.call(TIMED_OUT);

    const snapshot = await h.health.snapshot();
    expect(snapshot.state).toBe('DOWN');
    expect(snapshot.kind).toBe('TIMEOUT');
  });
});
