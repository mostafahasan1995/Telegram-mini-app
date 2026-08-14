/**
 * WHY a port for four Redis calls: "two processes signed in at once" is not something a test with a
 * mocked-away Redis can catch, so the locking behaviour has to be runnable in memory. Everything
 * else here is deliberately thin — the real connection (RedisService) and the compare-and-delete
 * lock (LockService) are owned by @core/cache, and duplicating either would give us a second Redis
 * connection and a second, unaudited copy of the release script.
 */
import { Injectable } from '@nestjs/common';
import { LockService } from '@core/cache/lock.service';
import { RedisService } from '@core/cache/redis.service';

export const ICHANCY_SESSION_STORE = 'ICHANCY_SESSION_STORE';

export interface IchancySessionStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string, ttlMs?: number): Promise<void>;
  remove(key: string): Promise<void>;
  /** SET key <token> NX PX ttlMs. Returns the fencing token, or null when someone else holds it. */
  acquireLock(key: string, ttlMs: number): Promise<string | null>;
  /** Compare-and-delete: a stalled holder must never free the next owner's lock. */
  releaseLock(key: string, token: string): Promise<void>;
}

@Injectable()
export class RedisIchancySessionStore implements IchancySessionStore {
  constructor(
    private readonly redis: RedisService,
    private readonly locks: LockService,
  ) {}

  async read(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async write(key: string, value: string, ttlMs?: number): Promise<void> {
    if (ttlMs !== undefined && ttlMs > 0) {
      await this.redis.set(key, value, 'PX', ttlMs);
      return;
    }
    await this.redis.set(key, value);
  }

  async remove(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async acquireLock(key: string, ttlMs: number): Promise<string | null> {
    // retries: 0 — the session service runs its own wait loop, because a loser must poll for the
    // WINNER'S token rather than queue up to refresh a second time (a second refresh kills the first).
    const handle = await this.locks.acquire(key, ttlMs);
    return handle?.token ?? null;
  }

  async releaseLock(key: string, token: string): Promise<void> {
    await this.locks.release({ key, token, acquiredAt: Date.now(), ttlMs: 0 });
  }
}

/** Deterministic in-memory store for unit tests. Not shared between processes. */
export class InMemoryIchancySessionStore implements IchancySessionStore {
  private readonly values = new Map<string, { value: string; expiresAt: number | null }>();
  private lockSequence = 0;

  private live(key: string): { value: string; expiresAt: number | null } | null {
    const entry = this.values.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return entry;
  }

  read(key: string): Promise<string | null> {
    return Promise.resolve(this.live(key)?.value ?? null);
  }

  write(key: string, value: string, ttlMs?: number): Promise<void> {
    this.values.set(key, {
      value,
      expiresAt: ttlMs !== undefined && ttlMs > 0 ? Date.now() + ttlMs : null,
    });
    return Promise.resolve();
  }

  remove(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }

  acquireLock(key: string, ttlMs: number): Promise<string | null> {
    if (this.live(key) !== null) return Promise.resolve(null);
    this.lockSequence += 1;
    const token = `lock-${String(this.lockSequence)}`;
    this.values.set(key, { value: token, expiresAt: Date.now() + ttlMs });
    return Promise.resolve(token);
  }

  releaseLock(key: string, token: string): Promise<void> {
    if (this.live(key)?.value === token) this.values.delete(key);
    return Promise.resolve();
  }
}
