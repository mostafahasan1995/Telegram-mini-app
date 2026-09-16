/**
 * POST /v1/admin/auth/credentials through the REAL api: AppModule, the real middleware, guards,
 * throttler, Postgres and Redis.
 *
 * What only this level can prove:
 *  - the body the console actually receives parses with the console's own session schema (copied
 *    below from manager-account-dashboard src/types/admin.ts);
 *  - every refusal before a password is proven is byte-identical on the wire;
 *  - the returned token passes the real AuthGuard and RolesGuard, and a PLATFORM_ADMIN signed into
 *    tenant zero can reach another operator's staff directory through X-Tenant-Id;
 *  - the throttler really answers 429 on the 11th attempt;
 *  - the retired bot-code route is gone and no throttle rule is left pointing at nothing.
 *
 * `tenants` survives truncateAll, so the two operators this suite adds are named with a run-unique
 * prefix and deleted in afterAll — after a reset, because the audit rows a sign-in writes are
 * append-only and would otherwise hold the tenant row in place.
 *
 * Run with the escape hatch (no testcontainers):
 *   POSTGRES_TEST_URL=... REDIS_TEST_URL=... npx jest --config jest-int.config.cjs --runInBand \
 *     src/modules/admin/admin-auth.int.spec.ts
 */
import { AdminRole, TenantStatus } from '@prisma/client';
import request from 'supertest';
import { z } from 'zod';

import type { PasswordHasherService } from '@core/auth/services/password-hasher.service';
import type { PrismaService } from '@core/prisma/prisma.service';
import {
  TENANT_BOOTSTRAP_ID,
  TENANT_BOOTSTRAP_SLUG,
  TENANT_HEADER,
  TENANT_ZERO_ID,
  TENANT_ZERO_SLUG,
} from '@core/tenant/tenant.constants';
import { THROTTLE_RULES, findUnmatchedRules } from '@core/throttler/throttle-routes';

import { createTestApp, type TestApp } from '../../../test/setup/app-factory';

jest.setTimeout(180_000);

// ── The console's contract, copied from manager-account-dashboard src/types/admin.ts ───────────
const ADMIN_ROLES = [
  'PLATFORM_ADMIN',
  'SUPER_ADMIN',
  'FINANCE_ADMIN',
  'REVIEWER',
  'SUPPORT',
  'VIEWER',
] as const;
const adminIdentitySchema = z.looseObject({
  id: z.string(),
  telegramUserId: z.string().nullable(),
  role: z.enum(ADMIN_ROLES),
  displayName: z.string(),
});
const adminSessionSchema = z.looseObject({
  accessToken: z.string(),
  expiresAt: z.string(),
  admin: adminIdentitySchema,
  tenantId: z.string().optional(),
  tenantSlug: z.string().optional(),
});
const directorySchema = z.array(z.looseObject({ id: z.string() }));

const RUN = Date.now().toString(36);
/** Every operator this suite creates starts with it, so a crashed run's leftovers are found. */
const SLUG_PREFIX = 'p4-int-';
const SECOND_SLUG = `${SLUG_PREFIX}${RUN}-second`;
const SUSPENDED_SLUG = `${SLUG_PREFIX}${RUN}-suspended`;
const PASSWORD = 'Correct-Horse-9';
const WRONG_PASSWORD = 'Wrong-Horse-9';
const login = (name: string): string => `p4-${RUN}-${name}`;

