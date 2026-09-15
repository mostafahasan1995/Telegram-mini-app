/**
 * The staff directory (API-CONTRACT.md "Admin directory", §3 `mayGrantRole`) through the REAL api:
 * the global ValidationPipe with `forbidNonWhitelisted`, the guards, the tenant override interceptor,
 * the scrypt hasher and Postgres' unique indexes.
 *
 * What only this level can prove:
 *  - a client still sending `telegramUserId` gets a 400, not a silently ignored field;
 *  - what the console receives parses with its own `adminUserSchema`, and an account created here
 *    can actually sign in with the password as typed (spaces included);
 *  - "Add me as an admin here" writes into the operator X-Tenant-Id names, and audits it there;
 *  - the role-grant, self-modification and last-super-admin refusals reach the wire with their codes.
 *
 * Run with the escape hatch (no testcontainers):
 *   POSTGRES_TEST_URL=... REDIS_TEST_URL=... npx jest --config jest-int.config.cjs --runInBand \
 *     src/modules/admin/admin-user.int.spec.ts
 */
import { AdminRole, TenantStatus } from '@prisma/client';
import request from 'supertest';
import { z } from 'zod';

import type { PasswordHasherService } from '@core/auth/services/password-hasher.service';
import type { PrismaService } from '@core/prisma/prisma.service';
import { TENANT_BOOTSTRAP_ID, TENANT_HEADER, TENANT_ZERO_ID } from '@core/tenant/tenant.constants';

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
const SLUG_PREFIX = 'p13-staff-';
const PASSWORD = 'Staff-Horse-77';
const login = (name: string): string => `p13s-${RUN}-${name}`;

