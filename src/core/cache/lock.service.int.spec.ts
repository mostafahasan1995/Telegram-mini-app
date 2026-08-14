/**
 * Integration tests for the lock and cache primitives. These need a real Redis, because the
 * properties that matter are properties of Redis' atomicity, not of our TypeScript:
 * SET NX PX either wins or loses, and the compare-and-delete Lua script either runs atomically or
 * it does not. A mocked Redis would assert only that we call the methods we call.
 *
 * Run with `npm run test:int` (docker compose up redis first).
 */
import { Redis } from 'ioredis';
import { CacheService } from './cache.service';
import { LockService, LockUnavailableError, type LockHandle } from './lock.service';
import { redisUrlToOptions } from './redis-url.util';
import { type RedisService } from './redis.service';

// Database 9 so a stray run never touches development data.
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/9';

describe('cache + lock (integration)', () => {
  let redis: Redis;
  let locks: LockService;
  let cache: CacheService;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    await redis.ping();
    // RedisService is a Redis subclass that only adds lifecycle hooks, so a plain client is a
    // faithful stand-in for what these services actually use.
    locks = new LockService(redis as unknown as RedisService);
    cache = new CacheService(redis as unknown as RedisService);
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.flushdb();
    await redis.quit();
  });

  describe('LockService', () => {
    it('grants the lock to exactly one caller', async () => {
      const first = await locks.acquire('lock:test:x', 5_000);
      const second = await locks.acquire('lock:test:x', 5_000);

      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });

    it('does NOT release a lock that has changed hands', async () => {
      // The scenario: a holder stalls past its TTL, the lock is granted to someone else, and the
      // stalled holder then calls release(). A plain DEL would delete the NEW owner's lock and let
      // two workers credit the same player at once.
      const held = await locks.acquire('lock:test:x', 5_000);
      expect(held).not.toBeNull();

      const stale: LockHandle = {
        key: 'lock:test:x',
        token: 'a-token-from-a-previous-holder',
        acquiredAt: Date.now(),
        ttlMs: 5_000,
      };

      expect(await locks.release(stale)).toBe(false);
      expect(await redis.exists('lock:test:x')).toBe(1);

      // The real owner can still release it.
      expect(await locks.release(held as LockHandle)).toBe(true);
      expect(await redis.exists('lock:test:x')).toBe(0);
    });

    it('only extends a lock we still own', async () => {
      const handle = await locks.acquire('lock:test:x', 2_000);
      const stale: LockHandle = { key: 'lock:test:x', token: 'nope', acquiredAt: 0, ttlMs: 0 };

      expect(await locks.extend(stale, 30_000)).toBe(false);
      expect(await locks.extend(handle as LockHandle, 30_000)).toBe(true);

      const ttl = await redis.pttl('lock:test:x');
      expect(ttl).toBeGreaterThan(20_000);
    });

    it('releases the lock when the critical section throws', async () => {
      await expect(
        locks.withLock('lock:test:y', 5_000, () => Promise.reject(new Error('boom'))),
      ).rejects.toThrow('boom');

      expect(await redis.exists('lock:test:y')).toBe(0);
    });

    it('throws LockUnavailableError rather than running concurrently', async () => {
      const handle = await locks.acquire('lock:test:z', 5_000);
      await expect(
        locks.withLock('lock:test:z', 5_000, () => Promise.resolve('never')),
      ).rejects.toBeInstanceOf(LockUnavailableError);
      await locks.release(handle as LockHandle);
    });

    it('serializes concurrent callers — the property the credit worker depends on', async () => {
      // If this ever fails, per-player balance-delta verification is invalid: two credits could
      // interleave and each would observe the other's delta.
      let inside = 0;
      let maxInside = 0;

      await Promise.all(
        Array.from({ length: 8 }, () =>
          locks.withLock(
            'lock:test:mutex',
            5_000,
            async () => {
              inside += 1;
              maxInside = Math.max(maxInside, inside);
              await new Promise((resolve) => setTimeout(resolve, 15));
              inside -= 1;
            },
            { retries: 30, retryDelayMs: 10 },
          ),
        ),
      );

      expect(maxInside).toBe(1);
    });

    it('claimOnce succeeds once and can be undone by releaseClaim', async () => {
      expect(await locks.claimOnce('nonce:abc', 60)).toBe(true);
      expect(await locks.claimOnce('nonce:abc', 60)).toBe(false);

      await locks.releaseClaim('nonce:abc');
      expect(await locks.claimOnce('nonce:abc', 60)).toBe(true);
    });

    it('expires a lock after its TTL so a crashed holder cannot block forever', async () => {
      await locks.acquire('lock:test:ttl', 150);
      expect(await locks.acquire('lock:test:ttl', 150)).toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(await locks.acquire('lock:test:ttl', 150)).not.toBeNull();
    });
  });

  describe('CacheService', () => {
    it('collapses a concurrent stampede into a single factory call', async () => {
      let calls = 0;
      const factory = async (): Promise<{ v: number }> => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { v: 42 };
      };

      const results = await Promise.all(
        Array.from({ length: 10 }, () => cache.getOrSet('c:1', 60, factory)),
      );

      expect(results.every((r) => r.v === 42)).toBe(true);
      expect(calls).toBe(1);
    });

    it('serves the second read from Redis', async () => {
      let calls = 0;
      const factory = (): Promise<{ v: number }> => {
        calls += 1;
        return Promise.resolve({ v: 7 });
      };

      await cache.getOrSet('c:2', 60, factory);
      const again = await cache.getOrSet('c:2', 60, factory);

      expect(again.v).toBe(7);
      expect(calls).toBe(1);
    });

    it('caches negative results only when asked to', async () => {
      let withFlag = 0;
      let withoutFlag = 0;

      const nullFactoryA = (): Promise<null> => {
        withFlag += 1;
        return Promise.resolve(null);
      };
      const nullFactoryB = (): Promise<null> => {
        withoutFlag += 1;
        return Promise.resolve(null);
      };

      await cache.getOrSet('c:null', 60, nullFactoryA, { cacheNull: true });
      const cachedNull = await cache.getOrSet('c:null', 60, nullFactoryA, { cacheNull: true });

      await cache.getOrSet('c:null2', 60, nullFactoryB);
      await cache.getOrSet('c:null2', 60, nullFactoryB);

      expect(cachedNull).toBeNull();
      // This is what stops every non-admin Telegram message becoming a database query.
      expect(withFlag).toBe(1);
      expect(withoutFlag).toBe(2);
    });

    it('treats a poisoned entry as a miss instead of throwing', async () => {
      // Shapes change between deploys; a stale, unparseable value must not break the request.
      await redis.set('c:poison', '{not json');
      const value = await cache.getOrSet('c:poison', 60, () => Promise.resolve({ ok: true }));
      expect(value.ok).toBe(true);
    });

    it('honours the TTL', async () => {
      let calls = 0;
      const factory = (): Promise<{ n: number }> => {
        calls += 1;
        return Promise.resolve({ n: calls });
      };

      await cache.getOrSet('c:ttl', 1, factory);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await cache.getOrSet('c:ttl', 1, factory);

      expect(calls).toBe(2);
    });
  });

  describe('redisUrlToOptions', () => {
    it('produces options that actually connect', async () => {
      const client = new Redis(redisUrlToOptions(REDIS_URL));
      expect(await client.ping()).toBe('PONG');
      await client.quit();
    });
  });
});
