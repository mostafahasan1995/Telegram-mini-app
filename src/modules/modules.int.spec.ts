/**
 * Boots the three feature modules for real — real Postgres, real Redis, the fake Ichancy adapter —
 * and exercises the paths that unit tests structurally cannot reach.
 *
 * WHY this exists on top of 118 unit tests: every one of those constructs its subject with `new`.
 * None of them proves that Nest can BUILD these modules. A missing provider, a service that is
 * exported but not provided, or a token nobody binds are all invisible to `tsc` and to a unit test,
 * and they fail at boot in production. The DI graph is the thing most worth checking here.
 *
 * Run with:  npx jest --runInBand src/modules/modules.int.spec.ts
 * Requires the dev containers (docker compose up -d postgres redis).
 */
process.env['APP_ROLE'] = 'api';
process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '3000';
process.env['API_BASE_URL'] = 'http://localhost:3000';
process.env['DATABASE_URL'] ??= 'postgresql://ichancy:ichancy@localhost:55432/ichancy';
process.env['REDIS_URL'] ??= 'redis://localhost:6379';
process.env['JWT_SECRET'] = 'integration-test-secret-value-32-chars';
process.env['TELEGRAM_BOT_TOKEN'] = '123456:AAtest_token_for_integration_only';
process.env['TELEGRAM_WEBHOOK_SECRET'] = 'integration_webhook_secret_value';
process.env['TELEGRAM_WEBHOOK_PATH_TOKEN'] = 'inttestpath';
process.env['TELEGRAM_ADMIN_CHAT_ID'] = '-1001234567890';
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

import { AppConfigModule } from '@core/config/config.module';
import { PrismaModule } from '@core/prisma/prisma.module';
import { PrismaService } from '@core/prisma/prisma.service';
import { CacheModule } from '@core/cache/cache.module';
import { RedisService } from '@core/cache/redis.service';
import { AuditModule } from '@core/audit/audit.module';
import { FakeIchancyAdapter } from '@core/ichancy/fake-ichancy.adapter';
import { GlobalExceptionFilter } from '@common/filters/global-exception.filter';
import { TransformInterceptor } from '@common/interceptors/transform.interceptor';

import { PlayerModule } from './player/player.module';
import { PLAYER_LINK_PORT, type PlayerLinkPort } from './player/player-link.port';
import { PlayerLinkService } from './player/services/player-link.service';
import { PlayerService } from './player/services/player.service';
import { ReferralService } from './player/services/referral.service';
import { PlayerTelegramHandlers } from './player/telegram/player.handlers';

import { AdminModule } from './admin/admin.module';
import { APPROVAL_LIMIT_PORT, type ApprovalLimitPort } from './admin/approval-limit.port';
import { AdminApprovalLimitService } from './admin/services/admin-approval-limit.service';
import { AdminUserService } from './admin/services/admin-user.service';

import { PaymentMethodModule } from './payment-method/payment-method.module';
import { PAYMENT_METHOD_PORT, type PaymentMethodPort } from './payment-method/payment-method.port';
import { PaymentMethodService } from './payment-method/services/payment-method.service';
import { PaymentDestinationService } from './payment-method/services/payment-destination.service';
import { DestinationPickerService } from './payment-method/services/destination-picker.service';

