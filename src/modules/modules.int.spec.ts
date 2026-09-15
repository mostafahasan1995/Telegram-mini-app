/**
 * Boots the three feature modules for real — real Postgres, real Redis, the fake Ichancy adapter —
 * and exercises the paths that unit tests structurally cannot reach.
 *
 * WHY this exists on top of 118 unit tests: every one of those constructs its subject with `new`.
 * None of them proves that Nest can BUILD these modules. A missing provider, a service that is
 * exported but not provided, or a token nobody binds are all invisible to `tsc` and to a unit test,
 * and they fail at boot in production. The DI graph is the thing most worth checking here.
 *
 * Postgres and Redis come from the shared harness (test/setup): throwaway containers under
 * `npm run test:int`, with the schema, prisma/sql and the baseline tenancy applied. The escape hatch
 * points it at a THROWAWAY database that already has the schema:
 *   POSTGRES_TEST_URL=... REDIS_TEST_URL=... npx jest --config jest-int.config.cjs \
 *     --runInBand src/modules/modules.int.spec.ts
 */
process.env['APP_ROLE'] = 'api';
process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '3000';
process.env['API_BASE_URL'] = 'http://localhost:3000';
// DATABASE_URL and REDIS_URL are NOT set here: they are the harness's addresses, applied in beforeAll
// before the graph is imported. No address is guessed, and a developer's DATABASE_URL is never used:
// localhost:55432 is also where a live cashier stack publishes Postgres on a developer machine.
process.env['JWT_SECRET'] = 'integration-test-secret-value-32-chars';
process.env['MINI_APP_ORIGIN'] = 'http://localhost:5173';
process.env['ICHANCY_BASE_URL'] = 'http://localhost:9';
process.env['ICHANCY_USERNAME'] = 'agent';
process.env['ICHANCY_PASSWORD'] = 'agent-password';
process.env['ICHANCY_AGENT_ID'] = 'AGENT-1';
process.env['ICHANCY_CURRENCY'] = 'NSP';
process.env['S3_ENDPOINT'] = 'http://localhost:9000';
process.env['S3_BUCKET'] = 'proofs';
process.env['S3_ACCESS_KEY'] = 'minio';
process.env['S3_SECRET_KEY'] = 'minio-secret';
process.env['DUAL_APPROVAL_THRESHOLD_MINOR'] = '100000';
process.env['DEPOSIT_EXPIRY_MINUTES'] = '60';
process.env['AGENT_FLOAT_LOW_WATERMARK_MINOR'] = '500000';
// Belt and braces: NODE_ENV=test already selects the fake, but no test may ever move real money.
process.env['ICHANCY_FAKE'] = '1';

import type { Server } from 'node:http';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';

// Type-only, so erased at file load. Every Nest module and service is imported by `loadGraph()`,
// after the harness has started: @nestjs/config validates the environment when config.module.ts is
// EVALUATED, so a static import would validate it before DATABASE_URL and REDIS_URL exist.
import type { PrismaService } from '@core/prisma/prisma.service';
import type { RedisService } from '@core/cache/redis.service';
import type { FakeIchancyAdapter } from '@core/ichancy/fake-ichancy.adapter';
// The leaf tenancy files, not the '@core/tenant' barrel, which also exports TenantModule and would
// evaluate a slice of the graph at file load (see test/setup/app-factory.ts).
import { TENANT_BOOTSTRAP_ID } from '@core/tenant/tenant.constants';
import { runWithTenant } from '@core/tenant/tenant.storage';
import { GlobalExceptionFilter } from '@common/filters/global-exception.filter';
import { TransformInterceptor } from '@common/interceptors/transform.interceptor';

import { applyTestEnv } from '../../test/setup/test-env';
import { startPostgres, stopPostgres } from '../../test/setup/postgres-container';
import { startRedis, stopRedis } from '../../test/setup/redis-container';

import { PLAYER_LINK_PORT, type PlayerLinkPort } from './player/player-link.port';
import { APPROVAL_LIMIT_PORT, type ApprovalLimitPort } from './admin/approval-limit.port';
import type { AdminUserService } from './admin/services/admin-user.service';
import { PAYMENT_METHOD_PORT, type PaymentMethodPort } from './payment-method/payment-method.port';

jest.setTimeout(60_000);