describe('/v1/admin/admins (integration)', () => {
  let ctx: TestApp;
  let prisma: PrismaService;
  let hasher: PasswordHasherService;

  let targetTenantId: string;
  let loneOwnerTenantId: string;
  let loneOwnerId: string;
  let ownerId: string;
  let deputyId: string;
  let platformAdminId: string;
  let victimTenantId: string;
  let victimOwnerId: string;
  let victimFinanceId: string;
  let victimLimitId: string;
  const bearer: Record<'owner' | 'finance' | 'platform', string> = {
    owner: '',
    finance: '',
    platform: '',
  };

  const signIn = (username: string, password: string): request.Test =>
    request(ctx.httpServer).post('/v1/admin/auth/credentials').send({ username, password });

  const as = (who: keyof typeof bearer) => ({
    post: (path: string) =>
      request(ctx.httpServer).post(path).set('authorization', `Bearer ${bearer[who]}`),
    patch: (path: string) =>
      request(ctx.httpServer).patch(path).set('authorization', `Bearer ${bearer[who]}`),
    delete: (path: string) =>
      request(ctx.httpServer).delete(path).set('authorization', `Bearer ${bearer[who]}`),
    get: (path: string) =>
      request(ctx.httpServer).get(path).set('authorization', `Bearer ${bearer[who]}`),
  });

  const removeSuiteOperators = async (): Promise<void> => {
    // Limits first: their FK to admin_users is RESTRICT, which a tenant cascade can trip over.
    await prisma.adminApprovalLimit.deleteMany({
      where: { tenant: { slug: { startsWith: SLUG_PREFIX } } },
    });
    await prisma.tenant.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
  };

  const createOperator = async (name: string): Promise<string> => {
    const tenant = await prisma.tenant.create({
      data: {
        slug: `${SLUG_PREFIX}${RUN}-${name}`,
        displayName: `P13 ${name}`,
        status: TenantStatus.ACTIVE,
        botTokenEnc: 'P13-INT-NO-BOT',
        adminChatId: 0n,
        ichancyBaseUrl: 'https://example.invalid',
        ichancyUsername: 'unused',
        ichancyPasswordEnc: 'P13-INT-NO-AGENT',
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
  ): Promise<string> => {
    const admin = await prisma.adminUser.create({
      data: {
        tenantId,
        username,
        displayName: `P13 ${username}`,
        role,
        passwordHash,
        telegramUserId: null,
      },
      select: { id: true },
    });
    return admin.id;
  };

  const tokenFor = async (username: string): Promise<string> => {
    const response = await signIn(username, PASSWORD).expect(200);
    return String(response.body.data.accessToken);
  };

  beforeAll(async () => {
    ctx = await createTestApp();

    const { PrismaService: PrismaServiceClass } = await import('@core/prisma/prisma.service');
    const { PasswordHasherService: HasherClass } = await import(
      '@core/auth/services/password-hasher.service'
    );
    prisma = ctx.app.get(PrismaServiceClass);
    hasher = ctx.app.get(HasherClass);

    await ctx.reset();
    await removeSuiteOperators();

    const hash = await hasher.hash(PASSWORD);
    ownerId = await createAdmin(TENANT_BOOTSTRAP_ID, login('owner'), AdminRole.SUPER_ADMIN, hash);
    deputyId = await createAdmin(TENANT_BOOTSTRAP_ID, login('deputy'), AdminRole.SUPER_ADMIN, hash);
    await createAdmin(TENANT_BOOTSTRAP_ID, login('finance'), AdminRole.FINANCE_ADMIN, hash);
    platformAdminId = await createAdmin(
      TENANT_ZERO_ID,
      login('platform'),
      AdminRole.PLATFORM_ADMIN,
      hash,
    );

    targetTenantId = await createOperator('target');
    loneOwnerTenantId = await createOperator('lone-owner');
    loneOwnerId = await createAdmin(loneOwnerTenantId, login('lone'), AdminRole.SUPER_ADMIN, null);

    // Another operator whose staff the bootstrap operator's owner must not reach.
    victimTenantId = await createOperator('victim');
    victimOwnerId = await createAdmin(victimTenantId, login('victim-owner'), AdminRole.SUPER_ADMIN, hash);
    victimFinanceId = await createAdmin(
      victimTenantId,
      login('victim-finance'),
      AdminRole.FINANCE_ADMIN,
      hash,
    );
    victimLimitId = (
      await prisma.adminApprovalLimit.create({
        data: {
          tenantId: victimTenantId,
          adminUserId: victimFinanceId,
          currencyCode: 'NSP',
          maxSingleApprovalMinor: 1_000n,
          maxDailyApprovalMinor: 5_000n,
        },
        select: { id: true },
      })
    ).id;

    await ctx.redis.flush();
    bearer.owner = await tokenFor(login('owner'));
    bearer.finance = await tokenFor(login('finance'));
    bearer.platform = await tokenFor(login('platform'));
  });

  afterAll(async () => {
    if (ctx === undefined) return;
    await ctx.reset();
    await removeSuiteOperators();
    await ctx.close();
  });

  beforeEach(async () => {
    // Sign-in throttle counters and the identity cache live in Redis.
    await ctx.redis.flush();
  });

  it('creates a username+password account the console parses, stored hashed and lower-cased, that signs in as typed', async () => {
    const typedPassword = '  spaced pass  ';
    const response = await as('owner')
      .post('/v1/admin/admins')
      .send({
        displayName: 'New Reviewer',
        role: 'REVIEWER',
        username: ` ${login('New.Staff')}@Example.com `,
        password: typedPassword,
      })
      .expect(201);

    const view = adminUserSchema.parse(response.body.data);
    expect(view).toMatchObject({
      username: `${login('new.staff')}@example.com`,
      telegramUserId: null,
      hasPassword: true,
      role: 'REVIEWER',
      isActive: true,
      lastLoginAt: null,
    });
    expect(response.body.data).not.toHaveProperty('passwordHash');

    const row = await prisma.adminUser.findUniqueOrThrow({ where: { id: view.id } });
    expect(row.tenantId).toBe(TENANT_BOOTSTRAP_ID);
    expect(row.passwordHash).toMatch(/^\$scrypt\$/);

    const audits = await prisma.auditLog.findMany({
      where: { tenantId: TENANT_BOOTSTRAP_ID, action: 'admin.user.created', entityId: view.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorId).toBe(ownerId);
    const auditText = JSON.stringify(audits[0]?.after);
    expect(auditText).not.toContain('spaced pass');
    expect(auditText).not.toContain('$scrypt$');

    // Never trimmed: the spaces are part of the password.
    await signIn(`${login('new.staff')}@example.com`, typedPassword).expect(200);
    await signIn(`${login('new.staff')}@example.com`, typedPassword.trim()).expect(401);
  });

  it('refuses telegramUserId outright, and usernames and passwords outside the contract, with 400', async () => {
    const valid = {
      displayName: 'Valid',
      role: 'VIEWER',
      username: login('valid'),
      password: PASSWORD,
    };
    const invalid: Record<string, unknown>[] = [
      { ...valid, telegramUserId: '912911246' },
      { ...valid, username: 'ab' },
      { ...valid, username: 'has space' },
      { ...valid, username: 'x'.repeat(65) },
      { ...valid, username: 'bad/slash' },
      { ...valid, password: 'short77' },
      { ...valid, password: 'p'.repeat(73) },
      { displayName: 'No password', role: 'VIEWER', username: login('nopass') },
      { displayName: 'No username', role: 'VIEWER', password: PASSWORD },
    ];

    for (const body of invalid) {
      const response = await as('owner').post('/v1/admin/admins').send(body);
      expect({ body, status: response.status, code: response.body.error?.code }).toEqual({
        body,
        status: 400,
        code: 'VALIDATION_FAILED',
      });
      // A refusal never echoes the password it was given.
      expect(JSON.stringify(response.body)).not.toContain(PASSWORD);
    }
    expect(await prisma.adminUser.count({ where: { username: login('valid') } })).toBe(0);

    // The bounds are inclusive: 3 and 64 characters, 8 and 72.
    await as('owner')
      .post('/v1/admin/admins')
      .send({ ...valid, username: `${RUN}-${'u'.repeat(63 - RUN.length)}`, password: 'p'.repeat(72) })
      .expect(201);
    await as('owner')
      .post('/v1/admin/admins')
      .send({ ...valid, username: 'a.b', password: 'p'.repeat(8) })
      .expect(201);
  });

  it('answers a username taken in the operator with 409 ADMIN_ALREADY_EXISTS, whatever its case', async () => {
    const body = { displayName: 'Dup', role: 'SUPPORT', password: PASSWORD };
    await as('owner').post('/v1/admin/admins').send({ ...body, username: login('dup') }).expect(201);

    const again = await as('owner')
      .post('/v1/admin/admins')
      .send({ ...body, username: login('DUP').toUpperCase() })
      .expect(409);
    expect(again.body.error.code).toBe('ADMIN_ALREADY_EXISTS');
  });

  it('PATCH changes role, name and username, sets a new password, and leaves a blank one unchanged', async () => {
    const created = await as('owner')
      .post('/v1/admin/admins')
      .send({ displayName: 'Editable', role: 'VIEWER', username: login('editable'), password: PASSWORD })
      .expect(201);
    const id = String(created.body.data.id);
    const before = await prisma.adminUser.findUniqueOrThrow({ where: { id } });

    const blank = await as('owner')
      .patch(`/v1/admin/admins/${id}`)
      .send({ displayName: 'Edited', role: 'FINANCE_ADMIN', username: login('Renamed'), password: '' })
      .expect(200);
    expect(adminUserSchema.parse(blank.body.data)).toMatchObject({
      displayName: 'Edited',
      role: 'FINANCE_ADMIN',
      username: login('renamed'),
      hasPassword: true,
    });
    expect((await prisma.adminUser.findUniqueOrThrow({ where: { id } })).passwordHash).toBe(
      before.passwordHash,
    );

    await as('owner').patch(`/v1/admin/admins/${id}`).send({ password: 'short77' }).expect(400);

    const newPassword = 'A brand new one 1';
    await as('owner').patch(`/v1/admin/admins/${id}`).send({ password: newPassword }).expect(200);
    await signIn(login('renamed'), newPassword).expect(200);

    const audit = await prisma.auditLog.findMany({
      where: { tenantId: TENANT_BOOTSTRAP_ID, action: 'admin.user.updated', entityId: id },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit.map((row) => row.after))).not.toContain(newPassword);
    expect(audit[1]?.after).toMatchObject({ passwordChanged: true });

    // Renaming onto a taken username is the same conflict as creating one.
    const clash = await as('owner')
      .patch(`/v1/admin/admins/${id}`)
      .send({ username: login('deputy') })
      .expect(409);
    expect(clash.body.error.code).toBe('ADMIN_ALREADY_EXISTS');
  });

  it('refuses every change to your own record, and deactivating yourself, with 422 ADMIN_SELF_MODIFICATION', async () => {
    for (const body of [{ displayName: 'Me again' }, { password: 'My new password 1' }, { role: 'VIEWER' }]) {
      const response = await as('owner').patch(`/v1/admin/admins/${ownerId}`).send(body).expect(422);
      expect(response.body.error.code).toBe('ADMIN_SELF_MODIFICATION');
    }
    const deactivate = await as('owner').delete(`/v1/admin/admins/${ownerId}`).expect(422);
    expect(deactivate.body.error.code).toBe('ADMIN_SELF_MODIFICATION');

    const unchanged = await prisma.adminUser.findUniqueOrThrow({ where: { id: ownerId } });
    expect(unchanged).toMatchObject({ displayName: `P13 ${login('owner')}`, role: 'SUPER_ADMIN', isActive: true });
  });

  it('grants PLATFORM_ADMIN only from the platform itself, and keeps readers out of writes', async () => {
    const platformBody = {
      displayName: 'Second platform admin',
      role: 'PLATFORM_ADMIN',
      username: login('platform-two'),
      password: PASSWORD,
    };

    // An operator's SUPER_ADMIN may write staff, but not this role — neither on create nor by PATCH.
    const fromOwner = await as('owner').post('/v1/admin/admins').send(platformBody).expect(403);
    expect(fromOwner.body.error.code).toBe('ADMIN_ROLE_NOT_GRANTABLE');
    const promote = await as('owner')
      .patch(`/v1/admin/admins/${deputyId}`)
      .send({ role: 'PLATFORM_ADMIN' })
      .expect(403);
    expect(promote.body.error.code).toBe('ADMIN_ROLE_NOT_GRANTABLE');

    // Platform staff switched into an operator: the row would be a tenant login with platform reach.
    const inOperator = await as('platform')
      .post('/v1/admin/admins')
      .set(TENANT_HEADER, targetTenantId)
      .send(platformBody)
      .expect(403);
    expect(inOperator.body.error.code).toBe('ADMIN_ROLE_NOT_GRANTABLE');
    expect(await prisma.adminUser.count({ where: { username: login('platform-two') } })).toBe(0);

    // In tenant zero with no override, it is allowed.
    const granted = await as('platform').post('/v1/admin/admins').send(platformBody).expect(201);
    expect(granted.body.data.role).toBe('PLATFORM_ADMIN');
    expect(
      (await prisma.adminUser.findUniqueOrThrow({ where: { id: String(granted.body.data.id) } }))
        .tenantId,
    ).toBe(TENANT_ZERO_ID);

    // FINANCE_ADMIN reads the directory but writes nothing in it.
    await as('finance').get('/v1/admin/admins').expect(200);
    await as('finance')
      .post('/v1/admin/admins')
      .send({ displayName: 'Nope', role: 'VIEWER', username: login('nope'), password: PASSWORD })
      .expect(403);
  });

  it('"Add me as an admin here": a PLATFORM_ADMIN with X-Tenant-Id creates staff in that operator, who can sign in there', async () => {
    const body = {
      displayName: 'Platform Person',
      role: 'SUPER_ADMIN',
      username: `${login('me')}@example.com`,
      password: PASSWORD,
    };
    const created = await as('platform')
      .post('/v1/admin/admins')
      .set(TENANT_HEADER, targetTenantId)
      .send(body)
      .expect(201);
    const view = adminUserSchema.parse(created.body.data);
    expect(view).toMatchObject({ role: 'SUPER_ADMIN', telegramUserId: null, hasPassword: true });

    const row = await prisma.adminUser.findUniqueOrThrow({ where: { id: view.id } });
    expect(row.tenantId).toBe(targetTenantId);
    const audit = await prisma.auditLog.findMany({
      where: { action: 'admin.user.created', entityId: view.id },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ tenantId: targetTenantId, actorId: platformAdminId });

    // Already an admin there is the console's "exists" outcome.
    const again = await as('platform')
      .post('/v1/admin/admins')
      .set(TENANT_HEADER, targetTenantId)
      .send(body)
      .expect(409);
    expect(again.body.error.code).toBe('ADMIN_ALREADY_EXISTS');

    // The new login opens the target operator, and its directory is that operator's.
    const session = await signIn(body.username, PASSWORD).expect(200);
    expect(session.body.data.tenantId).toBe(targetTenantId);
    const directory = await request(ctx.httpServer)
      .get('/v1/admin/admins')
      .set('authorization', `Bearer ${String(session.body.data.accessToken)}`)
      .expect(200);
    const directoryIds = z.array(adminUserSchema).parse(directory.body.data).map((entry) => entry.id);
    expect(directoryIds).toEqual([view.id]);
  });

  it('keeps the last active SUPER_ADMIN of an operator, even against the platform admin', async () => {
    const response = await as('platform')
      .delete(`/v1/admin/admins/${loneOwnerId}`)
      .set(TENANT_HEADER, loneOwnerTenantId)
      .expect(422);
    expect(response.body.error.code).toBe('ADMIN_LAST_SUPER_ADMIN');
    expect((await prisma.adminUser.findUniqueOrThrow({ where: { id: loneOwnerId } })).isActive).toBe(
      true,
    );
  });

  it("keeps one operator out of another operator's staff and approval limits: 404, nothing written, the old password still signs in", async () => {
    const hijack = 'Hijacked-Pass-99';
    const victimRows = (): Promise<unknown[]> =>
      prisma.adminUser.findMany({
        where: { id: { in: [victimOwnerId, victimFinanceId] } },
        orderBy: { id: 'asc' },
      });
    const victimAudits = (): Promise<number> =>
      prisma.auditLog.count({ where: { entityId: { in: [victimOwnerId, victimFinanceId, victimLimitId] } } });
    const expectNotFound = (response: request.Response, code: string, probe: string): void => {
      expect({ probe, status: response.status, code: response.body.error?.code }).toEqual({
        probe,
        status: 404,
        code,
      });
    };

    const rowsBefore = await victimRows();
    const auditsBefore = await victimAudits();

    // An operator's SUPER_ADMIN, by id, on every verb the directory has.
    expectNotFound(await as('owner').get(`/v1/admin/admins/${victimOwnerId}`), 'ADMIN_NOT_FOUND', 'GET');
    for (const body of [
      { password: hijack },
      { role: 'VIEWER' },
      { isActive: false },
      { username: login('hijacked') },
      { displayName: 'Hijacked' },
    ]) {
      const response = await as('owner').patch(`/v1/admin/admins/${victimOwnerId}`).send(body);
      expectNotFound(response, 'ADMIN_NOT_FOUND', `PATCH ${Object.keys(body).join()}`);
    }
    expectNotFound(
      await as('owner').delete(`/v1/admin/admins/${victimFinanceId}`),
      'ADMIN_NOT_FOUND',
      'DELETE',
    );

    // Approval limits hang off the same ids: raising or ending another operator's ceiling is refused.
    expectNotFound(
      await as('owner')
        .post(`/v1/admin/admins/${victimFinanceId}/approval-limits`)
        .send({ currencyCode: 'NSP', maxSingleApproval: '999999', maxDailyApproval: '999999' }),
      'ADMIN_NOT_FOUND',
      'POST approval-limits',
    );
    expectNotFound(
      await as('owner').delete(`/v1/admin/approval-limits/${victimLimitId}`),
      'APPROVAL_LIMIT_NOT_FOUND',
      'DELETE approval-limits',
    );
    const listed = await as('owner').get(`/v1/admin/admins/${victimFinanceId}/approval-limits`).expect(200);
    expect(listed.body.data).toEqual([]);

    // A PLATFORM_ADMIN working in the platform itself does not reach operator staff by id either.
    expectNotFound(
      await as('platform').get(`/v1/admin/admins/${victimOwnerId}`),
      'ADMIN_NOT_FOUND',
      'platform GET',
    );
    expectNotFound(
      await as('platform').patch(`/v1/admin/admins/${victimOwnerId}`).send({ password: hijack }),
      'ADMIN_NOT_FOUND',
      'platform PATCH',
    );

    // Nothing was written: rows, audit trail and limits are exactly as they were.
    expect(await victimRows()).toEqual(rowsBefore);
    expect(await victimAudits()).toBe(auditsBefore);
    const limits = await prisma.adminApprovalLimit.findMany({ where: { adminUserId: victimFinanceId } });
    expect(limits.map((limit) => [limit.id, limit.effectiveTo])).toEqual([[victimLimitId, null]]);

    // The victim still signs in with the old password, and never with the attempted one.
    const victim = await signIn(login('victim-owner'), PASSWORD).expect(200);
    expect(victim.body.data.tenantId).toBe(victimTenantId);
    await signIn(login('victim-owner'), hijack).expect(401);

    // With X-Tenant-Id naming that operator, the platform admin does reach it.
    await as('platform')
      .get(`/v1/admin/admins/${victimFinanceId}`)
      .set(TENANT_HEADER, victimTenantId)
      .expect(200);
    const renamed = await as('platform')
      .patch(`/v1/admin/admins/${victimFinanceId}`)
      .set(TENANT_HEADER, victimTenantId)
      .send({ displayName: 'Renamed by platform' })
      .expect(200);
    expect(renamed.body.data.displayName).toBe('Renamed by platform');
    await as('platform')
      .delete(`/v1/admin/approval-limits/${victimLimitId}`)
      .set(TENANT_HEADER, victimTenantId)
      .expect(200);
  });
});