describe('POST /v1/admin/auth/credentials (integration)', () => {
  let ctx: TestApp;
  let prisma: PrismaService;

  let secondTenantId: string;
  let bootstrapDisplayName: string;
  let ownerId: string;
  let platformAdminId: string;

  const signIn = (body: Record<string, unknown>): request.Test =>
    request(ctx.httpServer).post('/v1/admin/auth/credentials').send(body);

  const removeSuiteOperators = async (): Promise<void> => {
    // Tenant is not a scoped model; admin rows cascade with it.
    await prisma.tenant.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
  };

  const createOperator = async (slug: string, status: TenantStatus): Promise<string> => {
    const tenant = await prisma.tenant.create({
      data: {
        slug,
        displayName: `P4 ${slug}`,
        status,
        botTokenEnc: 'P4-INT-NO-BOT',
        adminChatId: 0n,
        ichancyBaseUrl: 'https://example.invalid',
        ichancyUsername: 'unused',
        ichancyPasswordEnc: 'P4-INT-NO-AGENT',
        ichancyAgentId: 'unused',
        currencyCode: 'NSP',
        dualApprovalThresholdMinor: 0n,
        agentFloatLowWatermarkMinor: 0n,
        depositExpiryMinutes: 30,
      },
      select: { id: true },
    });
    return tenant.id;
  };

  const createAdmin = async (
    tenantId: string,
    username: string,
    role: AdminRole,
    passwordHash: string | null,
    isActive = true,
  ): Promise<string> => {
    const admin = await prisma.adminUser.create({
      data: {
        tenantId,
        username,
        displayName: `P4 ${username}`,
        role,
        isActive,
        passwordHash,
        telegramUserId: null,
      },
      select: { id: true },
    });
    return admin.id;
  };

  beforeAll(async () => {
    ctx = await createTestApp();

    // Dynamic, like the harness itself: these modules must load after the test env exists.
    const { PrismaService: PrismaServiceClass } = await import('@core/prisma/prisma.service');
    const { PasswordHasherService: HasherClass } = await import(
      '@core/auth/services/password-hasher.service'
    );
    prisma = ctx.app.get(PrismaServiceClass);
    const hasher: PasswordHasherService = ctx.app.get(HasherClass);

    // A crashed earlier run can leave operators behind, held in place by their audit rows.
    await ctx.reset();
    await removeSuiteOperators();

    const bootstrap = await prisma.tenant.findUniqueOrThrow({
      where: { id: TENANT_BOOTSTRAP_ID },
      select: { displayName: true },
    });
    bootstrapDisplayName = bootstrap.displayName;

    // The app's own hasher at the production cost, so no sign-in below takes the rehash path.
    const hash = await hasher.hash(PASSWORD);

    secondTenantId = await createOperator(SECOND_SLUG, TenantStatus.ACTIVE);
    const suspendedTenantId = await createOperator(SUSPENDED_SLUG, TenantStatus.SUSPENDED);

    ownerId = await createAdmin(TENANT_BOOTSTRAP_ID, login('owner'), AdminRole.SUPER_ADMIN, hash);
    platformAdminId = await createAdmin(
      TENANT_ZERO_ID,
      login('platform'),
      AdminRole.PLATFORM_ADMIN,
      hash,
    );
    await createAdmin(TENANT_BOOTSTRAP_ID, login('inactive'), AdminRole.FINANCE_ADMIN, hash, false);
    await createAdmin(TENANT_BOOTSTRAP_ID, login('nopassword'), AdminRole.SUPPORT, null);
    await createAdmin(TENANT_BOOTSTRAP_ID, login('shared'), AdminRole.REVIEWER, hash);
    await createAdmin(secondTenantId, login('shared'), AdminRole.SUPER_ADMIN, hash);
    await createAdmin(suspendedTenantId, login('suspended'), AdminRole.SUPER_ADMIN, hash);
  });

  afterAll(async () => {
    if (ctx === undefined) return;
    // Reset first: it truncates audit_logs (append-only) so the suite's operators can be deleted.
    await ctx.reset();
    await removeSuiteOperators();
    await ctx.close();
  });

  beforeEach(async () => {
    // Throttle counters and the identity cache both live in Redis; every test starts with neither.
    await ctx.redis.flush();
  });

  it('signs a SUPER_ADMIN into their operator with the body the console parses, and audits it', async () => {
    const response = await signIn({
      username: `  ${login('owner').toUpperCase()} `,
      password: PASSWORD,
    }).expect(200);

    // parse, not safeParse: a body the console cannot read fails right here, with zod's reason.
    const session = adminSessionSchema.parse(response.body.data);
    expect(response.body.data).toMatchObject({
      admin: {
        id: ownerId,
        telegramUserId: null,
        role: 'SUPER_ADMIN',
        displayName: `P4 ${login('owner')}`,
      },
      tenantId: TENANT_BOOTSTRAP_ID,
      tenantSlug: TENANT_BOOTSTRAP_SLUG,
    });
    expect(response.body.data).not.toHaveProperty('refreshToken');
    expect(Date.parse(session.expiresAt)).toBeGreaterThan(Date.now());

    const stamped = await prisma.adminUser.findUniqueOrThrow({
      where: { id: ownerId },
      select: { lastLoginAt: true },
    });
    expect(stamped.lastLoginAt).not.toBeNull();

    const audits = await prisma.auditLog.findMany({
      where: { tenantId: TENANT_BOOTSTRAP_ID, action: 'admin.login', entityId: ownerId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorId).toBe(ownerId);
    expect(
      JSON.stringify(audits, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain(PASSWORD);

    // The token works on a guarded admin route, resolved in the operator it was issued for.
    const directory = await request(ctx.httpServer)
      .get('/v1/admin/admins')
      .set('authorization', `Bearer ${session.accessToken}`)
      .expect(200);
    const ids = directorySchema.parse(directory.body.data).map((row) => row.id);
    expect(ids).toContain(ownerId);
    expect(ids).not.toContain(platformAdminId);

    // X-Tenant-Id is ignored, not honoured, for anyone who is not platform staff.
    const ignored = await request(ctx.httpServer)
      .get('/v1/admin/admins')
      .set('authorization', `Bearer ${session.accessToken}`)
      .set(TENANT_HEADER, TENANT_ZERO_ID)
      .expect(200);
    expect(directorySchema.parse(ignored.body.data).map((row) => row.id)).not.toContain(
      platformAdminId,
    );
  });

  it('signs a PLATFORM_ADMIN into tenant zero, whose token reaches another operator with X-Tenant-Id', async () => {
    const response = await signIn({ username: login('platform'), password: PASSWORD }).expect(200);

    expect(adminSessionSchema.safeParse(response.body.data).success).toBe(true);
    expect(response.body.data).toMatchObject({
      admin: { id: platformAdminId, role: 'PLATFORM_ADMIN', telegramUserId: null },
      tenantId: TENANT_ZERO_ID,
      tenantSlug: TENANT_ZERO_SLUG,
    });
    const bearer = `Bearer ${response.body.data.accessToken}`;

    // Home: tenant zero's own directory.
    const home = await request(ctx.httpServer)
      .get('/v1/admin/admins')
      .set('authorization', bearer)
      .expect(200);
    const homeIds = directorySchema.parse(home.body.data).map((row) => row.id);
    expect(homeIds).toContain(platformAdminId);
    expect(homeIds).not.toContain(ownerId);

    // Pointed at the bootstrap operator: its staff, not the platform's. Identity is still resolved
    // in tenant zero (the guard passed), only the data moved.
    const reached = await request(ctx.httpServer)
      .get('/v1/admin/admins')
      .set('authorization', bearer)
      .set(TENANT_HEADER, TENANT_BOOTSTRAP_ID)
      .expect(200);
    const reachedIds = directorySchema.parse(reached.body.data).map((row) => row.id);
    expect(reachedIds).toContain(ownerId);
    expect(reachedIds).not.toContain(platformAdminId);
  });

  it('answers a wrong password, an unknown login, a deactivated account and a password-less one identically', async () => {
    const attempts = [
      { username: login('owner'), password: WRONG_PASSWORD },
      { username: login('nobody'), password: PASSWORD },
      { username: login('inactive'), password: PASSWORD },
      { username: login('nopassword'), password: PASSWORD },
      // A proven-wrong password must not reveal that the operator is suspended either.
      { username: login('suspended'), password: WRONG_PASSWORD },
    ];

    const bodies: unknown[] = [];
    for (const attempt of attempts) {
      const response = await signIn(attempt).expect(401);
      bodies.push({
        success: response.body.success,
        data: response.body.data,
        error: response.body.error,
      });
    }

    expect(bodies[0]).toEqual({
      success: false,
      data: null,
      error: {
        code: 'ADMIN_CREDENTIALS_INVALID',
        message: 'Those credentials are not valid for any administrator on this platform.',
      },
    });
    for (const body of bodies) expect(body).toEqual(bodies[0]);
  });

  it('asks which operator when one login opens two, then signs into the one chosen', async () => {
    await signIn({ username: login('shared'), password: WRONG_PASSWORD }).expect(401);

    const question = await signIn({ username: login('shared'), password: PASSWORD }).expect(409);
    expect(question.body.error.code).toBe('ADMIN_OPERATOR_AMBIGUOUS');
    expect(question.body.error.details).toEqual({
      operators: [
        { slug: TENANT_BOOTSTRAP_SLUG, displayName: bootstrapDisplayName },
        { slug: SECOND_SLUG, displayName: `P4 ${SECOND_SLUG}` },
      ],
    });

    const answer = await signIn({
      username: login('shared'),
      password: PASSWORD,
      operatorSlug: SECOND_SLUG,
    }).expect(200);
    expect(answer.body.data).toMatchObject({
      admin: { role: 'SUPER_ADMIN' },
      tenantId: secondTenantId,
      tenantSlug: SECOND_SLUG,
    });
  });

  it('refuses a suspended operator with ADMIN_OPERATOR_NOT_ACTIVE once the password is right', async () => {
    const response = await signIn({ username: login('suspended'), password: PASSWORD }).expect(403);

    expect(response.body.error).toEqual({
      code: 'ADMIN_OPERATOR_NOT_ACTIVE',
      message:
        'That operator is suspended. A platform admin has to activate it before anyone can sign in.',
      details: { operators: [{ slug: SUSPENDED_SLUG, displayName: `P4 ${SUSPENDED_SLUG}` }] },
    });
  });

  it('blocks the 11th attempt in a minute, even with the right password', async () => {
    const rule = THROTTLE_RULES.find((candidate) => candidate.name === 'admin-sign-in');
    expect(rule).toMatchObject({ limit: 10, ttlMs: 60_000, blockMs: 15 * 60_000 });

    const statuses: number[] = [];
    // Sequential: a burst would race the counter for reasons unrelated to the limiter.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await signIn({ username: login('nobody'), password: WRONG_PASSWORD });
      statuses.push(response.status);
    }
    expect(statuses).toEqual(Array.from({ length: 10 }, () => 401));

    const blocked = await signIn({ username: login('owner'), password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    // The block outlasts the one-minute window: that is what 15 minutes means on the wire.
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(60);
  });

  it('no longer serves the retired bot-code door', async () => {
    await request(ctx.httpServer)
      .post('/v1/admin/auth/bot-code')
      .send({ code: 'ABCD-EFGH' })
      .expect(404);
  });

  it('leaves no throttle rule without a route, so boot never logs "Rate limiting is INACTIVE"', async () => {
    const { SwaggerModule, DocumentBuilder } = await import('@nestjs/swagger');
    const document = SwaggerModule.createDocument(
      ctx.app,
      new DocumentBuilder().setTitle('routes').setVersion('test').build(),
    );
    const routes = Object.entries(document.paths).flatMap(([path, item]) =>
      Object.keys(item as Record<string, unknown>).map((method) => ({ method, path })),
    );

    expect(findUnmatchedRules(routes)).toEqual([]);
    expect(routes).toContainEqual({ method: 'post', path: '/v1/admin/auth/credentials' });
    expect(routes.some((route) => route.path.includes('bot-code') && route.path.includes('admin'))).toBe(
      false,
    );
  });
});
