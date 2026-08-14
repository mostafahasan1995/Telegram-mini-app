/**
 * WHY Redis is a READINESS dependency and not merely a nice-to-have: without it there is no
 * distributed lock, so the Ichancy session cannot be refreshed safely and the per-player credit
 * mutex cannot be held. A process in that state must not receive traffic — it would either stall
 * or, worse, run money operations without the mutex that makes balance-delta verification valid.
 */
import { Injectable } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import { RedisService } from '../../cache/redis.service';
import { withTimeout } from './database.indicator';

const PROBE_TIMEOUT_MS = 1_000;

@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly redis: RedisService,
    private readonly indicator: HealthIndicatorService,
  ) {}

  async isHealthy(key = 'redis'): Promise<HealthIndicatorResult> {
    const check = this.indicator.check(key);
    const startedAt = Date.now();

    try {
      // Typed as `string`, not the 'PONG' literal ioredis infers: a proxy (or a Redis-compatible
      // server) can answer something else, and narrowing to a literal would make the guard below
      // provably dead code that the linter then rejects.
      const pong: string = await withTimeout(this.redis.ping(), PROBE_TIMEOUT_MS, 'redis');
      if (pong !== 'PONG') throw new Error(`Unexpected PING reply: ${pong}`);
      return check.up({ responseTimeMs: Date.now() - startedAt });
    } catch (error: unknown) {
      return check.down({
        responseTimeMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
