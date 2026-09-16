/**
 * The first-run bootstrap end to end: the seed's own function against REAL Postgres, then the REAL
 * api signing in as the account it wrote.
 *
 * What only this level can prove:
 *  - one PLATFORM_ADMIN lands in tenant zero (where prisma/sql/006 insists it lives), with a hash the
 *    app's own sign-in accepts and no approval limit;
 *  - re-runs are idempotent against the database: unchanged leaves the hash byte-identical, the
 *    reset flag replaces it, a deactivated owner is re-armed;
 *  - created and updated are audited in tenant zero's log, and the log never holds the password or
 *    the hash;
 *  - POST /v1/admin/auth/credentials signs the seeded admin into tenant zero, and its token reaches
 *    another operator's admin route through X-Tenant-Id.
 *
 * Run with the escape hatch (no testcontainers):
 *   POSTGRES_TEST_URL=... REDIS_TEST_URL=... npx jest --config jest-int.config.cjs --runInBand \
 *     test/seed/platform-admin.seed.int.spec.ts
 */
import { ActorType, AdminRole } from '@prisma/client';
import request from 'supertest';

import type { PasswordHasherService } from '@core/auth/services/password-hasher.service';
import type { PrismaService } from '@core/prisma/prisma.service';
import {
  TENANT_BOOTSTRAP_ID,
  TENANT_HEADER,
  TENANT_ZERO_ID,
  TENANT_ZERO_SLUG,
} from '@core/tenant/tenant.constants';

import type { SeedClient } from '../../prisma/seed/client';
import type * as PlatformAdminSeed from '../../prisma/seed/platform-admin.seed';
import { createTestApp, type TestApp } from '../setup/app-factory';

jest.setTimeout(180_000);

const PASSWORD = 'Correct-Horse-9 first';
const NEW_PASSWORD = 'Correct-Horse-9 second';
const USERNAME = 'p5-owner';

