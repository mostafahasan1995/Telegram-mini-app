/**
 * WHY extend ioredis' Redis instead of wrapping it: the lock service needs EVAL, the session nonce
 * needs SET NX PX, the dedupe path needs raw SETNX. A wrapper would either re-export forty methods
 * or expose `.client` and pretend to encapsulate something it does not. Subclassing gives every
 * consumer the full, correctly-typed command surface and one place to own the connection lifecycle.
 *
 * `maxRetriesPerRequest: null` is deliberate and NOT copied from the BullMQ docs by accident: with
 * ioredis' default of 20, a command issued during a failover rejects after ~20 retries. For a lock
 * release that means we throw while still holding the lock, and a per-player credit mutex would
 * stay stuck until its TTL expires. Blocking until the connection recovers is the safer failure.
 */
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppConfigService } from '../config/config.service';

@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(config: AppConfigService) {
    super(config.redis.url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      // Distinguishes our connections in `CLIENT LIST` when debugging a stuck lock in production.
      connectionName: `ichancy-cashier:${config.app.role}`,
      retryStrategy: (times: number): number => Math.min(times * 200, 5_000),
    });

    this.on('error', (error: Error) => {
      // ioredis emits 'error' on every reconnect attempt; without a listener Node treats it as an
      // unhandled 'error' event and kills the process during a routine Redis restart.
      this.logger.error(`Redis connection error: ${error.message}`);
    });

    this.on('ready', () => this.logger.log('Redis connection ready'));
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.quit();
    } catch {
      // Already closed or the socket is gone — nothing left to clean up.
      this.disconnect();
    }
  }
}
