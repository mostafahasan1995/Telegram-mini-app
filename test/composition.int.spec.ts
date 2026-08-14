/**
 * Does the thing actually boot, and does the wiring do what the wiring claims?
 *
 * Composition bugs are the ones unit tests structurally cannot catch: a provider that only fails to
 * resolve when the whole graph is built, a body-size cap that only bites on the one route that
 * needs a big body, a guard that is registered but never reached, a rate limit whose route moved.
 * Every assertion here is one of those.
 *
 * Requires Docker (testcontainers).  npm run test:int
 */
import request from 'supertest';
import { Test } from '@nestjs/testing';

import { createTestApp, createTestBot, type TestApp } from './setup/app-factory';
import { startPostgres, stopPostgres } from './setup/postgres-container';
import { startRedis, stopRedis } from './setup/redis-container';
import { applyTestEnv } from './setup/test-env';
import { THROTTLE_RULES, findUnmatchedRules } from '@core/throttler/throttle-routes';
import { TELEGRAM_BOT } from '@core/telegram/telegram.constants';
import { OUTBOX_HANDLERS, type OutboxTopicHandler } from '@core/outbox/outbox.types';

jest.setTimeout(180_000);

describe('api composition', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    // Throttle counters live in Redis; without this the 30 requests one test makes would still be
    // counted when the next one runs.
    await ctx.redis.flush();
  });

  describe('it boots and serves', () => {
    it('answers liveness without touching a dependency', async () => {
      const response = await request(ctx.httpServer).get('/health/live').expect(200);
      expect(response.body).toMatchObject({ success: true, data: { status: 'ok', role: 'api' } });
    });

    it('answers readiness green with a real database and Redis behind it', async () => {
      const response = await request(ctx.httpServer).get('/health/ready').expect(200);
      expect(response.body.data.status).toBe('ok');
    });

    it('serves the feature routes at /v1 exactly once (no double prefix)', async () => {
      // If setGlobalPrefix('v1') were applied on top of @Controller('v1/...'), this would 404 and
      // /v1/v1/payment-methods would be the real path.
      await request(ctx.httpServer).get('/v1/payment-methods').expect(401);
      await request(ctx.httpServer).get('/v1/v1/payment-methods').expect(404);
    });
  });

  describe('global guards', () => {
    it('fails closed: a protected route without a token is 401, not 200', async () => {
      const response = await request(ctx.httpServer).get('/v1/me').expect(401);
      expect(response.body).toMatchObject({ success: false, error: { code: expect.any(String) } });
    });

    it('rejects a garbage bearer token rather than ignoring it', async () => {
      await request(ctx.httpServer)
        .get('/v1/me')
        .set('authorization', 'Bearer not-a-jwt')
        .expect(401);
    });
  });

  describe('correlation id', () => {
    it('echoes one on every response, including errors', async () => {
      const response = await request(ctx.httpServer).get('/v1/me').expect(401);
      const header = response.headers['x-correlation-id'];
      expect(header).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
      // The envelope and the header must agree, or a screenshot is useless for finding the request.
      expect(response.body.meta.correlationId).toBe(header);
    });

    it('reuses a sane upstream id so a trace survives the edge', async () => {
      const upstream = 'trace-from-the-gateway-123';
      const response = await request(ctx.httpServer)
        .get('/health/live')
        .set('x-correlation-id', upstream)
        .expect(200);

      expect(response.headers['x-correlation-id']).toBe(upstream);
      expect(response.body.meta.correlationId).toBe(upstream);
    });
  });

  describe('body size caps', () => {
    // ~1 MB, comfortably over the 512kb default and far under the proof cap.
    const oneMegabyte = 'a'.repeat(1_000_000);

    it('accepts a multi-megabyte body on the proof route', async () => {
      // 401 (unauthenticated) is the CORRECT answer here. What matters is that it is not 413:
      // express' 100kb default would reject every real proof upload before validation ever ran.
      const response = await request(ctx.httpServer)
        .post('/v1/deposits/01ARZ3NDEK/proof')
        .send({ imageBase64: oneMegabyte });

      expect(response.status).not.toBe(413);
      expect(response.status).toBe(401);
    });

    it('still caps every other route, so the big limit is targeted and not global', async () => {
      const response = await request(ctx.httpServer)
        .post('/v1/deposits')
        .send({ note: oneMegabyte });

      expect(response.status).toBe(413);
      // Not INTERNAL_ERROR: body-parser's http-errors object is not an HttpException, so without
      // the translating error middleware the filter reports "the server broke" for a client fault
      // — a 500 in the logs and an alert nobody can act on.
      expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('reports malformed JSON as a 400, not as our internal error', async () => {
      const response = await request(ctx.httpServer)
        .post('/v1/auth/telegram')
        .set('content-type', 'application/json')
        .send('{"initData": ');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('BAD_REQUEST');
    });
  });

  describe('rate limiting', () => {
    it('every rule matches a route that actually exists', async () => {
      // The boot-time self-check in main.ts logs this; here it is an assertion, so a controller
      // path change turns a silently-disabled limit into a red test.
      const { SwaggerModule, DocumentBuilder } = await import('@nestjs/swagger');
      const document = SwaggerModule.createDocument(
        ctx.app,
        new DocumentBuilder().setTitle('routes').setVersion('test').build(),
      );

      const routes = Object.entries(document.paths).flatMap(([path, item]) =>
        Object.keys(item as Record<string, unknown>).map((method) => ({ method, path })),
      );

      expect(findUnmatchedRules(routes)).toEqual([]);
    });

    it('lets the auth exchange through up to its limit, then answers 429', async () => {
      const rule = THROTTLE_RULES.find((candidate) => candidate.name === 'auth-exchange');
      expect(rule).toBeDefined();
      const limit = rule?.limit ?? 0;

      const statuses: number[] = [];
      // Sequential on purpose: a burst would race the counter and make "the Nth is the one that
      // trips" untrue for reasons that have nothing to do with the limiter being correct.
      for (let i = 0; i < limit + 1; i += 1) {
        const response = await request(ctx.httpServer)
          .post('/v1/auth/telegram')
          .send({ initData: 'not-a-valid-signature' });
        statuses.push(response.status);
      }

      expect(statuses.slice(0, limit).every((status) => status !== 429)).toBe(true);
      expect(statuses[limit]).toBe(429);
    });

    it('does NOT throttle reads', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 40; i += 1) {
        const response = await request(ctx.httpServer).get('/health/live');
        statuses.push(response.status);
      }
      expect(statuses.every((status) => status === 200)).toBe(true);
    });
  });

  describe('CORS', () => {
    it('allows a configured mini-app origin', async () => {
      const response = await request(ctx.httpServer)
        .get('/health/live')
        .set('Origin', process.env.MINI_APP_ORIGIN ?? '')
        .expect(200);
      expect(response.headers['access-control-allow-origin']).toBe(process.env.MINI_APP_ORIGIN);
    });

    it('omits the header for an origin that is not on the allow-list', async () => {
      const response = await request(ctx.httpServer)
        .get('/health/live')
        .set('Origin', 'https://evil.example.com')
        .expect(200);
      // No header rather than a 500: the browser blocks it and the server stays quiet.
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('security headers', () => {
    it('never sends X-Frame-Options (it would break the Telegram WebView)', async () => {
      const response = await request(ctx.httpServer).get('/health/live').expect(200);
      expect(response.headers['x-frame-options']).toBeUndefined();
    });

    it('expresses the same intent with CSP frame-ancestors, including Telegram', async () => {
      const response = await request(ctx.httpServer).get('/health/live').expect(200);
      const csp = response.headers['content-security-policy'] ?? '';
      expect(csp).toContain('frame-ancestors');
      expect(csp).toContain('https://web.telegram.org');
    });
  });

  describe('test harness', () => {
    it('resets even the append-only tables, which refuse TRUNCATE for everyone', async () => {
      // Every future integration suite depends on reset() working. `audit_logs` has a BEFORE
      // TRUNCATE trigger that raises for the owner and superuser alike, so the ordinary
      // "TRUNCATE ... CASCADE" reset every other project uses fails here — this proves the
      // disable/truncate/re-enable dance actually clears it AND puts the protection back.
      const { PrismaService } = await import('@core/prisma/prisma.service');
      const prisma = ctx.app.get(PrismaService);

      await prisma.auditLog.create({
        data: {
          actorType: 'SYSTEM',
          action: 'test.harness.probe',
          entityType: 'Test',
          entityId: 'harness',
        },
      });
      expect(await prisma.auditLog.count()).toBeGreaterThan(0);

      await ctx.reset();

      expect(await prisma.auditLog.count()).toBe(0);

      // The trigger must be armed again, or every later test would run against an unprotected
      // ledger and the append-only guarantee would be tested by nothing.
      const rearmed = await prisma.auditLog.create({
        data: {
          actorType: 'SYSTEM',
          action: 'test.harness.probe2',
          entityType: 'Test',
          entityId: 'harness',
        },
      });
      await expect(
        prisma.auditLog.update({ where: { id: rearmed.id }, data: { action: 'tampered' } }),
      ).rejects.toThrow(/APPEND_ONLY_VIOLATION/);
    });

    it('re-seeds the baseline so the next test starts from a fresh install', async () => {
      const { PrismaService } = await import('@core/prisma/prisma.service');
      const prisma = ctx.app.get(PrismaService);

      await ctx.reset();

      expect(await prisma.currency.count()).toBe(1);
      expect(await prisma.paymentMethod.count()).toBe(2);
      // 2 singletons (agent float, rounding) + 3 per rail.
      expect(await prisma.ledgerAccount.count()).toBe(8);
    });
  });

  describe('validation pipe', () => {
    it('rejects an unknown property instead of silently dropping it', async () => {
      // whitelist alone would drop `amountt` and act on the default — on a money endpoint a typo
      // must be an error.
      const response = await request(ctx.httpServer)
        .post('/v1/auth/telegram')
        .send({ initData: 'x', unexpectedField: 'y' });
      expect(response.status).toBe(400);
    });
  });
});

describe('worker composition', () => {
  const previousRole = process.env.APP_ROLE;

  afterAll(async () => {
    process.env.APP_ROLE = previousRole;
    await stopPostgres();
    await stopRedis();
  });

  it('resolves the whole worker graph, including the consumers the api leaves out', async () => {
    const [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);

    // @nestjs/config validates inside `ConfigModule.forRoot()`, which runs when config.module.ts is
    // EVALUATED — not when the module is instantiated. So the environment has to be complete before
    // the import below, which is also why every module import in this file is dynamic.
    applyTestEnv({ DATABASE_URL: postgres.url, REDIS_URL: redis.url, APP_ROLE: 'worker' });
    process.env.APP_ROLE = 'worker';

    const { WorkerModule } = await import('../src/worker.module');
    const { TelegramUpdateProcessor } =
      await import('@core/telegram/processors/telegram-update.processor');
    const { WorkerBootstrapService } = await import('../src/worker-bootstrap.service');
    const { OutboxDispatchProcessor } = await import('@core/outbox/outbox-dispatch.processor');

    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(TELEGRAM_BOT)
      // Without this the worker-role bot factory throws at boot: it hard-fails when getMe() cannot
      // be resolved, because a worker that cannot match commands would mis-handle every one.
      .useValue(createTestBot())
      .compile();

    try {
      // The consumer that did not exist before this composition: without it every Telegram update
      // is persisted, enqueued and never handled.
      expect(moduleRef.get(TelegramUpdateProcessor)).toBeDefined();
      // The single consumer of the outbox queue.
      expect(moduleRef.get(OutboxDispatchProcessor)).toBeDefined();
      expect(moduleRef.get(WorkerBootstrapService)).toBeDefined();

      // Nest does not merge providers across modules, so the root has to assemble this array.
      // An empty one means every deposit side-effect lands on the dead-letter queue.
      const handlers = moduleRef.get<OutboxTopicHandler[]>(OUTBOX_HANDLERS);
      expect(handlers.length).toBeGreaterThan(0);
      expect(handlers.some((handler) => handler.topic.startsWith('deposit'))).toBe(true);
    } finally {
      await moduleRef.close();
    }
  });
});