/** Starting the containers and pushing the schema on a cold runner; the int config's own default. */
const BOOT_TIMEOUT_MS = 120_000;

/** The graph under test, imported once the environment is complete. */
async function loadGraph() {
  const { AppConfigModule } = await import('@core/config/config.module');
  const { PrismaModule } = await import('@core/prisma/prisma.module');
  const { PrismaService } = await import('@core/prisma/prisma.service');
  const { CacheModule } = await import('@core/cache/cache.module');
  const { RedisService } = await import('@core/cache/redis.service');
  const { AuditModule } = await import('@core/audit/audit.module');
  const { LedgerModule } = await import('@core/ledger/ledger.module');
  const { FakeIchancyAdapter } = await import('@core/ichancy/fake-ichancy.adapter');
  const { TenantSecretService } = await import('@core/tenant/services/tenant-secret.service');

  const { PlayerModule } = await import('./player/player.module');
  const { PlayerLinkService } = await import('./player/services/player-link.service');
  const { PlayerService } = await import('./player/services/player.service');
  const { ReferralService } = await import('./player/services/referral.service');
  const { PlayerTelegramHandlers } = await import('./player/telegram/player.handlers');

  const { AdminModule } = await import('./admin/admin.module');
  const { AdminApprovalLimitService } = await import('./admin/services/admin-approval-limit.service');
  const { AdminUserService } = await import('./admin/services/admin-user.service');

  const { PaymentMethodModule } = await import('./payment-method/payment-method.module');
  const { PaymentMethodService } = await import('./payment-method/services/payment-method.service');
  const { PaymentDestinationService } =
    await import('./payment-method/services/payment-destination.service');
  const { DestinationPickerService } =
    await import('./payment-method/services/destination-picker.service');

  return {
    AppConfigModule,
    PrismaModule,
    PrismaService,
    CacheModule,
    RedisService,
    AuditModule,
    LedgerModule,
    FakeIchancyAdapter,
    TenantSecretService,
    PlayerModule,
    PlayerLinkService,
    PlayerService,
    ReferralService,
    PlayerTelegramHandlers,
    AdminModule,
    AdminApprovalLimitService,
    AdminUserService,
    PaymentMethodModule,
    PaymentMethodService,
    PaymentDestinationService,
    DestinationPickerService,
  };
}

type Graph = Awaited<ReturnType<typeof loadGraph>>;

const SUFFIX = Date.now().toString(36).toUpperCase().slice(-6);
const METHOD_CODE = `INT_TEST_${SUFFIX}`;
const TG_BASE = 900_000_000_000n + BigInt(Date.now() % 1_000_000);

/**
 * Telegram never issues ids this high, so everything at or above it belongs to this suite. TG_BASE
 * is derived from the clock and therefore differs per run — the floor is what lets one run find the
 * rows a PREVIOUS run left behind.
 */
const RESERVED_TG_FLOOR = 900_000_000_000n;

/**
 * Opens a tenant context around a test body.
 *
 * WHY anything that touches a service needs one: these services are request-path code and read
 * their operator from TenantContextStorage, which TenantContextMiddleware opens on a real request.
 * A test that reaches into the graph with `moduleRef.get(...)` has no middleware in front of it, so
 * the first `requireEffectiveTenantId()` would throw. This is the harness doing what the middleware
 * does, and it is the same move a worker makes with `runWithTenant()`.
 *
 * The bootstrap operator specifically: every row this suite writes and every seeded row it reads
 * belongs to it, and until phase 6 gives each operator its own bot it is the only one taking
 * deposits. `purgeLeftovers` deliberately runs OUTSIDE any context — it sweeps a SHARED database
 * for rows an interrupted run abandoned, whatever operator they landed in, and a tenant filter
 * there would leave them behind.
 *
 * The HTTP block is not wrapped: those requests go through the real pipeline and every one of them
 * is rejected by a guard or the validation pipe before a tenant-scoped service is reached.
 */
const inTenant = (body: () => Promise<void>) => (): Promise<void> =>
  runWithTenant(TENANT_BOOTSTRAP_ID, body);

const itInTenant = (name: string, body: () => Promise<void>): void => {
  it(name, inTenant(body));
};