describe('seed:platform-admin (integration)', () => {
  let ctx: TestApp;
  let prisma: PrismaService;
  let seedClient: SeedClient;
  let seed: typeof PlatformAdminSeed;
  let hasher: PasswordHasherService;

  /** Exactly what the script does with its environment. */
  const run = async (env: Record<string, string>): Promise<PlatformAdminSeed.SeededPlatformAdmin> =>
    seed.seedPlatformAdmin(seedClient.prisma, seed.readPlatformAdminInput(env), hasher);

  const signIn = (username: string, password: string): request.Test =>
    request(ctx.httpServer).post('/v1/admin/auth/credentials').send({ username, password });

  const storedRow = (id: string) =>
    prisma.adminUser.findUniqueOrThrow({
      where: { id },
      select: { passwordHash: true, isActive: true, role: true, username: true, displayName: true },
    });

  const auditsFor = (id: string) =>
    prisma.auditLog.findMany({
      where: { tenantId: TENANT_ZERO_ID, entityType: 'AdminUser', entityId: id },
      orderBy: { createdAt: 'asc' },
    });

  const serialized = (value: unknown): string =>
    JSON.stringify(value, (_key, member: unknown) =>
      typeof member === 'bigint' ? member.toString() : member,
    );

  beforeAll(async () => {
    ctx = await createTestApp();

    // Dynamic, like the harness itself: these modules must load after the test env exists.
    const { PrismaService: PrismaServiceClass } = await import('@core/prisma/prisma.service');
    const { PasswordHasherService: HasherClass } =
      await import('@core/auth/services/password-hasher.service');
    const { createSeedClient } = await import('../../prisma/seed/client');
    seed = await import('../../prisma/seed/platform-admin.seed');

    prisma = ctx.app.get(PrismaServiceClass);
    // The app's own hasher at the production cost — the one the script constructs.
    hasher = ctx.app.get(HasherClass);
    // The seed's own client, not the app's: the script never has the tenant-scope extension.
    seedClient = createSeedClient({ SEED_DATABASE_URL: ctx.postgres.url });

    await ctx.reset();
  });

  afterAll(async () => {
    if (ctx === undefined) return;
    await seedClient?.close();
    await ctx.reset();
    await ctx.close();
  });

  beforeEach(async () => {
    // Throttle counters and the identity cache both live in Redis.
    await ctx.redis.flush();
  });

  it('creates one PLATFORM_ADMIN in tenant zero, then reports unchanged and keeps the hash', async () => {
    const env = {
      SEED_PLATFORM_ADMIN_USERNAME: '  P5-Owner ',
      SEED_PLATFORM_ADMIN_PASSWORD: PASSWORD,
    };

    const first = await run(env);
    expect(first).toMatchObject({ username: USERNAME, outcome: 'created' });

    const rows = await prisma.adminUser.findMany({
      where: { tenantId: TENANT_ZERO_ID, username: USERNAME },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.adminUserId,
      role: AdminRole.PLATFORM_ADMIN,
      isActive: true,
      displayName: 'Owner',
      telegramUserId: null,
    });
    const hash = rows[0]?.passwordHash ?? '';
    expect(hash.startsWith('$scrypt$')).toBe(true);
    await expect(hasher.verify(PASSWORD, hash)).resolves.toEqual({ ok: true, needsRehash: false });

    // Platform staff are exempt from approval limits, so none is written.
    await expect(
      prisma.adminApprovalLimit.count({ where: { adminUserId: first.adminUserId } }),
    ).resolves.toBe(0);

    const second = await run(env);
    expect(second).toEqual({
      adminUserId: first.adminUserId,
      username: USERNAME,
      outcome: 'unchanged',
    });
    expect((await storedRow(first.adminUserId)).passwordHash).toBe(hash);

    const audits = await auditsFor(first.adminUserId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'admin.user.created',
      actorType: ActorType.SYSTEM,
      actorId: null,
    });
    expect(serialized(audits)).toContain('seed:platform-admin');
    expect(serialized(audits)).not.toContain(PASSWORD);
    expect(serialized(audits)).not.toContain('$scrypt$');
  });

  it('signs the seeded admin into tenant zero, and its token reaches an operator with X-Tenant-Id', async () => {
    const response = await signIn('P5-OWNER', PASSWORD).expect(200);
    expect(response.body.data).toMatchObject({
      admin: { role: 'PLATFORM_ADMIN', telegramUserId: null, displayName: 'Owner' },
      tenantId: TENANT_ZERO_ID,
      tenantSlug: TENANT_ZERO_SLUG,
    });
    const bearer = `Bearer ${response.body.data.accessToken as string}`;
    const platformAdminId = response.body.data.admin.id as string;

    const reached = await request(ctx.httpServer)
      .get('/v1/admin/admins')
      .set('authorization', bearer)
      .set(TENANT_HEADER, TENANT_BOOTSTRAP_ID)
      .expect(200);
    expect(Array.isArray(reached.body.data)).toBe(true);
    // The bootstrap operator's directory, not the platform's: the platform admin is not in it.
    expect((reached.body.data as { id: string }[]).map((row) => row.id)).not.toContain(
      platformAdminId,
    );
  });

  it('re-arms a deactivated admin, and replaces the password only with the reset flag', async () => {
    const [existing] = await prisma.adminUser.findMany({
      where: { tenantId: TENANT_ZERO_ID, username: USERNAME },
      select: { id: true, passwordHash: true },
    });
    if (existing === undefined) throw new Error('the first test seeds the admin');
    const originalHash = existing.passwordHash;

    await prisma.adminUser.update({ where: { id: existing.id }, data: { isActive: false } });

    // Re-armed; a different password without the flag is not a request to change it.
    await expect(
      run({ SEED_PLATFORM_ADMIN_USERNAME: USERNAME, SEED_PLATFORM_ADMIN_PASSWORD: NEW_PASSWORD }),
    ).resolves.toMatchObject({ outcome: 'updated' });
    expect(await storedRow(existing.id)).toMatchObject({
      isActive: true,
      passwordHash: originalHash,
    });
    await signIn(USERNAME, NEW_PASSWORD).expect(401);

    await expect(
      run({
        SEED_PLATFORM_ADMIN_USERNAME: USERNAME,
        SEED_PLATFORM_ADMIN_PASSWORD: NEW_PASSWORD,
        SEED_PLATFORM_ADMIN_RESET_PASSWORD: '1',
      }),
    ).resolves.toMatchObject({ outcome: 'updated' });
    const reset = await storedRow(existing.id);
    expect(reset.passwordHash).not.toBe(originalHash);

    await signIn(USERNAME, PASSWORD).expect(401);
    await signIn(USERNAME, NEW_PASSWORD).expect(200);

    // Only the seed's own rows: the sign-ins in this suite add `admin.login` rows in between.
    const audits = (await auditsFor(existing.id)).filter((audit) =>
      audit.action.startsWith('admin.user.'),
    );
    expect(audits.map((audit) => audit.action)).toEqual([
      'admin.user.created',
      'admin.user.updated',
      'admin.user.updated',
    ]);
    const seedAudits = serialized(audits);
    expect(seedAudits).not.toContain(PASSWORD);
    expect(seedAudits).not.toContain(NEW_PASSWORD);
    expect(seedAudits).not.toContain('$scrypt$');
    // The re-arm kept the password; the reset replaced it.
    expect(serialized(audits[1]?.after)).toContain('"passwordSet":false');
    expect(serialized(audits[2]?.after)).toContain('"passwordSet":true');
  });

  it('refuses a username held by another role in tenant zero and changes nothing', async () => {
    const support = await prisma.adminUser.create({
      data: {
        tenantId: TENANT_ZERO_ID,
        username: 'p5-support',
        displayName: 'P5 support',
        role: AdminRole.SUPPORT,
      },
    });

    const refused: unknown = await run({
      SEED_PLATFORM_ADMIN_USERNAME: 'p5-support',
      SEED_PLATFORM_ADMIN_PASSWORD: PASSWORD,
    }).catch((caught: unknown) => caught);

    expect(refused).toBeInstanceOf(seed.PlatformAdminSeedError);
    expect(await storedRow(support.id)).toMatchObject({
      role: AdminRole.SUPPORT,
      passwordHash: null,
    });
    await expect(auditsFor(support.id)).resolves.toHaveLength(0);
  });

  it('adopts a Telegram-id-only platform admin instead of colliding with it', async () => {
    const telegramUserId = 990_000_000_000_000n + BigInt(Date.now() % 1_000_000);
    const legacy = await prisma.adminUser.create({
      data: {
        tenantId: TENANT_ZERO_ID,
        telegramUserId,
        username: null,
        displayName: 'Legacy (platform)',
        role: AdminRole.PLATFORM_ADMIN,
      },
    });

    const result = await run({
      SEED_PLATFORM_ADMIN_USERNAME: 'p5-legacy',
      SEED_PLATFORM_ADMIN_PASSWORD: PASSWORD,
      SEED_ADMIN_TELEGRAM_ID: telegramUserId.toString(),
    });

    expect(result).toEqual({ adminUserId: legacy.id, username: 'p5-legacy', outcome: 'updated' });
    const adopted = await storedRow(legacy.id);
    expect(adopted).toMatchObject({ username: 'p5-legacy', displayName: 'Legacy (platform)' });
    expect(adopted.passwordHash?.startsWith('$scrypt$')).toBe(true);
    await expect(
      prisma.adminUser.count({ where: { tenantId: TENANT_ZERO_ID, telegramUserId } }),
    ).resolves.toBe(1);
  });
});
