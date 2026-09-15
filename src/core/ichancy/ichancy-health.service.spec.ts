/**
 * THE BREAKER, pinned against the incident it was written for.
 *
 * On 2026-08-20 every agent-API call answered `AMBIGUOUS / 403 / CLOUDFLARE_CHALLENGE` for hours
 * and nothing anywhere counted them. What this file proves is that a RUN of unanswered calls opens
 * the breaker, that an ANSWER of any kind — including a flat business rejection — closes it again,
 * that each operator has its own breaker, and that the whole thing is inert in fake mode and
 * incapable of throwing into a money call.
 */
import { type AppConfigService } from '@core/config/config.service';
import { type RedisService } from '@core/cache/redis.service';

import { type IchancyClassification } from './error-map';
import {
  ICHANCY_DOWN_THRESHOLD,
  IchancyHealthService,
  ichancyHealthKey,
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

const OPERATOR_A = '11111111-1111-4111-8111-111111111111';
const OPERATOR_B = '22222222-2222-4222-8222-222222222222';

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
      await service.record(OPERATOR_A, 'registerPlayer', CHALLENGE);
    }

    const snapshot = await service.snapshot(OPERATOR_A);
    expect(snapshot.state).toBe('UP');
    expect(snapshot.consecutive).toBe(ICHANCY_DOWN_THRESHOLD - 1);
    expect(await service.isDown(OPERATOR_A)).toBe(false);
  });

  it('opens on the Nth consecutive unanswered call and names the kind', async () => {
    const { service } = build();

    for (let i = 0; i < ICHANCY_DOWN_THRESHOLD; i += 1) {
      await service.record(OPERATOR_A, 'getAgentAllWallets', CHALLENGE);
    }

    const snapshot = await service.snapshot(OPERATOR_A);
    expect(snapshot.state).toBe('DOWN');
    expect(snapshot.kind).toBe('CLOUDFLARE_CHALLENGE');
    expect(snapshot.lastEndpoint).toBe('getAgentAllWallets');
    // `since` is the outage's start, not the moment the breaker tripped: the recovery message
    // quotes a duration, and anchoring it on the third failure would understate every outage.
    expect(snapshot.since).not.toBeNull();
    expect(await service.isDown(OPERATOR_A)).toBe(true);
  });

  it('treats a business REJECTION as proof the integration is healthy', async () => {
    // The distinction the whole class turns on: "Duplicate login" means something on the far side
    // read our request and formed an opinion about it. That is an integration that works.
    const { service } = build();
    for (let i = 0; i < ICHANCY_DOWN_THRESHOLD; i += 1) {
      await service.record(OPERATOR_A, 'registerPlayer', CHALLENGE);
    }
    expect(await service.isDown(OPERATOR_A)).toBe(true);

    await service.record(OPERATOR_A, 'registerPlayer', DUPLICATE_LOGIN);

    const snapshot = await service.snapshot(OPERATOR_A);
    expect(snapshot.state).toBe('UP');
    expect(snapshot.consecutive).toBe(0);
    expect(snapshot.recoveredAt).not.toBeNull();
    // Kept so the recovery alert can say how long the outage lasted.
    expect(snapshot.since).not.toBeNull();
  });

  it('closes on a plain success too', async () => {
    const { service } = build();
    for (let i = 0; i < ICHANCY_DOWN_THRESHOLD; i += 1) {
      await service.record(OPERATOR_A, 'signin', CHALLENGE);
    }

    await service.record(OPERATOR_A, 'signin', OK);

    expect(await service.isDown(OPERATOR_A)).toBe(false);
  });

  it('restarts the count when the KIND of failure changes', async () => {
    // Three timeouts and three challenges are two different outages with two different fixes, and
    // the kind is the most useful field in the alert. Averaging them would name the wrong one.
    const { service } = build();
    await service.record(OPERATOR_A, 'registerPlayer', CHALLENGE);
    await service.record(OPERATOR_A, 'registerPlayer', CHALLENGE);

    await service.record(OPERATOR_A, 'registerPlayer', TIMED_OUT);

    const snapshot = await service.snapshot(OPERATOR_A);
    expect(snapshot.consecutive).toBe(1);
    expect(snapshot.kind).toBe('TIMEOUT');
    expect(snapshot.state).toBe('UP');
  });

  describe('one breaker per operator', () => {
    it("opens only the operator whose agent failed, and keeps its error text out of the other's", async () => {
      // One shared hash let operator A's broken agent pause operator B's backfill and send A's
      // endpoint and error message to B's admin group.
      const { service, redis } = build();

      for (let i = 0; i < ICHANCY_DOWN_THRESHOLD; i += 1) {
        await service.record(OPERATOR_A, 'getAgentAllWallets', CHALLENGE);
      }

      expect(await service.isDown(OPERATOR_A)).toBe(true);
      expect(await service.isDown(OPERATOR_B)).toBe(false);
      const other = await service.snapshot(OPERATOR_B);
      expect(other).toMatchObject({ state: 'UP', consecutive: 0, lastEndpoint: null, lastMessage: null });
      expect([...redis.hashes.keys()].filter((key) => (redis.hashes.get(key)?.size ?? 0) > 0)).toEqual([
        ichancyHealthKey(OPERATOR_A),
      ]);
    });

    it("does not let another operator's healthy call reset a real outage", async () => {
      const { service } = build();
      for (let i = 0; i < ICHANCY_DOWN_THRESHOLD; i += 1) {
        await service.record(OPERATOR_A, 'registerPlayer', CHALLENGE);
      }

      await service.record(OPERATOR_B, 'registerPlayer', OK);

      expect(await service.isDown(OPERATOR_A)).toBe(true);
      expect((await service.snapshot(OPERATOR_A)).consecutive).toBe(ICHANCY_DOWN_THRESHOLD);
    });

    it("retires a recovery only for the operator it names", async () => {
      const { service } = build();
      for (const operator of [OPERATOR_A, OPERATOR_B]) {
        for (let i = 0; i < ICHANCY_DOWN_THRESHOLD; i += 1) {
          await service.record(operator, 'registerPlayer', CHALLENGE);
        }
        await service.record(operator, 'registerPlayer', OK);
      }
      const recoveredA = (await service.snapshot(OPERATOR_A)).recoveredAt;
      if (recoveredA === null) throw new Error('operator A should have a recovery pending');

      await service.acknowledgeRecovery(OPERATOR_A, recoveredA);

      expect((await service.snapshot(OPERATOR_A)).recoveredAt).toBeNull();
      expect((await service.snapshot(OPERATOR_B)).recoveredAt).not.toBeNull();
    });
  });

  it('is a pure no-op in fake mode', async () => {
    const { service, redis } = build(true);

    for (let i = 0; i < ICHANCY_DOWN_THRESHOLD + 5; i += 1) {
      await service.record(OPERATOR_A, 'registerPlayer', CHALLENGE);
    }

    expect(redis.hashes.get(ichancyHealthKey(OPERATOR_A))).toBeUndefined();
    expect(await service.isDown(OPERATOR_A)).toBe(false);
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

    await expect(service.record(OPERATOR_A, 'registerPlayer', CHALLENGE)).resolves.toBeUndefined();
    await expect(service.record(OPERATOR_A, 'registerPlayer', OK)).resolves.toBeUndefined();
    // And the gate fails OPEN: an unreadable breaker must not silently pause registrations.
    await expect(service.isDown(OPERATOR_A)).resolves.toBe(false);
  });
});
