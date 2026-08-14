/**
 * WHY not the bundled in-memory storage: @nestjs/throttler's default keeps its counters in a
 * process-local Map. The api role is designed to run as N replicas behind a load balancer, so an
 * in-memory limiter gives an attacker N x the configured limit for free — and the endpoints we
 * throttle (the initData exchange, refresh, deposit creation, proof upload) are exactly the ones
 * where that matters. Redis is already a hard dependency of this process, so a shared counter costs
 * nothing extra.
 *
 * WHY one Lua script instead of INCR + PTTL + SET: the "did this hit cross the limit?" decision has
 * to happen where the counter lives. Doing it client-side lets two concurrent requests each read
 * `limit - 1` and both proceed. The script is loaded once per connection by ioredis' defineCommand
 * (EVALSHA with an automatic NOSCRIPT fallback), so this is a single round trip.
 *
 * WHY it fails OPEN: a rate limiter that rejects traffic when Redis is unreachable turns a
 * dependency blip into a full outage of the login path. Nothing here is a security control on its
 * own — the auth exchange is additionally protected by the initData signature and a Redis-backed
 * single-use nonce, both of which are unavailable anyway when Redis is down. So a storage failure
 * is logged and the request is allowed.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';

import { RedisService } from '@core/cache/redis.service';

/**
 * @nestjs/throttler declares `ThrottlerStorageRecord` but does not re-export it from the package
 * root, and reaching into `@nestjs/throttler/dist/...` would break on any internal reshuffle.
 * Restating the four fields keeps `implements ThrottlerStorage` structurally satisfied without
 * depending on a path the package never promised.
 *
 * Both time fields are SECONDS (the reference in-memory storage returns `ceil(ms / 1000)`), while
 * the `ttl`/`blockDuration` arguments are MILLISECONDS. Getting that backwards yields a limiter
 * that looks correct and expires 1000x too early.
 */
interface ThrottlerCount {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/** Namespace so a FLUSHDB of throttle counters can never touch sessions, locks or BullMQ. */
const KEY_PREFIX = 'throttle';

const SCRIPT_NAME = 'ichancyThrottlerIncrement';

/**
 * KEYS[1] hit counter, KEYS[2] block flag.
 * ARGV[1] ttl (ms), ARGV[2] limit, ARGV[3] block duration (ms).
 * Returns { totalHits, timeToExpireMs, isBlocked, timeToBlockExpireMs }.
 */
const INCREMENT_SCRIPT = `
local hitsKey  = KEYS[1]
local blockKey = KEYS[2]
local ttlMs    = tonumber(ARGV[1])
local limit    = tonumber(ARGV[2])
local blockMs  = tonumber(ARGV[3])

-- A live block short-circuits: while blocked we do not extend the counter, mirroring the
-- reference in-memory implementation (a blocked caller cannot push their own penalty out).
local blockPttl = redis.call('PTTL', blockKey)
if blockPttl > 0 then
  local blocked = tonumber(redis.call('GET', hitsKey) or '0')
  return { blocked, blockPttl, 1, blockPttl }
end

local hits = redis.call('INCR', hitsKey)
local pttl = redis.call('PTTL', hitsKey)
if pttl < 0 then
  -- First hit of a window (or a key that somehow lost its TTL): start the window now.
  redis.call('PEXPIRE', hitsKey, ttlMs)
  pttl = ttlMs
end

if hits > limit then
  redis.call('SET', blockKey, '1', 'PX', blockMs)
  return { hits, pttl, 1, blockMs }
end

return { hits, pttl, 0, 0 }
`;

/** ioredis attaches defineCommand'd scripts as instance methods; this is their shape. */
interface RedisWithThrottleScript {
  [SCRIPT_NAME]?: (
    hitsKey: string,
    blockKey: string,
    ttlMs: string,
    limit: string,
    blockMs: string,
  ) => Promise<unknown>;
}

const msToSeconds = (milliseconds: number): number => Math.ceil(milliseconds / 1000);

function readNumber(source: unknown, index: number): number {
  if (!Array.isArray(source)) return 0;
  const value: unknown = source[index];
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private scriptReady = false;

  constructor(private readonly redis: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerCount> {
    const hitsKey = `${KEY_PREFIX}:${throttlerName}:${key}`;
    const blockKey = `${KEY_PREFIX}:${throttlerName}:${key}:blocked`;

    try {
      const raw = await this.run(hitsKey, blockKey, ttl, limit, blockDuration);
      return {
        totalHits: readNumber(raw, 0),
        timeToExpire: msToSeconds(readNumber(raw, 1)),
        isBlocked: readNumber(raw, 2) === 1,
        timeToBlockExpire: msToSeconds(readNumber(raw, 3)),
      };
    } catch (error: unknown) {
      this.logger.error(
        `Rate-limit counter unavailable, allowing request: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // Fail open — see the header. `totalHits: 1` keeps the X-RateLimit-* headers coherent.
      return {
        totalHits: 1,
        timeToExpire: msToSeconds(ttl),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }

  private async run(
    hitsKey: string,
    blockKey: string,
    ttl: number,
    limit: number,
    blockDuration: number,
  ): Promise<unknown> {
    this.ensureScript();
    const client = this.redis as unknown as RedisWithThrottleScript;
    const command = client[SCRIPT_NAME];
    if (command === undefined) {
      throw new Error(`ioredis did not register the ${SCRIPT_NAME} script`);
    }
    return command.call(
      this.redis,
      hitsKey,
      blockKey,
      String(ttl),
      String(limit),
      String(blockDuration),
    );
  }

  /**
   * Defined lazily rather than in the constructor: RedisService is @Global and shared, and defining
   * the same command twice on one ioredis instance throws.
   */
  private ensureScript(): void {
    if (this.scriptReady) return;
    const client = this.redis as unknown as RedisWithThrottleScript;
    if (client[SCRIPT_NAME] === undefined) {
      this.redis.defineCommand(SCRIPT_NAME, { numberOfKeys: 2, lua: INCREMENT_SCRIPT });
    }
    this.scriptReady = true;
  }
}
