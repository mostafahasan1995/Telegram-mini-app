/**
 * The operator's Ichancy agent account as a sign-in (API-CONTRACT.md §2a second credential, §2b)
 * through the REAL api: AppModule, middleware, guards, throttler, Postgres, Redis and the real
 * TenantSecretService sealing the passwords the rows hold.
 *
 * What only this level can prove:
 *  - the session parses with the console's own schema and works on a guarded route;
 *  - the agent principal is created ONCE, even when first sign-ins race, because the unique index
 *    that settles the race only exists in Postgres;
 *  - every miss is byte-identical on the wire, and /credentials' agent fallback answers exactly the
 *    shape a console-password sign-in does;
 *  - nothing on this path calls Ichancy (the fake adapter records every call it receives).
 *
 * Operators are created with a run-unique slug prefix and removed in afterAll, after a reset (the
 * audit rows a sign-in writes are append-only and would hold the tenant rows in place).
 *
 * Run with the escape hatch (no testcontainers):
 *   POSTGRES_TEST_URL=... REDIS_TEST_URL=... npx jest --config jest-int.config.cjs --runInBand \
 *     src/modules/admin/admin-agent-auth.int.spec.ts
 */
import { AdminRole, TenantStatus } from '@prisma/client';
import request from 'supertest';
import { z } from 'zod';

