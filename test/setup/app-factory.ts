/**
 * Boots the REAL api — AppModule, the real middleware stack, the real global pipes/filters — against
 * a throwaway PostgreSQL 17 and Redis 7.
 *
 * WHY it calls `configureApiApp` from src/main.ts instead of re-listing the middleware here: an e2e
 * suite that assembles its own approximation of the stack is testing a server that does not exist.
 * It would pass while production rejects every proof upload on a body-size limit, or while a
 * `forbidNonWhitelisted` difference makes a request valid here and a 400 there. There is one
 * definition of "this api", and both callers use it.
 *
 * TWO THINGS ARE STUBBED, AND ONLY TWO:
 *  - the Ichancy port, by env (`ICHANCY_FAKE=1`), because the alternative is a test that moves
 *    real money;
 *  - the grammY Bot, whose factory otherwise calls getMe() against api.telegram.org on every boot.
 *    In the api role that failure is only a warning, so the suite would still work — it would just
 *    pay a network timeout per boot and be red when a laptop is offline.
 * Everything else is the production object: real Prisma, real Redis, real BullMQ producers, real
 * ledger triggers, real guards.
 */
import type { Server } from 'node:http';

import { Test, type TestingModule } from '@nestjs/testing';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { Bot } from 'grammy';
import { type UserFromGetMe } from 'grammy/types';

import { applyTestEnv, type TestEnvOverrides } from './test-env';
import { startPostgres, type PostgresHandle } from './postgres-container';
import { startRedis, type RedisHandle } from './redis-container';
import { truncateAll } from './truncate';

export interface CreateTestAppOptions {
  /** Extra environment applied after the defaults and before the graph is built. */
  env?: TestEnvOverrides;
  /**
   * Seed currency + payment methods + ledger accounts after boot and after every `reset()`.
   * On by default: almost every flow needs a currency and a rail to exist, and using the real seed
   * means the fixtures cannot drift from what a fresh install actually contains.
   */
  seed?: boolean;
  /** Hook for `.overrideProvider(...)` calls a suite needs. Return the same builder. */
  customize?: (builder: ReturnType<typeof Test.createTestingModule>) => void;
}

export interface TestApp {
  app: NestExpressApplication;
  moduleRef: TestingModule;
  /** Pass to supertest: `request(ctx.httpServer).post('/v1/deposits')`. */
  httpServer: Server;
  postgres: PostgresHandle;
  redis: RedisHandle;
  /** Truncate + flush Redis + reset the fake Ichancy + re-seed. Call between tests. */
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Offline stand-in for getMe(). EXPORTED so every suite that overrides TELEGRAM_BOT uses this one
 * object: grammY's `UserFromGetMe` gains required fields between versions, and a second copy of
 * this literal is a compile error waiting to happen in whichever file gets forgotten.
 */
export const TEST_BOT_INFO: UserFromGetMe = {
  id: 123_456_789,
  is_bot: true,
  first_name: 'Ichancy Cashier Test',
  username: 'ichancy_cashier_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

/** The overridden Bot itself, so a suite that builds its own TestingModule matches the factory. */
export function createTestBot(): Bot {
  return new Bot(process.env.TELEGRAM_BOT_TOKEN ?? '1:x', { botInfo: TEST_BOT_INFO });
}

export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestApp> {
  const shouldSeed = options.seed ?? true;

  const [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);

  applyTestEnv({ DATABASE_URL: postgres.url, REDIS_URL: redis.url, ...options.env });

  // Imported AFTER the environment exists. Static imports would run at file load, which is before
  // any test has had a chance to point DATABASE_URL at the container we just started.
  const { AppModule } = await import('../../src/app.module');
  const { configureApiApp, API_APP_OPTIONS } = await import('../../src/main');
  const { AppConfigService } = await import('@core/config/config.service');
  const { TELEGRAM_BOT } = await import('@core/telegram/telegram.constants');

  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TELEGRAM_BOT)
    .useValue(createTestBot());

  options.customize?.(builder);

  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    // The SAME options bootstrapApi() uses — `bodyParser: false` in particular, without which this
    // app would get Express' 100 KB default and the proof route would behave differently here than
    // in production.
    ...API_APP_OPTIONS,
    // Nest's own boot chatter drowns out test output; failures still surface as thrown errors.
    logger: false,
  });

  configureApiApp(app, app.get(AppConfigService));
  await app.init();

  const runSeeds = async (): Promise<void> => {
    if (!shouldSeed) return;
    const { PrismaService } = await import('@core/prisma/prisma.service');
    const { seedCurrency } = await import('../../prisma/seed/currency.seed');
    const { seedPaymentMethods } = await import('../../prisma/seed/payment-method.seed');
    const { seedLedgerAccounts } = await import('../../prisma/seed/ledger-account.seed');

    const prisma = app.get(PrismaService);
    const currency = await seedCurrency(prisma);
    const methods = await seedPaymentMethods(prisma, currency.code);
    await seedLedgerAccounts(prisma, {
      currencyCode: currency.code,
      paymentMethodIds: methods.map((method) => method.id),
    });
  };

  await runSeeds();

  return {
    app,
    moduleRef,
    httpServer: app.getHttpServer(),
    postgres,
    redis,
    reset: async (): Promise<void> => {
      // Order matters: clearing Redis first means no lock or cached balance can outlive the rows
      // it described.
      await redis.flush();
      await truncateAll(postgres.url);
      const { FakeIchancyAdapter } = await import('@core/ichancy/fake-ichancy.adapter');
      app.get(FakeIchancyAdapter).reset();
      await runSeeds();
    },
    close: async (): Promise<void> => {
      // Closes the pg pool, quits Redis and drains BullMQ through the modules' lifecycle hooks.
      await app.close();
    },
  };
}
