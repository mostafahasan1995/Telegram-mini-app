/**
 * WHY getOrSet also dedupes IN-PROCESS: Redis alone does not stop a stampede. When the
 * `admin:tg:<id>` entry expires and 30 Telegram updates arrive in the same tick, all 30 miss the
 * cache and all 30 hit Postgres before the first one writes back. The in-flight promise map
 * collapses those to a single query per process, which is what makes a 60s admin cache actually
 * cheap rather than merely small.
 *
 * NEGATIVE CACHING IS EXPLICIT (`cacheNull`). "This Telegram id is not an admin" is the answer we
 * look up most often — every message from a random user — and not caching it turns the bot into a
 * DB amplifier. But caching a null by default would be a footgun elsewhere, so callers opt in.
 *
 * SERIALIZATION CAVEAT: values round-trip through JSON. `BigInt.prototype.toJSON` (installed in
 * main.ts) turns bigints into strings on the way OUT and nothing turns them back on the way IN.
 * Cache JSON-safe shapes only, and convert at the boundary — see AdminIdentityService, which
 * stores telegramUserId as a string on purpose.
 */
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * Marker for a cached "nothing here", so it is distinguishable from a cache miss.
 * Deliberately NOT valid JSON: if a future refactor ever skips the sentinel check, `parse()` fails
 * and the entry is treated as a miss (correct but slow) rather than decoding to something wrong.
 */
const NULL_SENTINEL = '__NULL__';

export interface GetOrSetOptions {
  /** Store `null` results too. Off by default; see the header note. */
  cacheNull?: boolean;
}

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  /** key -> in-flight factory promise. Cleared in a finally, so a rejection cannot poison the key. */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly redis: RedisService) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.readRaw(key);
    if (raw === null || raw === NULL_SENTINEL) return null;
    return this.parse<T>(key, raw);
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.redis.del(...keys);
  }

  /**
   * Cache-aside read. On a Redis failure the factory still runs — a degraded cache must never take
   * the request path down with it.
   */
  async getOrSet<T>(
    key: string,
    ttlSeconds: number,
    factory: () => Promise<T>,
    options: GetOrSetOptions = {},
  ): Promise<T> {
    const cached = await this.readRaw(key);
    if (cached === NULL_SENTINEL) return null as T;
    if (cached !== null) {
      const parsed = this.parse<T>(key, cached);
      if (parsed !== null) return parsed;
    }

    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    const pending = (async (): Promise<T> => {
      const value = await factory();
      const payload =
        value === null || value === undefined
          ? options.cacheNull === true
            ? NULL_SENTINEL
            : null
          : JSON.stringify(value);

      if (payload !== null) {
        await this.redis.set(key, payload, 'EX', ttlSeconds).catch((error: unknown) => {
          this.logger.warn(`Cache write failed for ${key}: ${this.describe(error)}`);
          return null;
        });
      }
      return value;
    })().finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, pending);
    return pending;
  }

  private async readRaw(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch (error: unknown) {
      this.logger.warn(`Cache read failed for ${key}: ${this.describe(error)}`);
      return null;
    }
  }

  /** A poisoned entry (shape changed between deploys) is dropped, not thrown — treat it as a miss. */
  private parse<T>(key: string, raw: string): T | null {
    try {
      return JSON.parse(raw) as T;
    } catch {
      this.logger.warn(`Discarding unparseable cache entry at ${key}`);
      void this.redis.del(key).catch(() => 0);
      return null;
    }
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
