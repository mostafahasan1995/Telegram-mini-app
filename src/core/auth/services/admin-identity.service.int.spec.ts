/**
 * Console-only admins against REAL Postgres and Redis.
 *
 * The properties here are properties of the database, which is why they cannot be unit tests:
 *
 *  - several admins with a NULL telegram_user_id coexist in one operator under the
 *    (tenant_id, telegram_user_id) unique index, while a duplicate NON-null id is still refused;
 *  - a NULL never answers a Telegram lookup, through the service or through raw SQL;
 *  - prisma/sql/006 still pins a PLATFORM_ADMIN to tenant zero when it has no Telegram id;
 *  - a signed token for such an admin passes the real AuthGuard, resolved by (tid, sub), and stops
 *    passing once the admin is deactivated and the identity cache is invalidated.
 *
 * Run with the escape hatch (no testcontainers):
 *   POSTGRES_TEST_URL=... REDIS_TEST_URL=... npx jest --config jest-int.config.cjs --runInBand \
 *     src/core/auth/services/admin-identity.service.int.spec.ts
 */
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AdminRole } from '@prisma/client';
import { Redis } from 'ioredis';
import { Client } from 'pg';

import { ForbiddenError } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';
import { REQUEST_ADMIN_KEY, type RequestPrincipals } from '@common/decorators/auth.types';
import {
  isUniqueConstraintError,
  mapPrismaError,
  type UniqueConstraintError,
} from '@core/prisma/prisma-errors';
import { TENANT_BOOTSTRAP_ID, TENANT_ZERO_ID } from '@core/tenant/tenant.constants';

import { startPostgres, stopPostgres } from '../../../../test/setup/postgres-container';
import { startRedis } from '../../../../test/setup/redis-container';
import { CacheService } from '../../cache/cache.service';
import type { LockService } from '../../cache/lock.service';
import type { RedisService } from '../../cache/redis.service';
import type { AppConfigService } from '../../config/config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthGuard } from '../guards/auth.guard';
import { AdminIdentityService } from './admin-identity.service';
import { PasswordHasherService } from './password-hasher.service';
import { SessionService } from './session.service';

const SECRET = 'integration-test-secret-at-least-32-chars';
/** Every row this suite writes carries it, so a crashed run's leftovers are found and removed. */
const MARK = 'P2-INT';
const RUN = Date.now().toString(36);
/** Telegram never issues ids this high; the suite owns the band. */
const TG_BASE = 990_000_000_000_000n + BigInt(Date.now() % 1_000_000);

interface FakeRequest extends RequestPrincipals {
  headers: Record<string, string>;
}