/**
 * WHY a suite that cleans up in `afterAll` still has to clean up in `beforeAll`: with the escape
 * hatch this runs against a SHARED database, and an `afterAll` only runs if the process gets that
 * far. A crash, a timeout or a Ctrl-C leaves rows behind, and one of them is fatal rather than merely
 * untidy — `FakeIchancyAdapter` numbers players from a counter that `reset()` puts back to zero, so
 * every run registers `fake-player-000001` into a UNIQUE column. Without this purge, one interrupted
 * run makes every subsequent run fail on a unique-constraint violation until somebody truncates by
 * hand.
 *
 * Deletes are in FK order (the player FKs are RESTRICT, not CASCADE) and scoped to the two
 * namespaces this suite owns: the reserved Telegram id band, and the `INT_TEST_` method prefix.
 * `audit_logs` is absent on purpose — see the note in `afterAll`.
 */
async function purgeLeftovers(db: PrismaService): Promise<void> {
  const stalePlayers = await db.player.findMany({
    where: {
      OR: [
        { telegramUserId: { gte: RESERVED_TG_FLOOR } },
        { ichancyPlayerId: { startsWith: 'fake-player-' } },
      ],
    },
    select: { id: true },
  });
  const playerIds = stalePlayers.map((row) => row.id);

  if (playerIds.length > 0) {
    const scope = { where: { playerId: { in: playerIds } } };
    await db.playerLimit.deleteMany(scope);
    await db.selfExclusion.deleteMany(scope);
    await db.ichancyCall.deleteMany(scope);
    await db.playerSession.deleteMany(scope);
    await db.reconciliationBreak.deleteMany(scope);
    await db.depositRequest.deleteMany(scope);
    await db.ledgerAccount.deleteMany(scope);
    await db.player.deleteMany({ where: { id: { in: playerIds } } });
  }

  const staleAdmins = await db.adminUser.findMany({
    where: { telegramUserId: { gte: RESERVED_TG_FLOOR } },
    select: { id: true },
  });
  const adminIds = staleAdmins.map((row) => row.id);

  if (adminIds.length > 0) {
    await db.adminApprovalLimit.deleteMany({ where: { adminUserId: { in: adminIds } } });
    await db.adminUser.deleteMany({ where: { id: { in: adminIds } } });
  }

  const staleMethods = await db.paymentMethod.findMany({
    where: { code: { startsWith: 'INT_TEST_' } },
    select: { id: true },
  });
  const methodIds = staleMethods.map((row) => row.id);

  if (methodIds.length > 0) {
    await db.paymentDestination.deleteMany({ where: { paymentMethodId: { in: methodIds } } });
    await db.ledgerAccount.deleteMany({ where: { paymentMethodId: { in: methodIds } } });
    await db.paymentMethod.deleteMany({ where: { id: { in: methodIds } } });
  }
}

