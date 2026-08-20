/**
 * THE BREAKER, pinned against the incident it was written for.
 *
 * On 2026-08-20 every agent-API call answered `AMBIGUOUS / 403 / CLOUDFLARE_CHALLENGE` for hours
 * and nothing anywhere counted them. What this file proves is that a RUN of unanswered calls opens
 * the breaker, that an ANSWER of any kind — including a flat business rejection — closes it again,
 * and that the whole thing is inert in fake mode and incapable of throwing into a money call.
 */
import { type AppConfigService } from '@core/config/config.service';
import { type RedisService } from '@core/cache/redis.service';

import { type IchancyClassification } from './error-map';
import {
  ICHANCY_DOWN_THRESHOLD,
  ICHANCY_HEALTH_KEY,
  IchancyHealthService,
} from './ichancy-health.service';

/** Just the four commands the service uses. A fake, not a mock: the state transitions are the test. */
class FakeRedis {
  readonly hashes = new Map<string, Map<string, string>>();

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
}

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

const DUPLICATE_LOGIN: IchancyClassification = {
  outcome: 'rejected',
  code: 'ALREADY_EXISTS',
  message: 'Duplicate login',
  rule: 'DUPLICATE_LOGIN',
};

const OK: IchancyClassification = { outcome: 'ok' };

function build(fake = false): { service: IchancyHealthService; redis: FakeRedis } {
  const redis = new FakeRedis();
  const config = { ichancy: { fake } } as unknown as AppConfigService;
  return {
    service: new IchancyHealthService(redis as unknown as RedisService, config),
    redis,
  };
}

describe('IchancyHealthService', () => {
  it('stays UP for fewer failures than the threshold', async () => {
    const { service } = build();

    for (let i = 0; i < ICHANCY_DOWN_THRESHOLD - 1; i += 1) {
      await service.record('registerPlayer', CHALLENGE);
    }

    const snapshot = await service.snapshot();
    expect(snapshot.state).toBe('UP');
    expect(snapshot.consecutive).toBe(ICHANCY_DOWN_THRESHOLD - 1);
    expect(await service.isDown()).toBe(false);
  });

  it('opens on the Nth consecutive unanswered call and names the kind', async () => {
    const { service } = build();

    for (let i = 0; i < ICHANCY_DOWN_THRESHOLD; i += 1) {
      await service.record('getAgentAllWallets', CHALLENGE);
    }

    const snapshot = await service.snapshot();
    expect(snapshot.state).toBe('DOWN');
    expect(snapshot.kind).toBe('CLOUDFLARE_CHALLENGE');
    expect(snapshot.lastEndpoint).toBe('getAgentAllWallets');
    // `since` is the outage's start, not the moment the breaker tripped: the recovery message
    // quotes a duration, and anchoring it on the third failure would understate every outage.
    expect(snapshot.since).not.toBeNull();
    expect(await service.isDown()).toBe(true);
  });

  it('treats a business REJECTION as proof the integration is healthy', async () => {
    // The distinction the whole class turns on: "Duplicate login" means something on the far side
    // read our request and formed an opinion about it. That is an integration that works.
    const { service } = build();
    for (let i = 0; i < ICHANCY_DOWN_THRESHOLD; i += 1) {
      await service.record('registerPlayer', CHALLENGE);
    }
    expect(await service.isDown()).toBe(true);

    await service.record('registerPlayer', DUPLICATE_LOGIN);

    const snapshot = await service.snapshot();
    expect(snapshot.state).toBe('UP');
    expect(snapshot.consecutive).toBe(0);
    expect(snapshot.recoveredAt).not.toBeNull();
    // Kept so the recovery alert can say how long the outage lasted.
    expect(snapshot.since).not.toBeNull();
  });

  it('closes on a plain success too', async () => {
    const { service } = build();
    for (let i = 0; i < ICHANCY_DOWN_THRESHOLD; i += 1) {
      await service.record('signin', CHALLENGE);
    }

    await service.record('signin', OK);

    expect(await service.isDown()).toBe(false);
  });

  it('restarts the count when the KIND of failure changes', async () => {
    // Three timeouts and three challenges are two different outages with two different fixes, and
    // the kind is the most useful field in the alert. Averaging them would name the wrong one.
    const { service } = build();
    await service.record('registerPlayer', CHALLENGE);
    await service.record('registerPlayer', CHALLENGE);

    await service.record('registerPlayer', TIMED_OUT);

    const snapshot = await service.snapshot();
    expect(snapshot.consecutive).toBe(1);
    expect(snapshot.kind).toBe('TIMEOUT');
    expect(snapshot.state).toBe('UP');
  });

  it('is a pure no-op in fake mode', async () => {
    const { service, redis } = build(true);

    for (let i = 0; i < ICHANCY_DOWN_THRESHOLD + 5; i += 1) {
      await service.record('registerPlayer', CHALLENGE);
    }

    expect(redis.hashes.get(ICHANCY_HEALTH_KEY)).toBeUndefined();
    expect(await service.isDown()).toBe(false);
  });

  it('never propagates a Redis failure into the caller', async () => {
    // `record` sits inside the money path. A health gauge that can break a credit is worse than no
    // gauge at all, so a dead Redis has to degrade to a log line and nothing else.
    const redis = {
      hgetall: () => Promise.reject(new Error('redis is gone')),
      hget: () => Promise.reject(new Error('redis is gone')),
      hset: () => Promise.reject(new Error('redis is gone')),
      hdel: () => Promise.reject(new Error('redis is gone')),
    } as unknown as RedisService;
    const service = new IchancyHealthService(redis, {
      ichancy: { fake: false },
    } as unknown as AppConfigService);

    await expect(service.record('registerPlayer', CHALLENGE)).resolves.toBeUndefined();
    await expect(service.record('registerPlayer', OK)).resolves.toBeUndefined();
    // And the gate fails OPEN: an unreadable breaker must not silently pause registrations.
    await expect(service.isDown()).resolves.toBe(false);
  });
});
