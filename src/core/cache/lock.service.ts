/**
 * WHY a hand-rolled lock and not a library: we need exactly two guarantees and both are subtle.
 *
 *  1. RELEASE MUST BE A COMPARE-AND-DELETE. `DEL key` is a bug: if the holder stalls past the TTL,
 *     the lock is handed to someone else, and the stalled holder's `DEL` then deletes the NEW
 *     owner's lock — two workers credit the same player concurrently and the balance-delta
 *     verification (which is our ONLY oracle, since Ichancy has no idempotency key) becomes
 *     meaningless. So release runs a Lua script that deletes only when the value still matches the
 *     random token minted at acquire time. Same for extend.
 *
 *  2. THE TTL IS A LIVENESS BOUND, NOT A CORRECTNESS ONE. A lock can always expire under a holder
 *     that is stuck in a network call. `withLock` therefore returns the fencing token, and callers
 *     doing money work must keep the lock alive with `extend()` across the verify window rather
 *     than assuming a long TTL is enough.
 *
 * This is a single-Redis lock, not Redlock. That is the correct trade here: our Redis is a single
 * primary, and Redlock's guarantees only matter across independent masters.
 */
import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ConflictError } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';
import { RedisService } from './redis.service';

/** Deletes the key only if it still holds our token. Returns 1 when it did. */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** Extends the TTL only if we still own the key. Returns 1 when it did. */
const EXTEND_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

export interface LockHandle {
  readonly key: string;
  /** Fencing token; proves ownership on release/extend. Never reuse one across acquisitions. */
  readonly token: string;
  readonly acquiredAt: number;
  readonly ttlMs: number;
}

export interface AcquireOptions {
  /** How many extra attempts after the first failure. 0 = fail fast (the right default for money). */
  retries?: number;
  /** Base delay between attempts; jittered to avoid a thundering herd on one hot key. */
  retryDelayMs?: number;
}

export class LockUnavailableError extends ConflictError {
  constructor(key: string) {
    super(
      CommonErrorCodes.LOCK_UNAVAILABLE,
      'This resource is being processed by another operation. Please retry shortly.',
      { key },
    );
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class LockService {
  private readonly logger = new Logger(LockService.name);

  constructor(private readonly redis: RedisService) {}

  /** `lock:ichancy:session`, `lock:player-credit:<playerId>:<epoch>` — one convention, one place. */
  static key(...parts: (string | number)[]): string {
    return ['lock', ...parts.map(String)].join(':');
  }

  /** Returns a handle, or null when someone else holds the lock. Never throws on contention. */
  async acquire(
    key: string,
    ttlMs: number,
    options: AcquireOptions = {},
  ): Promise<LockHandle | null> {
    const retries = options.retries ?? 0;
    const retryDelayMs = options.retryDelayMs ?? 100;
    const token = randomBytes(16).toString('hex');

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const result = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
      if (result === 'OK') {
        return { key, token, acquiredAt: Date.now(), ttlMs };
      }
      if (attempt < retries) {
        // Full jitter: two workers that collide must not retry in lockstep forever.
        await sleep(Math.floor(Math.random() * retryDelayMs) + retryDelayMs / 2);
      }
    }

    return null;
  }

  /** Compare-and-delete. `false` means the lock had already expired and possibly changed hands. */
  async release(handle: LockHandle): Promise<boolean> {
    const released = await this.redis.eval(RELEASE_SCRIPT, 1, handle.key, handle.token);
    if (released !== 1) {
      // Worth an explicit warning: it means the critical section outlived its TTL, so whatever it
      // protected may have run concurrently with another holder.
      this.logger.warn(
        `Lock ${handle.key} was no longer ours at release (held ${Date.now() - handle.acquiredAt}ms, ttl ${handle.ttlMs}ms)`,
      );
      return false;
    }
    return true;
  }

  /**
   * Push the expiry out while still working. Returns false if we already lost the lock — the caller
   * must then treat its critical section as compromised and stop, not carry on.
   */
  async extend(handle: LockHandle, ttlMs: number): Promise<boolean> {
    const extended = await this.redis.eval(EXTEND_SCRIPT, 1, handle.key, handle.token, ttlMs);
    return extended === 1;
  }

  /**
   * Run `fn` under the lock, always releasing it. Throws LockUnavailableError (409) on contention,
   * which the global filter renders as a retryable conflict rather than a 500.
   */
  async withLock<T>(
    key: string,
    ttlMs: number,
    fn: (handle: LockHandle) => Promise<T>,
    options: AcquireOptions = {},
  ): Promise<T> {
    const handle = await this.acquire(key, ttlMs, options);
    if (!handle) throw new LockUnavailableError(key);

    try {
      return await fn(handle);
    } finally {
      // Release failures must never mask the real error from `fn`.
      await this.release(handle).catch((error: unknown) => {
        this.logger.error(
          `Failed to release lock ${key}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      });
    }
  }

  /**
   * A one-shot marker that is never released — the primitive behind the initData replay nonce and
   * the Telegram update pre-check. Returns true the FIRST time only; the TTL is the replay window.
   */
  async claimOnce(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.set(key, '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  /**
   * Undo a claimOnce. Needed when the work that the claim guarded failed AFTER the claim was
   * taken — otherwise the retry is rejected as a duplicate and the work is lost forever.
   */
  async releaseClaim(key: string): Promise<void> {
    await this.redis.del(key);
  }
}