function contextFor(request: FakeRequest): ExecutionContext {
  const handler = (): void => undefined;
  class Controller {}
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => Controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('console-only admins (integration)', () => {
  let prisma: PrismaService;
  let redis: Redis;
  let pg: Client;
  let identities: AdminIdentityService;
  let sessions: SessionService;
  let guard: AuthGuard;
  const hasher = new PasswordHasherService({ ln: 10, r: 8, p: 1 });

  const purge = async (): Promise<void> => {
    // No tenant context is open, so the scope extension leaves this unfiltered — which is the
    // point: leftovers may sit in either tenant.
    await prisma.adminUser.deleteMany({ where: { displayName: { startsWith: MARK } } });
  };

  beforeAll(async () => {
    const [postgres, redisHandle] = await Promise.all([startPostgres(), startRedis()]);

    const config = {
      db: { url: postgres.url, poolMax: 2 },
      app: { role: 'api', isProduction: false },
      jwt: { secret: SECRET, accessTtl: '15m', refreshTtlMs: 60_000 },
    } as unknown as AppConfigService;

    prisma = new PrismaService(config);
    redis = new Redis(redisHandle.url, { maxRetriesPerRequest: null });
    pg = new Client({ connectionString: postgres.url });
    await pg.connect();

    const cache = new CacheService(redis as unknown as RedisService);
    identities = new AdminIdentityService(prisma, cache);
    const jwt = new JwtService({
      secret: SECRET,
      signOptions: { algorithm: 'HS256', expiresIn: 900 },
    });
    sessions = new SessionService(
      prisma,
      jwt,
      config,
      redis as unknown as RedisService,
      {} as LockService,
    );
    guard = new AuthGuard(new Reflector(), sessions, identities);

    await purge();
  });

  afterAll(async () => {
    await purge();
    await pg.end();
    await redis.flushdb();
    await redis.quit();
    await prisma.onModuleDestroy();
    await stopPostgres();
  });

  it('lets two admins with NULL Telegram ids coexist in one tenant, and still refuses a duplicate id', async () => {
    const first = await prisma.adminUser.create({
      data: {
        tenantId: TENANT_BOOTSTRAP_ID,
        telegramUserId: null,
        username: `p2-int-a-${RUN}`,
        displayName: `${MARK} console A`,
        role: AdminRole.SUPER_ADMIN,
      },
    });
    const second = await prisma.adminUser.create({
      data: {
        tenantId: TENANT_BOOTSTRAP_ID,
        username: `p2-int-b-${RUN}`,
        displayName: `${MARK} console B`,
        role: AdminRole.VIEWER,
      },
    });

    expect(first.telegramUserId).toBeNull();
    expect(second.telegramUserId).toBeNull();

    const { rows } = await pg.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM admin_users
        WHERE tenant_id = $1 AND telegram_user_id IS NULL AND display_name LIKE $2`,
      [TENANT_BOOTSTRAP_ID, `${MARK}%`],
    );
    expect(rows[0]?.count).toBe('2');

    // The index still does its job for real ids.
    await prisma.adminUser.create({
      data: {
        tenantId: TENANT_BOOTSTRAP_ID,
        telegramUserId: TG_BASE + 1n,
        displayName: `${MARK} bot admin`,
        role: AdminRole.REVIEWER,
      },
    });
    const duplicate: unknown = await prisma.adminUser
      .create({
        data: {
          tenantId: TENANT_BOOTSTRAP_ID,
          telegramUserId: TG_BASE + 1n,
          displayName: `${MARK} bot admin duplicate`,
          role: AdminRole.REVIEWER,
        },
      })
      .catch((caught: unknown) => caught);
    // The raw client throws Prisma's P2002; repositories translate it, so translate it here too.
    const mapped = mapPrismaError(duplicate);
    expect(isUniqueConstraintError(mapped)).toBe(true);
    expect((mapped as UniqueConstraintError).fields.join(',')).toContain('telegram_user_id');
  });

  it('never lets a NULL Telegram id answer a Telegram lookup', async () => {
    const botAdmin = await prisma.adminUser.findFirst({
      where: { tenantId: TENANT_BOOTSTRAP_ID, telegramUserId: TG_BASE + 1n },
      select: { id: true },
    });
    expect(botAdmin).not.toBeNull();

    // The service: the real id finds exactly the bot admin, and nothing else finds anyone.
    const found = await identities.resolveByTelegram(TENANT_BOOTSTRAP_ID, TG_BASE + 1n);
    expect(found?.adminUserId).toBe(botAdmin?.id);
    for (const probe of [0n, -1n, TG_BASE + 2n]) {
      await expect(identities.resolveByTelegram(TENANT_BOOTSTRAP_ID, probe)).resolves.toBeNull();
    }

    // Raw SQL, parameterised the way any hand-written lookup would be: `= $2` is never true for a
    // NULL, so no console-only row can come back whatever is bound.
    for (const probe of ['0', '-1', (TG_BASE + 2n).toString()]) {
      const { rows } = await pg.query(
        `SELECT id FROM admin_users WHERE tenant_id = $1 AND telegram_user_id = $2`,
        [TENANT_BOOTSTRAP_ID, probe],
      );
      expect(rows).toHaveLength(0);
    }
  });

  it('keeps 006 pinning a PLATFORM_ADMIN with no Telegram id to tenant zero', async () => {
    const platform = await prisma.adminUser.create({
      data: {
        tenantId: TENANT_ZERO_ID,
        username: `p2-int-platform-${RUN}`,
        displayName: `${MARK} platform`,
        role: AdminRole.PLATFORM_ADMIN,
      },
    });
    expect(platform.telegramUserId).toBeNull();

    const misplaced: unknown = await prisma.adminUser
      .create({
        data: {
          tenantId: TENANT_BOOTSTRAP_ID,
          username: `p2-int-misplaced-${RUN}`,
          displayName: `${MARK} misplaced platform`,
          role: AdminRole.PLATFORM_ADMIN,
        },
      })
      .catch((caught: unknown) => caught);
    expect(String(misplaced)).toContain('admin_users_platform_admin_tenant_zero_check');
  });

  it('authenticates a console-only admin by (tid, sub) and refuses them once deactivated', async () => {
    const password = 'console password 1';
    const created = await prisma.adminUser.create({
      data: {
        tenantId: TENANT_ZERO_ID,
        username: `p2-int-owner-${RUN}`,
        displayName: `${MARK} owner`,
        role: AdminRole.PLATFORM_ADMIN,
        passwordHash: await hasher.hash(password),
      },
    });

    // The stored string round-trips through the database intact.
    const stored = await prisma.adminUser.findUnique({
      where: { id: created.id },
      select: { passwordHash: true },
    });
    await expect(hasher.verify(password, stored?.passwordHash ?? null)).resolves.toEqual({
      ok: true,
      needsRehash: false,
    });

    const principal = await identities.resolveById(TENANT_ZERO_ID, created.id);
    expect(principal).toEqual({
      adminUserId: created.id,
      telegramUserId: null,
      tenantId: TENANT_ZERO_ID,
      role: AdminRole.PLATFORM_ADMIN,
      displayName: `${MARK} owner`,
    });
    if (principal === null) throw new Error('unreachable');

    const { accessToken } = await sessions.issueAdminAccessToken(principal);
    const request: FakeRequest = { headers: { authorization: `Bearer ${accessToken}` } };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request[REQUEST_ADMIN_KEY]).toEqual(principal);

    // Offboarding: the write, then the invalidation every admin mutation performs.
    await prisma.adminUser.update({ where: { id: created.id }, data: { isActive: false } });
    await identities.invalidate({
      tenantId: TENANT_ZERO_ID,
      adminUserId: created.id,
      telegramUserId: null,
    });

    const refused: unknown = await guard
      .canActivate(contextFor({ headers: { authorization: `Bearer ${accessToken}` } }))
      .catch((caught: unknown) => caught);
    expect(refused).toBeInstanceOf(ForbiddenError);
    expect((refused as ForbiddenError).errorCode).toBe(CommonErrorCodes.ADMIN_INACTIVE);
  });

  it('refuses a token whose sub lives in a different tenant than its tid', async () => {
    const operatorAdmin = await prisma.adminUser.create({
      data: {
        tenantId: TENANT_BOOTSTRAP_ID,
        username: `p2-int-operator-${RUN}`,
        displayName: `${MARK} operator`,
        role: AdminRole.SUPER_ADMIN,
      },
    });

    // Correctly signed, but claiming the operator's admin is a tenant-zero principal.
    const { accessToken } = await sessions.issueAdminAccessToken({
      adminUserId: operatorAdmin.id,
      telegramUserId: null,
      tenantId: TENANT_ZERO_ID,
      role: AdminRole.PLATFORM_ADMIN,
      displayName: 'forged home',
    });

    const refused: unknown = await guard
      .canActivate(contextFor({ headers: { authorization: `Bearer ${accessToken}` } }))
      .catch((caught: unknown) => caught);
    expect(refused).toBeInstanceOf(ForbiddenError);
    expect((refused as ForbiddenError).errorCode).toBe(CommonErrorCodes.ADMIN_INACTIVE);
  });
});