import type { FakeIchancyAdapter } from '@core/ichancy/fake-ichancy.adapter';
import type { PasswordHasherService } from '@core/auth/services/password-hasher.service';
import type { PrismaService } from '@core/prisma/prisma.service';
import type { TenantSecretService } from '@core/tenant/services/tenant-secret.service';
import { TENANT_BOOTSTRAP_ID } from '@core/tenant/tenant.constants';

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
const adminSessionSchema = z.looseObject({
  accessToken: z.string(),
  expiresAt: z.string(),
  admin: z.looseObject({
    id: z.string(),
    telegramUserId: z.string().nullable(),
    role: z.enum(ADMIN_ROLES),
    displayName: z.string(),
  }),
  tenantId: z.string().optional(),
  tenantSlug: z.string().optional(),
});
const adminUserSchema = z.looseObject({
  id: z.string(),
  telegramUserId: z.string().nullable(),
  username: z.string().nullable(),
  hasPassword: z.boolean(),
  displayName: z.string(),
  role: z.enum(ADMIN_ROLES),
  isActive: z.boolean(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});

const RUN = Date.now().toString(36);
const SLUG_PREFIX = 'p13-agent-';
const slugOf = (name: string): string => `${SLUG_PREFIX}${RUN}-${name}`;
const agentLogin = (name: string): string => `p13-${RUN}-${name}`;
const AGENT_PASSWORD = 'Agent-Horse-42';
const WRONG_PASSWORD = 'Agent-Horse-43';
const CONSOLE_PASSWORD = 'Console-Horse-9';

describe('Ichancy agent sign-in (integration)', () => {
  let ctx: TestApp;
  let prisma: PrismaService;
  let secrets: TenantSecretService;
  let hasher: PasswordHasherService;
  let fake: FakeIchancyAdapter;

  const ids = new Map<string, string>();
  const tenantId = (name: string): string => {
    const id = ids.get(name);
    if (id === undefined) throw new Error(`no operator ${name}`);
    return id;
  };

  const viaIchancy = (body: Record<string, unknown>): request.Test =>
    request(ctx.httpServer).post('/v1/admin/auth/ichancy').send(body);
  const viaCredentials = (body: Record<string, unknown>): request.Test =>
    request(ctx.httpServer).post('/v1/admin/auth/credentials').send(body);

  const removeSuiteOperators = async (): Promise<void> => {
    await prisma.tenant.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
  };

  const createOperator = async (
    name: string,
    status: TenantStatus,
    login: string,
    password = AGENT_PASSWORD,
  ): Promise<string> => {
    const tenant = await prisma.tenant.create({
      data: {
        slug: slugOf(name),
        displayName: `P13 ${name}`,
        status,
        botTokenEnc: 'P13-INT-NO-BOT',
        adminChatId: 0n,
        ichancyBaseUrl: 'https://example.invalid',
        ichancyUsername: login,
        ichancyPasswordEnc: secrets.sealIchancyPassword(password),
        ichancyAgentId: '7654321',
        currencyCode: 'NSP',
        dualApprovalThresholdMinor: 0n,
        agentFloatLowWatermarkMinor: 0n,
        depositExpiryMinutes: 30,
      },
      select: { id: true },
    });
    ids.set(name, tenant.id);
    return tenant.id;
  };

  const createAdmin = async (
    tenant: string,
    username: string,
    role: AdminRole,
    options: { isActive?: boolean; createdAt?: Date; passwordHash?: string | null } = {},
  ): Promise<string> => {
    const admin = await prisma.adminUser.create({
      data: {
        tenantId: tenant,
        username,
        displayName: `P13 ${username}`,
        role,
        isActive: options.isActive ?? true,
        passwordHash: options.passwordHash ?? null,
        telegramUserId: null,
        ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
      },
      select: { id: true },
    });
    return admin.id;
  };

  const staffOf = (tenant: string) =>
    prisma.adminUser.findMany({ where: { tenantId: tenant }, orderBy: { createdAt: 'asc' } });

  const principalAudits = (tenant: string) =>
    prisma.auditLog.findMany({
      where: { tenantId: tenant, action: 'admin.user.agentPrincipalCreated' },
    });

  const errorOf = (response: request.Response): unknown => ({
    success: response.body.success,
    data: response.body.data,
    error: response.body.error,
  });

  beforeAll(async () => {
    ctx = await createTestApp();

    const { PrismaService: PrismaServiceClass } = await import('@core/prisma/prisma.service');
    const { TenantSecretService: SecretsClass } = await import(
      '@core/tenant/services/tenant-secret.service'
    );
    const { PasswordHasherService: HasherClass } = await import(
      '@core/auth/services/password-hasher.service'
    );
    const { FakeIchancyAdapter: FakeClass } = await import('@core/ichancy/fake-ichancy.adapter');
    prisma = ctx.app.get(PrismaServiceClass);
    secrets = ctx.app.get(SecretsClass);
    hasher = ctx.app.get(HasherClass);
    fake = ctx.app.get(FakeClass);

    await ctx.reset();
    await removeSuiteOperators();

    // Stored mixed-case on purpose: the owner types it however they like.
    await createOperator('solo', TenantStatus.ACTIVE, agentLogin('Solo').toUpperCase());
    await createOperator('race', TenantStatus.ACTIVE, agentLogin('race'));
    await createOperator('viacreds', TenantStatus.ACTIVE, agentLogin('viacreds'));
    // Two operators on one agent: how a second operator is tested (§2b).
    await createOperator('shared-a', TenantStatus.ACTIVE, agentLogin('shared'));
    await createOperator('shared-b', TenantStatus.ACTIVE, agentLogin('shared'));
    await createOperator('suspended', TenantStatus.SUSPENDED, agentLogin('suspended'));
    await createOperator('closed', TenantStatus.CLOSED, agentLogin('closed'));
    await createOperator('deactivated', TenantStatus.ACTIVE, agentLogin('deactivated'));
    await createOperator('demoted', TenantStatus.ACTIVE, agentLogin('demoted'));
    await createOperator('named', TenantStatus.ACTIVE, agentLogin('named'));
    await createOperator('oldest', TenantStatus.ACTIVE, agentLogin('oldest'));
    // Same login as `solo` would be ambiguous; a different password on the same login is not a match.
    await createOperator('other-password', TenantStatus.ACTIVE, agentLogin('race'), WRONG_PASSWORD);

    // The principal was deactivated, or demoted: the operator has staff, but no active SUPER_ADMIN.
    await createAdmin(tenantId('deactivated'), agentLogin('deactivated'), AdminRole.SUPER_ADMIN, {
      isActive: false,
    });
    await createAdmin(tenantId('demoted'), agentLogin('demoted'), AdminRole.FINANCE_ADMIN);
  });

  afterAll(async () => {
    if (ctx === undefined) return;
    await ctx.reset();
    await removeSuiteOperators();
    await ctx.close();
  });

  beforeEach(async () => {
    // Throttle counters and the identity cache live in Redis; every test starts with neither.
    await ctx.redis.flush();
  });

  it('creates the agent principal on the first sign-in, once, and its session works on a guarded route', async () => {
    const solo = tenantId('solo');
    const first = await viaIchancy({
      username: `  ${agentLogin('solo')} `,
      password: AGENT_PASSWORD,
    }).expect(200);

    const session = adminSessionSchema.parse(first.body.data);
    expect(first.body.data).toMatchObject({
      admin: { role: 'SUPER_ADMIN', telegramUserId: '0', displayName: 'P13 solo' },
      tenantId: solo,
      tenantSlug: slugOf('solo'),
    });

    const staff = await staffOf(solo);
    expect(staff).toHaveLength(1);
    expect(staff[0]).toMatchObject({
      id: session.admin.id,
      username: agentLogin('solo').toLowerCase(),
      telegramUserId: 0n,
      role: AdminRole.SUPER_ADMIN,
      isActive: true,
      passwordHash: null,
    });
    expect(staff[0]?.lastLoginAt).not.toBeNull();

    const created = await principalAudits(solo);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ actorType: 'SYSTEM', actorId: null, entityId: session.admin.id });
    const logins = await prisma.auditLog.findMany({
      where: { tenantId: solo, action: 'admin.login', entityId: session.admin.id },
    });
    expect(logins).toHaveLength(1);
    expect(JSON.stringify(logins[0]?.after)).toContain('ichancy-agent');
    expect(
      JSON.stringify([...created, ...logins], (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain(AGENT_PASSWORD);

    // The second sign-in reuses the principal: still one row, still one creation.
    const second = await viaIchancy({ username: agentLogin('solo'), password: AGENT_PASSWORD }).expect(200);
    expect(second.body.data.admin.id).toBe(session.admin.id);
    expect(await staffOf(solo)).toHaveLength(1);
    expect(await principalAudits(solo)).toHaveLength(1);

    // A guarded SUPER_ADMIN route, resolved in the operator: its directory holds only the principal.
    const directory = await request(ctx.httpServer)
      .get('/v1/admin/admins')
      .set('authorization', `Bearer ${session.accessToken}`)
      .expect(200);
    const rows = z.array(adminUserSchema).parse(directory.body.data);
    expect(rows).toEqual([
      expect.objectContaining({
        id: session.admin.id,
        telegramUserId: '0',
        hasPassword: false,
        role: 'SUPER_ADMIN',
      }),
    ]);

    // Verified against the sealed password: Ichancy was never called.
    expect(fake.calls).toHaveLength(0);
  });

  it('answers an unknown agent, a wrong password, a CLOSED operator and a suspended one with a wrong password identically', async () => {
    const attempts = [
      { username: agentLogin('nobody'), password: AGENT_PASSWORD },
      { username: agentLogin('solo'), password: WRONG_PASSWORD },
      { username: agentLogin('closed'), password: AGENT_PASSWORD },
      // Nothing about the suspension is said before the password is right.
      { username: agentLogin('suspended'), password: WRONG_PASSWORD },
      // A placeholder login on an unconfigured row names no account.
      { username: 'unused', password: AGENT_PASSWORD },
      // A slug that is not one of the operators the credential opens.
      { username: agentLogin('solo'), password: AGENT_PASSWORD, operatorSlug: slugOf('race') },
    ];

    const bodies: unknown[] = [];
    for (const attempt of attempts) {
      bodies.push(errorOf(await viaIchancy(attempt).expect(401)));
    }

    expect(bodies[0]).toEqual({
      success: false,
      data: null,
      error: {
        code: 'AGENT_CREDENTIALS_INVALID',
        message: 'Those Ichancy credentials are not valid for any operator on this platform.',
      },
    });
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(await staffOf(tenantId('closed'))).toHaveLength(0);
  });

  it('asks which operator when two share the agent, then signs into the one chosen and no other', async () => {
    const question = await viaIchancy({
      username: agentLogin('shared'),
      password: AGENT_PASSWORD,
    }).expect(409);
    expect(question.body.error).toEqual({
      code: 'AGENT_OPERATOR_AMBIGUOUS',
      message: 'That Ichancy agent runs more than one operator. Choose which one to sign into.',
      details: {
        operators: [
          { slug: slugOf('shared-a'), displayName: 'P13 shared-a' },
          { slug: slugOf('shared-b'), displayName: 'P13 shared-b' },
        ],
      },
    });
    // A question creates nobody.
    expect(await staffOf(tenantId('shared-a'))).toHaveLength(0);

    const answer = await viaIchancy({
      username: agentLogin('shared'),
      password: AGENT_PASSWORD,
      operatorSlug: slugOf('shared-b').toUpperCase(),
    }).expect(200);
    expect(answer.body.data).toMatchObject({
      admin: { role: 'SUPER_ADMIN' },
      tenantId: tenantId('shared-b'),
      tenantSlug: slugOf('shared-b'),
    });
    expect(await staffOf(tenantId('shared-b'))).toHaveLength(1);
    expect(await staffOf(tenantId('shared-a'))).toHaveLength(0);
  });

  it('signs into the operator whose sealed password matches when two share a login with different passwords', async () => {
    // `race` and `other-password` share a login; only `other-password` holds WRONG_PASSWORD.
    const response = await viaIchancy({
      username: agentLogin('race'),
      password: WRONG_PASSWORD,
    }).expect(200);
    expect(response.body.data.tenantId).toBe(tenantId('other-password'));
  });

  it('refuses a suspended operator with 403 AGENT_OPERATOR_NOT_ACTIVE once the password is right', async () => {
    const response = await viaIchancy({
      username: agentLogin('suspended'),
      password: AGENT_PASSWORD,
    }).expect(403);

    expect(response.body.error).toEqual({
      code: 'AGENT_OPERATOR_NOT_ACTIVE',
      message:
        'That operator is suspended. A platform admin has to activate it before anyone can sign in.',
      details: { operators: [{ slug: slugOf('suspended'), displayName: 'P13 suspended' }] },
    });
    expect(await staffOf(tenantId('suspended'))).toHaveLength(0);
  });

  it('refuses AGENT_OPERATOR_HAS_NO_OWNER when the principal was deactivated or demoted, and mints no replacement', async () => {
    for (const name of ['deactivated', 'demoted']) {
      const response = await viaIchancy({
        username: agentLogin(name),
        password: AGENT_PASSWORD,
      }).expect(403);
      expect(response.body.error).toMatchObject({ code: 'AGENT_OPERATOR_HAS_NO_OWNER' });
      expect(await staffOf(tenantId(name))).toHaveLength(1);
      expect(await principalAudits(tenantId(name))).toHaveLength(0);
    }
  });

  it('becomes the SUPER_ADMIN named like the agent login, else the oldest active one — never another role', async () => {
    const named = tenantId('named');
    await createAdmin(named, `p13-${RUN}-first-owner`, AdminRole.SUPER_ADMIN, {
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const namedOwner = await createAdmin(named, agentLogin('named'), AdminRole.SUPER_ADMIN, {
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });

    const oldest = tenantId('oldest');
    const firstOwner = await createAdmin(oldest, `p13-${RUN}-owner-a`, AdminRole.SUPER_ADMIN, {
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    await createAdmin(oldest, `p13-${RUN}-owner-b`, AdminRole.SUPER_ADMIN, {
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });
    // Named like the agent, but not a SUPER_ADMIN: never chosen.
    await createAdmin(oldest, agentLogin('oldest'), AdminRole.FINANCE_ADMIN, {
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });

    const toNamed = await viaIchancy({ username: agentLogin('named'), password: AGENT_PASSWORD }).expect(200);
    expect(toNamed.body.data.admin).toMatchObject({ id: namedOwner, role: 'SUPER_ADMIN' });

    const toOldest = await viaIchancy({ username: agentLogin('oldest'), password: AGENT_PASSWORD }).expect(200);
    expect(toOldest.body.data.admin).toMatchObject({ id: firstOwner, role: 'SUPER_ADMIN' });

    expect(await principalAudits(named)).toHaveLength(0);
    expect(await principalAudits(oldest)).toHaveLength(0);
  });

  it('creates exactly one principal when first sign-ins race, and every racer signs into it', async () => {
    const race = tenantId('race');
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        viaIchancy({ username: agentLogin('race'), password: AGENT_PASSWORD }),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual(Array.from({ length: 6 }, () => 200));
    const adminIds = new Set(responses.map((response) => String(response.body.data.admin.id)));
    expect(adminIds.size).toBe(1);

    const staff = await staffOf(race);
    expect(staff).toHaveLength(1);
    expect(adminIds.has(staff[0]?.id ?? '')).toBe(true);
    expect(await principalAudits(race)).toHaveLength(1);
  });

  it('/credentials falls back to the agent account and answers exactly the shape a console password does', async () => {
    const consoleHash = await hasher.hash(CONSOLE_PASSWORD);
    await createAdmin(TENANT_BOOTSTRAP_ID, agentLogin('console'), AdminRole.REVIEWER, {
      passwordHash: consoleHash,
    });

    const byConsole = await viaCredentials({
      username: agentLogin('console'),
      password: CONSOLE_PASSWORD,
    }).expect(200);
    const byAgent = await viaCredentials({
      username: agentLogin('viacreds'),
      password: AGENT_PASSWORD,
    }).expect(200);

    adminSessionSchema.parse(byAgent.body.data);
    expect(byAgent.body.data).toMatchObject({
      admin: { role: 'SUPER_ADMIN', telegramUserId: '0' },
      tenantId: tenantId('viacreds'),
      tenantSlug: slugOf('viacreds'),
    });
    // Nothing in the body says which credential answered: the same keys, at every level.
    const keysOf = (value: unknown): string[] =>
      typeof value === 'object' && value !== null ? Object.keys(value).sort() : [];
    expect(keysOf(byAgent.body)).toEqual(keysOf(byConsole.body));
    expect(keysOf(byAgent.body.data)).toEqual(keysOf(byConsole.body.data));
    expect(keysOf(byAgent.body.data.admin)).toEqual(keysOf(byConsole.body.data.admin));
    expect(keysOf(byAgent.body.meta)).toEqual(keysOf(byConsole.body.meta));

    // A miss on both is the console's one sentence, not the agent door's.
    const miss = await viaCredentials({
      username: agentLogin('viacreds'),
      password: WRONG_PASSWORD,
    }).expect(401);
    expect(miss.body.error).toEqual({
      code: 'ADMIN_CREDENTIALS_INVALID',
      message: 'Those credentials are not valid for any administrator on this platform.',
    });

    // What is said after the agent account matched keeps its AGENT_ code, and the slug retry works.
    const question = await viaCredentials({
      username: agentLogin('shared'),
      password: AGENT_PASSWORD,
    }).expect(409);
    expect(question.body.error.code).toBe('AGENT_OPERATOR_AMBIGUOUS');
    const answer = await viaCredentials({
      username: agentLogin('shared'),
      password: AGENT_PASSWORD,
      operatorSlug: slugOf('shared-a'),
    }).expect(200);
    expect(answer.body.data.tenantId).toBe(tenantId('shared-a'));

    const suspended = await viaCredentials({
      username: agentLogin('suspended'),
      password: AGENT_PASSWORD,
    }).expect(403);
    expect(suspended.body.error.code).toBe('AGENT_OPERATOR_NOT_ACTIVE');

    expect(fake.calls).toHaveLength(0);
  });

  it('throttles /ichancy like /credentials: the 11th attempt in a minute is blocked, even with the right password', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await viaIchancy({ username: agentLogin('nobody'), password: WRONG_PASSWORD });
      statuses.push(response.status);
    }
    expect(statuses).toEqual(Array.from({ length: 10 }, () => 401));

    const blocked = await viaIchancy({ username: agentLogin('solo'), password: AGENT_PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(60);
  });

  // Both doors test the same agent password (/credentials falls back to it), so they must share one
  // budget: blocking one door while the other stays open would double the guesses per minute.
  it.each([
    ['/credentials', '/ichancy'],
    ['/ichancy', '/credentials'],
  ])(
    'shares one sign-in budget across both doors: 10 misses on %s block the right password on %s',
    async (spentOn, triedOn) => {
      const door = (path: string): typeof viaIchancy =>
        path === '/ichancy' ? viaIchancy : viaCredentials;

      const statuses: number[] = [];
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await door(spentOn)({
          username: agentLogin('nobody'),
          password: WRONG_PASSWORD,
        });
        statuses.push(response.status);
      }
      expect(statuses).toEqual(Array.from({ length: 10 }, () => 401));

      const blocked = await door(triedOn)({
        username: agentLogin('solo'),
        password: AGENT_PASSWORD,
      });
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(60);

      // Blocked on the door it was spent on too: one budget, one block.
      const alsoBlocked = await door(spentOn)({
        username: agentLogin('solo'),
        password: AGENT_PASSWORD,
      });
      expect(alsoBlocked.status).toBe(429);
      expect(fake.calls).toHaveLength(0);
    },
  );
});