describe('feature modules (integration)', () => {
  let graph: Graph;
  let moduleRef: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let fakeIchancy: FakeIchancyAdapter;
  /** The bootstrap operator's Ichancy columns as this suite found them, restored in afterAll. */
  let bootstrapAgentBefore: {
    ichancyBaseUrl: string;
    ichancyUsername: string;
    ichancyPasswordEnc: string;
    ichancyAgentId: string;
  } | null = null;

  const createdPlayerIds: string[] = [];
  const createdAdminIds: string[] = [];
  let methodId: string | null = null;
  const destinationIds: string[] = [];

  beforeAll(async () => {
    const [postgres, redisHandle] = await Promise.all([startPostgres(), startRedis()]);
    // The values above stay as this suite set them. The addresses are the harness's, and any other
    // variable the schema requires comes from the shared test defaults: CI has no .env to fill a gap.
    applyTestEnv({ DATABASE_URL: postgres.url, REDIS_URL: redisHandle.url });
    graph = await loadGraph();

    moduleRef = await Test.createTestingModule({
      imports: [
        graph.AppConfigModule,
        graph.PrismaModule,
        graph.CacheModule,
        graph.AuditModule,
        // @Global, and imported by app.module and worker.module rather than by the features, so the
        // harness has to stand in for the root here too: ActivityReportService (AdminModule) reads
        // the float through AccountRegistryService and cannot be built without it.
        graph.LedgerModule,
        graph.PlayerModule,
        graph.AdminModule,
        graph.PaymentMethodModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalInterceptors(new TransformInterceptor());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();

    prisma = moduleRef.get(graph.PrismaService);
    redis = moduleRef.get(graph.RedisService);
    fakeIchancy = moduleRef.get(graph.FakeIchancyAdapter);
    fakeIchancy.reset();

    await purgeLeftovers(prisma);

    // Every Ichancy call, the fake's included, is made with the operator's own agent from its tenant
    // row, and an operator whose row holds no usable agent is refused before anything is sent. A
    // shared test database's bootstrap row may carry a placeholder or a password sealed under another
    // root secret, so this suite gives it a real one for its own run and puts the original back.
    bootstrapAgentBefore = await prisma.tenant.findUniqueOrThrow({
      where: { id: TENANT_BOOTSTRAP_ID },
      select: {
        ichancyBaseUrl: true,
        ichancyUsername: true,
        ichancyPasswordEnc: true,
        ichancyAgentId: true,
      },
    });
    await prisma.tenant.update({
      where: { id: TENANT_BOOTSTRAP_ID },
      data: {
        ichancyBaseUrl: 'http://localhost:9',
        ichancyUsername: 'modules-int-agent',
        ichancyPasswordEnc: moduleRef
          .get(graph.TenantSecretService)
          .sealIchancyPassword('modules-int-agent-password'),
        ichancyAgentId: '4242',
      },
    });
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    // WHY try/finally: this suite cleans up against what may be a SHARED database, so any statement
    // below can fail (a constraint, a row another suite already removed). If that throw escapes,
    // `app.close()` never runs and the pg pool plus the ioredis connection leak — Jest then reports
    // every test as passed and hangs forever instead of exiting. Closing the app is the one step that
    // must happen, and the containers are stopped only once nothing is connected to them.
    try {
      // Clean up in FK order. Everything here is namespaced by SUFFIX/TG_BASE.
      //
      // `audit_logs` is deliberately NOT deleted. prisma/sql/002_immutability.sql installs a BEFORE
      // DELETE trigger that raises APPEND_ONLY_VIOLATION for everyone, owner included, because "we
      // never rewrite the audit trail" is worthless if a privileged session can. A DELETE here only
      // appeared to work against a dev database that had the tables but none of the guard SQL. The
      // rows are harmless: `entityId` is not a foreign key, and every id this suite writes is
      // namespaced by a per-run SUFFIX, so nothing it asserts can see a previous run's rows.
      if (prisma !== undefined) {
        await prisma.adminApprovalLimit.deleteMany({
          where: { adminUserId: { in: createdAdminIds } },
        });
        await prisma.paymentDestination.deleteMany({ where: { id: { in: destinationIds } } });
        if (methodId !== null) await prisma.paymentMethod.deleteMany({ where: { id: methodId } });
        await prisma.player.deleteMany({ where: { id: { in: createdPlayerIds } } });
        await prisma.adminUser.deleteMany({ where: { id: { in: createdAdminIds } } });
        if (bootstrapAgentBefore !== null) {
          await prisma.tenant.update({ where: { id: TENANT_BOOTSTRAP_ID }, data: bootstrapAgentBefore });
        }
      }
      if (redis !== undefined) {
        const keys = await redis.keys(`paydest:*${SUFFIX}*`);
        if (keys.length > 0) await redis.del(...keys);
      }
    } finally {
      try {
        await app?.close();
      } finally {
        await Promise.all([stopPostgres(), stopRedis()]);
      }
    }
  });

  // ---------------------------------------------------------------------------

  describe('dependency injection graph', () => {
    it('resolves every provider the three modules export', () => {
      // The check `tsc` cannot do: a service listed in `exports` but missing from `providers`
      // compiles perfectly and throws only when Nest builds the graph.
      expect(moduleRef.get(graph.PlayerService)).toBeInstanceOf(graph.PlayerService);
      expect(moduleRef.get(graph.PlayerLinkService)).toBeInstanceOf(graph.PlayerLinkService);
      expect(moduleRef.get(graph.ReferralService)).toBeInstanceOf(graph.ReferralService);
      expect(moduleRef.get(graph.PlayerTelegramHandlers)).toBeInstanceOf(
        graph.PlayerTelegramHandlers,
      );
      expect(moduleRef.get(graph.AdminUserService)).toBeInstanceOf(graph.AdminUserService);
      expect(moduleRef.get(graph.AdminApprovalLimitService)).toBeInstanceOf(
        graph.AdminApprovalLimitService,
      );
      expect(moduleRef.get(graph.PaymentMethodService)).toBeInstanceOf(graph.PaymentMethodService);
      expect(moduleRef.get(graph.PaymentDestinationService)).toBeInstanceOf(
        graph.PaymentDestinationService,
      );
      expect(moduleRef.get(graph.DestinationPickerService)).toBeInstanceOf(
        graph.DestinationPickerService,
      );
    });

    it('binds the three cross-module string tokens to real implementations', () => {
      // These tokens are how other modules reach this code WITHOUT importing it (boundaries rule).
      // A typo in a token is invisible to the compiler and fatal at runtime.
      const link = moduleRef.get<PlayerLinkPort>(PLAYER_LINK_PORT);
      const limits = moduleRef.get<ApprovalLimitPort>(APPROVAL_LIMIT_PORT);
      const payments = moduleRef.get<PaymentMethodPort>(PAYMENT_METHOD_PORT);

      expect(typeof link.ensureLinked).toBe('function');
      expect(typeof limits.evaluate).toBe('function');
      expect(typeof payments.pickDestination).toBe('function');
      // useExisting, not useClass: the port and the service must be the SAME instance, or the
      // per-player lock inside PlayerLinkService would be held by one of two objects.
      expect(link).toBe(moduleRef.get(graph.PlayerLinkService));
    });
  });

  // ---------------------------------------------------------------------------

  describe('payment methods against a real database', () => {
    const ADMIN_ID = '00000000-0000-4000-8000-0000000000aa';

    itInTenant('creates a method and rejects an incoherent one', async () => {
      const methods = moduleRef.get(graph.PaymentMethodService);

      const created = await methods.create(ADMIN_ID, {
        code: METHOD_CODE,
        displayName: 'Integration Bank',
        rail: 'BANK_TRANSFER',
        currencyCode: 'NSP',
        verificationMode: 'MANUAL_PROOF',
        minAmount: '100.00',
        maxAmount: '10000.00',
        feeFixed: '1.00',
        feeBps: 50,
        requiresReference: true,
      });

      methodId = created.id;
      expect(created.code).toBe(METHOD_CODE);
      expect(created.minAmount).toBe('100.00');
      // requiredProofFields comes from the DRIVER, not from the row.
      expect(created.requiredProofFields).toContain('SENDER_ACCOUNT');

      await expect(
        methods.create(ADMIN_ID, {
          code: `${METHOD_CODE}_BAD`,
          displayName: 'Bad',
          rail: 'BANK_TRANSFER',
          currencyCode: 'NSP',
          verificationMode: 'MANUAL_PROOF',
          minAmount: '100.00',
          maxAmount: '10.00',
        }),
      ).rejects.toThrow(/maxAmount/i);
    });

    itInTenant('refuses a duplicate code with a conflict, not a raw Prisma error', async () => {
      const methods = moduleRef.get(graph.PaymentMethodService);
      await expect(
        methods.create(ADMIN_ID, {
          code: METHOD_CODE,
          displayName: 'Duplicate',
          rail: 'BANK_TRANSFER',
          currencyCode: 'NSP',
          verificationMode: 'MANUAL_PROOF',
          minAmount: '100.00',
          maxAmount: '10000.00',
        }),
      ).rejects.toMatchObject({ httpStatus: 409 });
    });

    itInTenant('rotates destinations proportionally and stays sticky per player', async () => {
      const destinations = moduleRef.get(graph.PaymentDestinationService);
      const picker = moduleRef.get(graph.DestinationPickerService);
      expect(methodId).not.toBeNull();

      for (const [label, priority] of [
        ['Alpha', 0],
        ['Beta', 1],
      ] as const) {
        const created = await destinations.create(ADMIN_ID, methodId as string, {
          label,
          accountIdentifier: `ACCT-${SUFFIX}-${label}`,
          priority,
        });
        destinationIds.push(created.id);
      }

      const counts = new Map<string, number>();
      for (let index = 0; index < 31; index += 1) {
        const picked = await picker.pickFor(methodId as string, `int-player-${SUFFIX}-${index}`);
        counts.set(picked.id, (counts.get(picked.id) ?? 0) + 1);
      }
      // weights 16 and 15 over 31 distinct players.
      expect([...counts.values()].sort((a, b) => b - a)).toEqual([16, 15]);

      const stickyPlayer = `int-sticky-${SUFFIX}`;
      const first = await picker.pickFor(methodId as string, stickyPlayer);
      const second = await picker.pickFor(methodId as string, stickyPlayer);
      expect(second.id).toBe(first.id);

      await picker.clearSticky(methodId as string, stickyPlayer);
      expect(await picker.peekSticky(methodId as string, stickyPlayer)).toBeNull();
    });

    itInTenant('renders rail instructions through the port', async () => {
      const payments = moduleRef.get<PaymentMethodPort>(PAYMENT_METHOD_PORT);
      const destinationId = destinationIds[0];
      expect(destinationId).toBeDefined();

      const text = await payments.renderInstructions(
        methodId as string,
        destinationId as string,
        250_00n,
        'K7Q2ZP9V3M',
      );

      expect(text).toContain('250.00 NSP');
      expect(text).toContain('K7Q2ZP9V3M');
    });

    itInTenant('reports rail validation issues through the port', async () => {
      const payments = moduleRef.get<PaymentMethodPort>(PAYMENT_METHOD_PORT);
      const result = await payments.checkSubmission({
        paymentMethodId: methodId as string,
        destinationId: destinationIds[0] as string,
        amountMinor: 1n, // below the 100.00 minimum
        externalReference: null, // required by this method
        senderAccount: null, // required by the bank rail
        proofCount: 0,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const codes = result.issues.map((issue) => issue.code);
        expect(codes).toEqual(
          expect.arrayContaining([
            'AMOUNT_BELOW_MINIMUM',
            'REFERENCE_REQUIRED',
            'SENDER_ACCOUNT_REQUIRED',
            'PROOF_REQUIRED',
          ]),
        );
      }
    });
  });

  // ---------------------------------------------------------------------------

  describe('admin approval limits against a real database', () => {
    let adminId: string;

    /** The principal a guarded request would carry: a SUPER_ADMIN of the bootstrap operator. */
    const actor: Parameters<AdminUserService['create']>[0] = {
      adminUserId: '00000000-0000-4000-8000-0000000000aa',
      telegramUserId: null,
      tenantId: TENANT_BOOTSTRAP_ID,
      role: 'SUPER_ADMIN',
      displayName: 'Int actor',
    };

    itInTenant('creates an admin and evaluates real ceilings inside a transaction', async () => {
      const admins = moduleRef.get(graph.AdminUserService);
      const limits = moduleRef.get(graph.AdminApprovalLimitService);

      // A staff account is a username and a password (contract, 2026-09-05); TG_BASE keeps it unique.
      const created = await admins.create(actor, {
        username: `int-finance-${(TG_BASE + 1n).toString()}`,
        password: 'Int-Finance-Pass-1',
        displayName: `Int Finance ${SUFFIX}`,
        role: 'FINANCE_ADMIN',
      });
      adminId = created.id;
      createdAdminIds.push(adminId);

      // No limit configured yet -> fails closed.
      const denied = await prisma.runInTransaction((tx) =>
        limits.evaluate(
          tx,
          { adminUserId: adminId, role: 'FINANCE_ADMIN', tenantId: TENANT_BOOTSTRAP_ID },
          50_000n,
          'NSP',
        ),
      );
      expect(denied).toBe('DENIED');

      await limits.setLimit('00000000-0000-4000-8000-0000000000aa', adminId, {
        currencyCode: 'NSP',
        maxSingleApproval: '5000.00',
        maxDailyApproval: '20000.00',
      });

      const [allowed, needsSecond, aboveCeiling] = await prisma.runInTransaction(async (tx) => [
        await limits.evaluate(
          tx,
          { adminUserId: adminId, role: 'FINANCE_ADMIN', tenantId: TENANT_BOOTSTRAP_ID },
          50_000n,
          'NSP',
        ),
        await limits.evaluate(
          tx,
          { adminUserId: adminId, role: 'FINANCE_ADMIN', tenantId: TENANT_BOOTSTRAP_ID },
          150_000n,
          'NSP',
        ),
        await limits.evaluate(
          tx,
          { adminUserId: adminId, role: 'FINANCE_ADMIN', tenantId: TENANT_BOOTSTRAP_ID },
          600_000n,
          'NSP',
        ),
      ]);

      expect(allowed).toBe('ALLOWED');
      expect(needsSecond).toBe('NEEDS_SECOND');
      expect(aboveCeiling).toBe('DENIED');
    });

    itInTenant('supersedes a limit rather than mutating it, leaving no gap', async () => {
      const limits = moduleRef.get(graph.AdminApprovalLimitService);

      await limits.setLimit('00000000-0000-4000-8000-0000000000aa', adminId, {
        currencyCode: 'NSP',
        maxSingleApproval: '9000.00',
        maxDailyApproval: '30000.00',
      });

      const history = await limits.listForAdmin(adminId);
      expect(history).toHaveLength(2);
      // Exactly one open version, and the older one is closed.
      expect(history.filter((row) => row.effectiveTo === null)).toHaveLength(1);
      expect(history[0]?.maxSingleApproval).toBe('9000.00');
    });

    itInTenant('refuses to deactivate the last active SUPER_ADMIN', async () => {
      const admins = moduleRef.get(graph.AdminUserService);

      const superAdmin = await admins.create(actor, {
        username: `int-super-${(TG_BASE + 2n).toString()}`,
        password: 'Int-Super-Pass-1',
        displayName: `Int Super ${SUFFIX}`,
        role: 'SUPER_ADMIN',
      });
      createdAdminIds.push(superAdmin.id);

      const otherActiveSuperAdmins = await prisma.adminUser.count({
        where: { role: 'SUPER_ADMIN', isActive: true, id: { not: superAdmin.id } },
      });

      if (otherActiveSuperAdmins === 0) {
        await expect(admins.deactivate(actor, superAdmin.id)).rejects.toMatchObject({
          errorCode: 'ADMIN_LAST_SUPER_ADMIN',
        });
      } else {
        // Another SUPER_ADMIN exists in this database, so the guard correctly permits it.
        await expect(admins.deactivate(actor, superAdmin.id)).resolves.toMatchObject({
          isActive: false,
        });
      }
    });

    itInTenant('refuses self-demotion', async () => {
      const admins = moduleRef.get(graph.AdminUserService);
      const self = { ...actor, adminUserId: adminId };
      await expect(admins.update(self, adminId, { role: 'VIEWER' })).rejects.toMatchObject({
        errorCode: 'ADMIN_SELF_MODIFICATION',
      });
    });
  });

  // ---------------------------------------------------------------------------

  describe('player linking against the fake Ichancy adapter', () => {
    let playerId: string;

    beforeAll(
      inTenant(async () => {
        const players = moduleRef.get(graph.PlayerService);
        const { playerId: created } = await prisma.runInTransaction((tx) =>
          players.upsertFromTelegram(
            tx,
            TENANT_BOOTSTRAP_ID,
            { telegramUserId: TG_BASE + 10n, firstName: 'Int', telegramUsername: `int_${SUFFIX}` },
            'NSP',
          ),
        );
        playerId = created;
        createdPlayerIds.push(playerId);
      }),
    );

    itInTenant('is idempotent: linking twice makes exactly one registration', async () => {
      const link = moduleRef.get<PlayerLinkPort>(PLAYER_LINK_PORT);

      const first = await link.ensureLinked(playerId);
      expect(first.created).toBe(true);
      expect(first.ichancyPlayerId).toBeTruthy();

      const second = await link.ensureLinked(playerId);
      expect(second.ichancyPlayerId).toBe(first.ichancyPlayerId);
      // The second call must short-circuit on the stored id and never reach the API again.
      expect(second.created).toBe(false);
      expect(fakeIchancy.callsFor('ensurePlayer')).toHaveLength(1);
    });

    itInTenant('persists the link and encrypts the password at rest', async () => {
      const row = await prisma.player.findUniqueOrThrow({
        where: { id: playerId, tenantId: TENANT_BOOTSTRAP_ID },
      });

      expect(row.ichancyPlayerId).toBeTruthy();
      // The Telegram id is the readable half so the agent can find the row in their own panel; the
      // keyed suffix is what stops that public id from revealing the login (ichancy-credentials.util).
      expect(row.ichancyLogin).toMatch(
        new RegExp(`^p${String(row.telegramUserId)}_[a-z0-9]{8}$`),
      );
      expect(row.status).toBe('ACTIVE');
      // The stored value must be the sealed envelope, never the password itself.
      expect(row.ichancyPasswordEnc).toMatch(/^v1\./);

      const service = moduleRef.get(graph.PlayerLinkService);
      const credentials = service.credentialsFor(row);
      expect(row.ichancyPasswordEnc).not.toContain(credentials.password);
      expect(credentials.login).toBe(row.ichancyLogin);
    });

    itInTenant(
      'surfaces an ambiguous registration as a retryable 503, persisting nothing',
      async () => {
        const players = moduleRef.get(graph.PlayerService);
        const link = moduleRef.get<PlayerLinkPort>(PLAYER_LINK_PORT);

        const { playerId: other } = await prisma.runInTransaction((tx) =>
          players.upsertFromTelegram(
            tx,
            TENANT_BOOTSTRAP_ID,
            { telegramUserId: TG_BASE + 11n, firstName: 'Amb' },
            'NSP',
          ),
        );
        createdPlayerIds.push(other);

        fakeIchancy.setMode('ambiguous');
        await expect(link.ensureLinked(other)).rejects.toMatchObject({ httpStatus: 503 });
        fakeIchancy.setMode('ok');

        // Nothing half-written: an unknown outcome must leave the row untouched.
        const row = await prisma.player.findUniqueOrThrow({
          where: { id: other, tenantId: TENANT_BOOTSTRAP_ID },
        });
        expect(row.ichancyPlayerId).toBeNull();
        expect(row.ichancyPasswordEnc).toBeNull();
      },
    );

    itInTenant('reports eligibility from status AND self-exclusion', async () => {
      const players = moduleRef.get(graph.PlayerService);
      await expect(players.checkEligibility(playerId)).resolves.toMatchObject({ eligible: true });

      // The exclusion belongs to the same operator as the player it excludes; taking the tenant off
      // the row rather than naming a constant keeps the fixture honest if the sign-in tenant moves.
      const { tenantId } = await prisma.player.findUniqueOrThrow({
        where: { id: playerId, tenantId: TENANT_BOOTSTRAP_ID },
      });
      const exclusion = await prisma.selfExclusion.create({
        data: {
          tenantId,
          playerId,
          requestedByType: 'PLAYER',
          requestedById: playerId,
          endsAt: null,
        },
      });

      // A PERMANENT exclusion has endsAt = null. Reading that as "no end date, so not active" is
      // the inversion this asserts against.
      await expect(players.checkEligibility(playerId)).resolves.toMatchObject({
        eligible: false,
        reason: 'PLAYER_SELF_EXCLUDED',
      });

      await prisma.selfExclusion.delete({ where: { id: exclusion.id, tenantId } });
    });
  });

  // ---------------------------------------------------------------------------

  describe('HTTP surface', () => {
    // `getHttpServer()` is typed `any`; narrowing it once here keeps every call site type-safe
    // instead of spreading unsafe-argument suppressions across the block.
    const server = (): Server => app.getHttpServer() as Server;

    it('rejects an unauthenticated /v1/me with the standard error envelope', async () => {
      const response = await request(server()).get('/v1/me').expect(401);
      const body = response.body as { success: boolean; data: unknown; error: { code: string } };

      // The success and failure halves of the envelope must be the same shape, or the mini app's
      // single fetch wrapper breaks.
      expect(body.success).toBe(false);
      expect(body.data).toBeNull();
      expect(typeof body.error.code).toBe('string');
    });

    it('rejects an unauthenticated payment-method listing', async () => {
      await request(server()).get('/v1/payment-methods').expect(401);
    });

    it('rejects an unauthenticated admin route', async () => {
      await request(server()).get('/v1/admin/admins').expect(401);
    });

    it('validates the login body before touching any Telegram logic', async () => {
      const response = await request(server()).post('/v1/auth/telegram').send({}).expect(400);
      const body = response.body as { error: { code: string } };

      expect(body.error.code).toBeDefined();
    });

    it('rejects malformed initData as unauthorized, not as a server error', async () => {
      // A bad signature must be a 401, never a 500: the verifier has to fail closed on junk.
      await request(server())
        .post('/v1/auth/telegram')
        .send({ initData: 'user=%7B%7D&hash=deadbeef' })
        .expect(401);
    });
  });
});