jest.setTimeout(60_000);

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
 * WHY a suite that cleans up in `afterAll` still has to clean up in `beforeAll`: this runs against a
 * SHARED database, and an `afterAll` only runs if the process gets that far. A crash, a timeout or a
 * Ctrl-C leaves rows behind, and one of them is fatal rather than merely untidy —
 * `FakeIchancyAdapter` numbers players from a counter that `reset()` puts back to zero, so every run
 * registers `fake-player-000001` into a UNIQUE column. Without this purge, one interrupted run makes
 * every subsequent run fail on a unique-constraint violation until somebody truncates by hand.
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
  let moduleRef: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let fakeIchancy: FakeIchancyAdapter;

  const createdPlayerIds: string[] = [];
  const createdAdminIds: string[] = [];
  let methodId: string | null = null;
  const destinationIds: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        PrismaModule,
        CacheModule,
        AuditModule,
        PlayerModule,
        AdminModule,
        PaymentMethodModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalInterceptors(new TransformInterceptor());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();

    prisma = moduleRef.get(PrismaService);
    redis = moduleRef.get(RedisService);
    fakeIchancy = moduleRef.get(FakeIchancyAdapter);
    fakeIchancy.reset();

    await purgeLeftovers(prisma);
  });

  afterAll(async () => {
    // WHY try/finally: this suite cleans up against a SHARED database, so any statement below can
    // fail (a constraint, a row another suite already removed). If that throw escapes, `app.close()`
    // never runs and the pg pool plus the ioredis connection leak — Jest then reports every test as
    // passed and hangs forever instead of exiting. Closing the app is the one step that must happen.
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
      }
      if (redis !== undefined) {
        const keys = await redis.keys(`paydest:*${SUFFIX}*`);
        if (keys.length > 0) await redis.del(...keys);
      }
    } finally {
      await app?.close();
    }
  });

  // ---------------------------------------------------------------------------

  describe('dependency injection graph', () => {
    it('resolves every provider the three modules export', () => {
      // The check `tsc` cannot do: a service listed in `exports` but missing from `providers`
      // compiles perfectly and throws only when Nest builds the graph.
      expect(moduleRef.get(PlayerService)).toBeInstanceOf(PlayerService);
      expect(moduleRef.get(PlayerLinkService)).toBeInstanceOf(PlayerLinkService);
      expect(moduleRef.get(ReferralService)).toBeInstanceOf(ReferralService);
      expect(moduleRef.get(PlayerTelegramHandlers)).toBeInstanceOf(PlayerTelegramHandlers);
      expect(moduleRef.get(AdminUserService)).toBeInstanceOf(AdminUserService);
      expect(moduleRef.get(AdminApprovalLimitService)).toBeInstanceOf(AdminApprovalLimitService);
      expect(moduleRef.get(PaymentMethodService)).toBeInstanceOf(PaymentMethodService);
      expect(moduleRef.get(PaymentDestinationService)).toBeInstanceOf(PaymentDestinationService);
      expect(moduleRef.get(DestinationPickerService)).toBeInstanceOf(DestinationPickerService);
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
      expect(link).toBe(moduleRef.get(PlayerLinkService));
    });
  });

  // ---------------------------------------------------------------------------

  describe('payment methods against a real database', () => {
    const ADMIN_ID = '00000000-0000-4000-8000-0000000000aa';

    it('creates a method and rejects an incoherent one', async () => {
      const methods = moduleRef.get(PaymentMethodService);

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

    it('refuses a duplicate code with a conflict, not a raw Prisma error', async () => {
      const methods = moduleRef.get(PaymentMethodService);
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

    it('rotates destinations proportionally and stays sticky per player', async () => {
      const destinations = moduleRef.get(PaymentDestinationService);
      const picker = moduleRef.get(DestinationPickerService);
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

    it('renders rail instructions through the port', async () => {
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

    it('reports rail validation issues through the port', async () => {
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

    it('creates an admin and evaluates real ceilings inside a transaction', async () => {
      const admins = moduleRef.get(AdminUserService);
      const limits = moduleRef.get(AdminApprovalLimitService);

      const created = await admins.create('00000000-0000-4000-8000-0000000000aa', {
        telegramUserId: (TG_BASE + 1n).toString(),
        displayName: `Int Finance ${SUFFIX}`,
        role: 'FINANCE_ADMIN',
      });
      adminId = created.id;
      createdAdminIds.push(adminId);

      // No limit configured yet -> fails closed.
      const denied = await prisma.runInTransaction((tx) =>
        limits.evaluate(tx, { adminUserId: adminId, role: 'FINANCE_ADMIN' }, 50_000n, 'NSP'),
      );
      expect(denied).toBe('DENIED');

      await limits.setLimit('00000000-0000-4000-8000-0000000000aa', adminId, {
        currencyCode: 'NSP',
        maxSingleApproval: '5000.00',
        maxDailyApproval: '20000.00',
      });

      const [allowed, needsSecond, aboveCeiling] = await prisma.runInTransaction(async (tx) => [
        await limits.evaluate(tx, { adminUserId: adminId, role: 'FINANCE_ADMIN' }, 50_000n, 'NSP'),
        await limits.evaluate(tx, { adminUserId: adminId, role: 'FINANCE_ADMIN' }, 150_000n, 'NSP'),
        await limits.evaluate(tx, { adminUserId: adminId, role: 'FINANCE_ADMIN' }, 600_000n, 'NSP'),
      ]);

      expect(allowed).toBe('ALLOWED');
      expect(needsSecond).toBe('NEEDS_SECOND');
      expect(aboveCeiling).toBe('DENIED');
    });

    it('supersedes a limit rather than mutating it, leaving no gap', async () => {
      const limits = moduleRef.get(AdminApprovalLimitService);

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

    it('refuses to deactivate the last active SUPER_ADMIN', async () => {
      const admins = moduleRef.get(AdminUserService);

      const superAdmin = await admins.create('00000000-0000-4000-8000-0000000000aa', {
        telegramUserId: (TG_BASE + 2n).toString(),
        displayName: `Int Super ${SUFFIX}`,
        role: 'SUPER_ADMIN',
      });
      createdAdminIds.push(superAdmin.id);

      const otherActiveSuperAdmins = await prisma.adminUser.count({
        where: { role: 'SUPER_ADMIN', isActive: true, id: { not: superAdmin.id } },
      });

      if (otherActiveSuperAdmins === 0) {
        await expect(
          admins.deactivate('00000000-0000-4000-8000-0000000000aa', superAdmin.id),
        ).rejects.toMatchObject({ errorCode: 'ADMIN_LAST_SUPER_ADMIN' });
      } else {
        // Another SUPER_ADMIN exists in this database, so the guard correctly permits it.
        await expect(
          admins.deactivate('00000000-0000-4000-8000-0000000000aa', superAdmin.id),
        ).resolves.toMatchObject({ isActive: false });
      }
    });

    it('refuses self-demotion', async () => {
      const admins = moduleRef.get(AdminUserService);
      await expect(admins.update(adminId, adminId, { role: 'VIEWER' })).rejects.toMatchObject({
        errorCode: 'ADMIN_SELF_MODIFICATION',
      });
    });
  });

  // ---------------------------------------------------------------------------

  describe('player linking against the fake Ichancy adapter', () => {
    let playerId: string;

    beforeAll(async () => {
      const players = moduleRef.get(PlayerService);
      const { playerId: created } = await prisma.runInTransaction((tx) =>
        players.upsertFromTelegram(
          tx,
          { telegramUserId: TG_BASE + 10n, firstName: 'Int', telegramUsername: `int_${SUFFIX}` },
          'NSP',
        ),
      );
      playerId = created;
      createdPlayerIds.push(playerId);
    });

    it('is idempotent: linking twice makes exactly one registration', async () => {
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

    it('persists the link and encrypts the password at rest', async () => {
      const row = await prisma.player.findUniqueOrThrow({ where: { id: playerId } });

      expect(row.ichancyPlayerId).toBeTruthy();
      expect(row.ichancyLogin).toMatch(/^[a-z][a-z0-9]{15}$/);
      expect(row.status).toBe('ACTIVE');
      // The stored value must be the sealed envelope, never the password itself.
      expect(row.ichancyPasswordEnc).toMatch(/^v1\./);

      const service = moduleRef.get(PlayerLinkService);
      const credentials = service.credentialsFor(row);
      expect(row.ichancyPasswordEnc).not.toContain(credentials.password);
      expect(credentials.login).toBe(row.ichancyLogin);
    });

    it('surfaces an ambiguous registration as a retryable 503, persisting nothing', async () => {
      const players = moduleRef.get(PlayerService);
      const link = moduleRef.get<PlayerLinkPort>(PLAYER_LINK_PORT);

      const { playerId: other } = await prisma.runInTransaction((tx) =>
        players.upsertFromTelegram(tx, { telegramUserId: TG_BASE + 11n, firstName: 'Amb' }, 'NSP'),
      );
      createdPlayerIds.push(other);

      fakeIchancy.setMode('ambiguous');
      await expect(link.ensureLinked(other)).rejects.toMatchObject({ httpStatus: 503 });
      fakeIchancy.setMode('ok');

      // Nothing half-written: an unknown outcome must leave the row untouched.
      const row = await prisma.player.findUniqueOrThrow({ where: { id: other } });
      expect(row.ichancyPlayerId).toBeNull();
      expect(row.ichancyPasswordEnc).toBeNull();
    });

    it('reports eligibility from status AND self-exclusion', async () => {
      const players = moduleRef.get(PlayerService);
      await expect(players.checkEligibility(playerId)).resolves.toMatchObject({ eligible: true });

      const exclusion = await prisma.selfExclusion.create({
        data: { playerId, requestedByType: 'PLAYER', requestedById: playerId, endsAt: null },
      });

      // A PERMANENT exclusion has endsAt = null. Reading that as "no end date, so not active" is
      // the inversion this asserts against.
      await expect(players.checkEligibility(playerId)).resolves.toMatchObject({
        eligible: false,
        reason: 'PLAYER_SELF_EXCLUDED',
      });

      await prisma.selfExclusion.delete({ where: { id: exclusion.id } });
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
