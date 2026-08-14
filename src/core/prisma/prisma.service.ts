/**
 * WHY this file looks the way it does:
 *
 *  1. The pool is OURS. `@prisma/adapter-pg` means Prisma no longer owns the connection, so
 *     DB_POOL_MAX, timeouts, TLS and the schema have to be translated from DATABASE_URL by hand
 *     (pool-config.util.ts) and the pool has to be closed by hand on shutdown.
 *  2. The constructor returns `this.$extends(...)`. A Prisma extension cannot be applied in place,
 *     and exposing the extended client as a second property would create two ways to write to the
 *     database — one of them unstamped. Returning the extended proxy from the constructor keeps
 *     exactly ONE object: it still answers to every PrismaClient method, still runs
 *     onModuleInit/onModuleDestroy, and every model call (including inside `$transaction`) goes
 *     through the actor stamping extension.
 *  3. `runInTransaction` exists so that services do not each re-invent serialization retries. It is
 *     the only place that combines `$transaction` with `withSerializationRetry`.
 *
 * HARD RULE, not enforceable by types: nothing inside a transaction callback may do third-party IO.
 * The transaction can be replayed by the retry helper; a replayed Ichancy POST is a double credit.
 */
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import { AppConfigService } from '@core/config/config.service';

import { actorStampExtension } from './actor-stamp.extension';
import { buildPoolConfig } from './pool-config.util';
import { withSerializationRetry, type SerializationRetryOptions } from './retry.util';
import type { Tx } from './tx.type';

export interface RunInTransactionOptions {
  /** Milliseconds a transaction may wait for a free connection. */
  maxWait?: number;
  /** Milliseconds a transaction may stay open before Prisma rolls it back. */
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
  /** Serialization/deadlock retry budget, including the first attempt. */
  attempts?: number;
  onRetry?: SerializationRetryOptions['onRetry'];
}

/** Money transactions do several inserts plus a deferred constraint trigger; 5s is too tight. */
const DEFAULT_TRANSACTION_TIMEOUT_MS = 15_000;
const DEFAULT_TRANSACTION_MAX_WAIT_MS = 5_000;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger: Logger;
  private readonly pool: Pool;
  private readonly redactedUrl: string;
  private readonly poolMax: number;
  /** The schema the adapter was told about; handy for raw SQL and health checks. */
  readonly schema: string;
  private poolClosed = false;

  constructor(config: AppConfigService) {
    const logger = new Logger(PrismaService.name);
    const parsed = buildPoolConfig(config.db.url, {
      max: config.db.poolMax,
      // Two roles share one database; pg_stat_activity has to be able to tell them apart.
      applicationName: `ichancy-${config.app.role}`,
    });

    const pool = new Pool(parsed.pool);
    // WHY: pg emits 'error' on IDLE clients (server restart, NAT timeout). With no listener, Node
    // treats it as an unhandled 'error' event and kills the process.
    pool.on('error', (error: Error) => {
      logger.error(`Idle pg client error: ${error.message}`, error.stack);
    });

    super({
      adapter: new PrismaPg(pool, {
        schema: parsed.schema,
        // We created the pool, so we end it — see onModuleDestroy.
        disposeExternalPool: false,
      }),
      log: config.app.isProduction ? ['error'] : ['warn', 'error'],
      errorFormat: config.app.isProduction ? 'minimal' : 'pretty',
      transactionOptions: {
        maxWait: DEFAULT_TRANSACTION_MAX_WAIT_MS,
        timeout: DEFAULT_TRANSACTION_TIMEOUT_MS,
      },
    });

    this.logger = logger;
    this.pool = pool;
    this.schema = parsed.schema;
    this.redactedUrl = parsed.redactedUrl;
    this.poolMax = parsed.pool.max ?? config.db.poolMax;

    // See the header: this is what makes actor stamping unavoidable rather than optional.
    return this.$extends(actorStampExtension) as unknown as PrismaService;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log(
      `Connected to ${this.redactedUrl} (schema=${this.schema}, pool max=${this.poolMax})`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    if (!this.poolClosed) {
      this.poolClosed = true;
      await this.pool.end();
    }
  }

  /**
   * The transaction entry point for every service that writes money.
   * `fn` MUST be replayable: it can run more than once when Postgres reports a write conflict.
   */
  runInTransaction<T>(
    fn: (tx: Tx) => Promise<T>,
    options: RunInTransactionOptions = {},
  ): Promise<T> {
    const { attempts, onRetry, ...prismaOptions } = options;

    return withSerializationRetry(() => this.$transaction((tx) => fn(tx), prismaOptions), {
      ...(attempts !== undefined ? { attempts } : {}),
      onRetry:
        onRetry ??
        (({ attempt, delayMs }) => {
          this.logger.warn(
            `Transaction hit a write conflict (attempt ${attempt}); retrying in ${delayMs}ms`,
          );
        }),
    });
  }

  /** Cheapest possible liveness probe; used by the health check and by the worker on boot. */
  async ping(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.error(
        `Database ping failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return false;
    }
  }
}
