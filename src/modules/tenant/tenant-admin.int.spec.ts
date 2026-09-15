/**
 * `/v1/admin/tenants` and `/v1/admin/platform-defaults` through the REAL api: AppModule, the real
 * middleware, guards, validation pipe, exception filter, Postgres and Redis. Callers sign in through
 * the real credentials route, as the console does.
 *
 * What only this level can prove:
 *  - every body parses with the console's own zod schemas (copied below from
 *    manager-account-dashboard src/types/tenant.ts), and no secret reaches the wire;
 *  - the guard really refuses an operator's SUPER_ADMIN on every route, which a unit test of the
 *    service cannot see;
 *  - a validation failure arrives in the envelope the console renders (`details.fields`);
 *  - a suspension really evicts the Redis registry entry and calls both in-process evictions;
 *  - a suspension is reversible: an operator suspended while serving is resumed, and one whose
 *    Ichancy details changed meanwhile, or that never served, is refused;
 *  - a suspension really stops new deposits on the mini app's route, while a deposit already started
 *    can still be cancelled, and deposits open again once the operator is resumed;
 *  - three concurrent first reads of platform defaults seed from the env exactly once.
 *
 * Telegram is never called: suspending and resuming evict caches and build no bot. Ichancy is the
 * fake adapter (ICHANCY_FAKE=1 in the test env), and /activate never reaches any adapter.
 *
 * `tenants`, `platform_defaults` and `currencies` survive truncateAll, so the operators this suite
 * adds carry a run-unique slug prefix and are deleted in afterAll, after a reset has cleared the
 * append-only audit rows holding them in place. The defaults row is restored to what it held before.
 *
 * Run with the escape hatch (no testcontainers):
 *   POSTGRES_TEST_URL=... REDIS_TEST_URL=... npx jest --config jest-int.config.cjs --runInBand \
 *     src/modules/tenant/tenant-admin.int.spec.ts
 */
import { randomUUID } from 'node:crypto';

import { AdminRole, TenantStatus, type PlatformDefaults } from '@prisma/client';
import request from 'supertest';
import { z } from 'zod';

import type { PasswordHasherService } from '@core/auth/services/password-hasher.service';
import type { SessionService } from '@core/auth/services/session.service';
import type { CacheService } from '@core/cache/cache.service';
import type { AppConfigService } from '@core/config/config.service';
import type { PrismaService } from '@core/prisma/prisma.service';
import type { TenantRegistryService } from '@core/tenant/services/tenant-registry.service';
import {
  TENANT_BOOTSTRAP_ID,
  TENANT_ZERO_ID,
  tenantRegistryKey,
} from '@core/tenant/tenant.constants';

import { createTestApp, type TestApp } from '../../../test/setup/app-factory';
import type { PlayerService } from '../player/services/player.service';

jest.setTimeout(180_000);

// ── The console's contract, copied from manager-account-dashboard src/types/tenant.ts ──────────
const isoDateTime = z.string();
const tenantSchema = z.looseObject({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']),
  hasWebhookPath: z.boolean(),
  adminChatId: z.string(),
  feedChatId: z.string().nullable(),
  botUsername: z.string().nullable(),
  ichancyBaseUrl: z.string(),
  ichancyUsername: z.string(),
  ichancyAgentId: z.string(),
  currencyCode: z.string(),
  dualApprovalThresholdMinor: z.string(),
  agentFloatLowWatermarkMinor: z.string(),
  depositExpiryMinutes: z.number(),
  depositMode: z.enum(['AUTO', 'MANUAL']).optional(),
  withdrawalMode: z.enum(['AUTO', 'MANUAL']).optional(),
  miniAppUrl: z.string().nullable().optional(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  counts: z.looseObject({ players: z.number(), deposits: z.number() }).optional(),
});
const tenantListSchema = z.looseObject({ tenants: z.array(tenantSchema) });
const platformDefaultsSchema = z.looseObject({
  ichancyBaseUrl: z.string(),
  ichancyAgentId: z.string().nullable(),
  currencyCode: z.string(),
  dualApprovalThresholdMinor: z.string(),
  agentFloatLowWatermarkMinor: z.string(),
  depositExpiryMinutes: z.number(),
  updatedAt: isoDateTime,
  appliesToNewOperatorsOnly: z.boolean(),
});
const errorEnvelopeSchema = z.looseObject({
  success: z.literal(false),
  data: z.null(),
  error: z.looseObject({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

const RUN = Date.now().toString(36);
/** Every operator this suite creates starts with it, so a crashed run's leftovers are found. */
const SLUG_PREFIX = 'p9-int-';
const PASSWORD = 'Correct-Horse-9';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';
const PATH_TOKEN = `p9IntPathToken${RUN}`;
const SEALED_BOT_TOKEN = `P9-INT-SEALED-BOT-${RUN}`;
const SEALED_PASSWORD = `P9-INT-SEALED-AGENT-${RUN}`;
const INACTIVE_CURRENCY = 'XQI';
const login = (name: string): string => `p9-${RUN}-${name}`;

type Body = { success: boolean; data: unknown; error: unknown };

describe('Tenant admin surface (integration)', () => {
  let ctx: TestApp;
  let prisma: PrismaService;
  let cache: CacheService;
  let config: AppConfigService;

  let platformBearer: string;
  let ownerBearer: string;
  let activeId: string;
  let suspendedId: string;
  let editedId: string;
  let defaultsBefore: PlatformDefaults | null = null;

  /**
   * The server is listening before any request is built (see beforeAll). Supertest otherwise calls
   * `listen(0)` once per request it constructs, so a list of requests built up front, or three fired
   * at once, would each rebind the one server, and all but the last would dial a closed port.
   */
  const api = () => request(ctx.httpServer);

  const removeSuiteRows = async (): Promise<void> => {
    await prisma.tenant.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
    await prisma.currency.deleteMany({ where: { code: INACTIVE_CURRENCY } });
  };

  const createOperator = async (name: string, status: TenantStatus): Promise<string> => {
    const tenant = await prisma.tenant.create({
      data: {
        slug: `${SLUG_PREFIX}${RUN}-${name}`,
        displayName: `P9 ${name}`,
        status,
        botTokenEnc: SEALED_BOT_TOKEN,
        webhookPathToken: `${PATH_TOKEN}${name}`,
        adminChatId: -1001234567890n,
        ichancyBaseUrl: 'https://example.invalid',
        ichancyUsername: `p9-agent-${name}`,
        ichancyPasswordEnc: SEALED_PASSWORD,
        ichancyAgentId: '10099',
        currencyCode: 'NSP',
        dualApprovalThresholdMinor: 30_000_000n,
        agentFloatLowWatermarkMinor: 50_000_000n,
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
    passwordHash: string,
  ): Promise<void> => {
    await prisma.adminUser.create({
      data: {
        tenantId,
        username,
        displayName: `P9 ${username}`,
        role,
        isActive: true,
        passwordHash,
        telegramUserId: null,
      },
    });
  };

  const signIn = async (username: string): Promise<string> => {
    const response = await api()
      .post('/v1/admin/auth/credentials')
      .send({ username, password: PASSWORD })
      .expect(200);
    const session = z.looseObject({ accessToken: z.string() }).parse((response.body as Body).data);
    return `Bearer ${session.accessToken}`;
  };

  const auditCount = async (tenantId: string, action: string, entityId?: string): Promise<number> =>
    prisma.auditLog.count({
      where: { tenantId, action, ...(entityId === undefined ? {} : { entityId }) },
    });

  const failure = (body: unknown): z.infer<typeof errorEnvelopeSchema>['error'] =>
    errorEnvelopeSchema.parse(body).error;

  const fieldsOf = (body: unknown): string[] =>
    z.looseObject({ fields: z.array(z.string()) }).parse(failure(body).details).fields;

  beforeAll(async () => {
    ctx = await createTestApp();
    // Listen once, on loopback, for the whole suite; ctx.close() closes it through app.close().
    await new Promise<void>((resolve) => {
      ctx.httpServer.listen(0, '127.0.0.1', resolve);
    });

    // Dynamic, like the harness itself: these modules must load after the test env exists.
    const { PrismaService: PrismaServiceClass } = await import('@core/prisma/prisma.service');
    const { PasswordHasherService: HasherClass } = await import(
      '@core/auth/services/password-hasher.service'
    );
    const { CacheService: CacheServiceClass } = await import('@core/cache/cache.service');
    const { AppConfigService: ConfigClass } = await import('@core/config/config.service');
    prisma = ctx.app.get(PrismaServiceClass);
    cache = ctx.app.get(CacheServiceClass);
    config = ctx.app.get(ConfigClass);
    const hasher: PasswordHasherService = ctx.app.get(HasherClass);

    // A crashed earlier run can leave operators behind, held in place by their audit rows.
    await ctx.reset();
    await removeSuiteRows();
    defaultsBefore = await prisma.platformDefaults.findUnique({ where: { id: 1 } });

    const hash = await hasher.hash(PASSWORD);
    await createAdmin(TENANT_ZERO_ID, login('platform'), AdminRole.PLATFORM_ADMIN, hash);
    await createAdmin(TENANT_BOOTSTRAP_ID, login('owner'), AdminRole.SUPER_ADMIN, hash);

    activeId = await createOperator('active', TenantStatus.ACTIVE);
    suspendedId = await createOperator('suspended', TenantStatus.SUSPENDED);
    editedId = await createOperator('edited', TenantStatus.SUSPENDED);

    platformBearer = await signIn(login('platform'));
    ownerBearer = await signIn(login('owner'));
  });

  afterAll(async () => {
    if (ctx === undefined) return;
    // Reset first: it truncates audit_logs (append-only) so the suite's operators can be deleted.
    await ctx.reset();
    await removeSuiteRows();
    if (defaultsBefore !== null) {
      const { id: _id, updatedAt: _updatedAt, ...values } = defaultsBefore;
      await prisma.platformDefaults.update({ where: { id: 1 }, data: values });
    }
    await ctx.close();
  });

  it('lists every operator, tenant zero included, in the wrapper the console parses, with no secret on the wire', async () => {
    const response = await api().get('/v1/admin/tenants').set('authorization', platformBearer).expect(200);

    const { tenants } = tenantListSchema.parse((response.body as Body).data);
    const ids = tenants.map((tenant) => tenant.id);
    expect(ids).toEqual(expect.arrayContaining([TENANT_ZERO_ID, TENANT_BOOTSTRAP_ID, activeId]));

    const active = tenants.find((tenant) => tenant.id === activeId);
    expect(active).toMatchObject({
      status: 'ACTIVE',
      hasWebhookPath: true,
      adminChatId: '-1001234567890',
      dualApprovalThresholdMinor: '30000000',
      counts: { players: 0, deposits: 0 },
    });

    const wire = JSON.stringify(response.body);
    for (const secret of [PATH_TOKEN, SEALED_BOT_TOKEN, SEALED_PASSWORD]) {
      expect(wire).not.toContain(secret);
    }
    for (const column of ['webhookPathToken', 'botTokenEnc', 'webhookSecretEnc', 'ichancyPasswordEnc']) {
      expect(wire).not.toContain(column);
    }
  });

  it('reads one operator, and answers 404 TENANT_NOT_FOUND for an id that names none, on every route', async () => {
    const response = await api()
      .get(`/v1/admin/tenants/${activeId}`)
      .set('authorization', platformBearer)
      .expect(200);
    expect(tenantSchema.parse((response.body as Body).data)).toMatchObject({
      id: activeId,
      depositMode: 'MANUAL',
      withdrawalMode: 'MANUAL',
      miniAppUrl: null,
    });

    const misses = [
      api().get(`/v1/admin/tenants/${UNKNOWN_ID}`),
      api().patch(`/v1/admin/tenants/${UNKNOWN_ID}`).send({ displayName: 'Nobody' }),
      api().post(`/v1/admin/tenants/${UNKNOWN_ID}/suspend`),
      api().post(`/v1/admin/tenants/${UNKNOWN_ID}/activate`),
    ];
    for (const miss of misses) {
      const answer = await miss.set('authorization', platformBearer).expect(404);
      expect(failure(answer.body)).toMatchObject({ code: 'TENANT_NOT_FOUND', message: 'Tenant not found.' });
    }

    const malformed = await api()
      .get('/v1/admin/tenants/not-a-uuid')
      .set('authorization', platformBearer)
      .expect(400);
    expect(failure(malformed.body).code).toBe('VALIDATION_FAILED');

    // The two fixed ids are not RFC-versioned uuids, and both are operators an admin must reach.
    for (const fixedId of [TENANT_ZERO_ID, TENANT_BOOTSTRAP_ID]) {
      const fixed = await api()
        .get(`/v1/admin/tenants/${fixedId}`)
        .set('authorization', platformBearer)
        .expect(200);
      expect(tenantSchema.parse((fixed.body as Body).data).id).toBe(fixedId);
    }
  });

  it("refuses every route to an operator's SUPER_ADMIN with 403, and to a caller with no token with 401", async () => {
    const routes = (): request.Test[] => [
      api().get('/v1/admin/tenants'),
      api().get(`/v1/admin/tenants/${activeId}`),
      api().patch(`/v1/admin/tenants/${activeId}`).send({ displayName: 'Hijacked' }),
      api().post(`/v1/admin/tenants/${activeId}/suspend`),
      api().post(`/v1/admin/tenants/${suspendedId}/activate`),
      api().get('/v1/admin/platform-defaults'),
      api().patch('/v1/admin/platform-defaults').send({ depositExpiryMinutes: 60 }),
    ];

    for (const route of routes()) {
      const answer = await route.set('authorization', ownerBearer).expect(403);
      expect(failure(answer.body).code).toBe('INSUFFICIENT_ROLE');
    }
    for (const route of routes()) {
      await route.expect(401);
    }

    const untouched = await prisma.tenant.findUniqueOrThrow({
      where: { id: activeId },
      select: { status: true, displayName: true },
    });
    expect(untouched).toEqual({ status: TenantStatus.ACTIVE, displayName: 'P9 active' });
  });

  it("PATCH writes only what changed, as strings, and audits it in that operator's own log", async () => {
    // The body the console's edit form builds (tenant-form-dialog.tsx toUpdateBody).
    const body = {
      displayName: 'P9 edited, renamed',
      adminChatId: '-1009007199254740993',
      feedChatId: '-1009876543210',
      dualApprovalThresholdMinor: '75000000',
      agentFloatLowWatermarkMinor: '50000000',
      depositExpiryMinutes: 45,
      depositMode: 'AUTO',
      miniAppUrl: 'https://cashier.example.app',
    };
    const response = await api()
      .patch(`/v1/admin/tenants/${editedId}`)
      .set('authorization', platformBearer)
      .send(body)
      .expect(200);

    expect(tenantSchema.parse((response.body as Body).data)).toMatchObject({
      ...body,
      withdrawalMode: 'MANUAL',
      slug: `${SLUG_PREFIX}${RUN}-edited`,
      currencyCode: 'NSP',
    });

    const audits = await prisma.auditLog.findMany({
      where: { tenantId: editedId, action: 'tenant.updated', entityId: editedId },
    });
    expect(audits).toHaveLength(1);
    // The unchanged watermark is not in the evidence: only real changes are.
    expect(audits[0]?.before).toEqual(
      expect.not.objectContaining({ agentFloatLowWatermarkMinor: expect.anything() }),
    );
    expect(audits[0]?.after).toMatchObject({
      displayName: 'P9 edited, renamed',
      adminChatId: '-1009007199254740993',
      depositExpiryMinutes: 45,
    });

    // Saving the same form again changes nothing and records nothing.
    await api().patch(`/v1/admin/tenants/${editedId}`).set('authorization', platformBearer).send(body).expect(200);
    expect(await auditCount(editedId, 'tenant.updated', editedId)).toBe(1);

    // null is the API's spelling of "clear the mini app URL".
    const cleared = await api()
      .patch(`/v1/admin/tenants/${editedId}`)
      .set('authorization', platformBearer)
      .send({ miniAppUrl: null })
      .expect(200);
    expect(tenantSchema.parse((cleared.body as Body).data).miniAppUrl).toBeNull();
    expect(await auditCount(editedId, 'tenant.updated', editedId)).toBe(2);
  });

  it('PATCH refuses invalid fields in the shape the console renders, and frozen fields by name', async () => {
    const invalid: [Record<string, unknown>, string][] = [
      [{ adminChatId: -1001234567890 }, 'adminChatId'],
      [{ feedChatId: '12.5' }, 'feedChatId'],
      [{ dualApprovalThresholdMinor: '1500.00' }, 'dualApprovalThresholdMinor'],
      [{ agentFloatLowWatermarkMinor: '9223372036854775808' }, 'agentFloatLowWatermarkMinor'],
      [{ depositExpiryMinutes: 3 }, 'depositExpiryMinutes'],
      [{ withdrawalMode: 'SOMETIMES' }, 'withdrawalMode'],
      [{ miniAppUrl: 'http://cashier.example.app' }, 'miniAppUrl'],
      [{ displayName: '' }, 'displayName'],
      [{ status: 'ACTIVE' }, 'property status'],
    ];

    for (const [body, field] of invalid) {
      const answer = await api()
        .patch(`/v1/admin/tenants/${editedId}`)
        .set('authorization', platformBearer)
        .send(body)
        .expect(400);
      expect(failure(answer.body)).toMatchObject({
        code: 'VALIDATION_FAILED',
        message: 'The request payload is invalid.',
      });
      const fields = fieldsOf(answer.body);
      expect(fields.length).toBeGreaterThan(0);
      for (const message of fields) expect(message.startsWith(field)).toBe(true);
    }

    for (const frozen of ['slug', 'currencyCode'] as const) {
      const answer = await api()
        .patch(`/v1/admin/tenants/${editedId}`)
        .set('authorization', platformBearer)
        .send({ [frozen]: frozen === 'slug' ? 'renamed' : 'USD', displayName: 'Should not land' })
        .expect(400);
      expect(failure(answer.body).code).toBe('TENANT_FIELD_IMMUTABLE');
      expect(fieldsOf(answer.body)).toEqual([`${frozen} cannot be changed after creation`]);
    }

    const row = await prisma.tenant.findUniqueOrThrow({
      where: { id: editedId },
      select: { slug: true, currencyCode: true, displayName: true },
    });
    expect(row).toEqual({
      slug: `${SLUG_PREFIX}${RUN}-edited`,
      currencyCode: 'NSP',
      displayName: 'P9 edited, renamed',
    });
  });

  it('suspends an ACTIVE operator once, evicting the registry entry, the bot and the mini-app key', async () => {
    const { TenantRegistryService: RegistryClass } = await import(
      '@core/tenant/services/tenant-registry.service'
    );
    const { TenantBotRegistry: BotRegistryClass } = await import(
      '@core/telegram/services/tenant-bot-registry.service'
    );
    const { InitDataService: InitDataClass } = await import('@core/auth/services/init-data.service');
    const registry: TenantRegistryService = ctx.app.get(RegistryClass);
    const botInvalidate = jest.spyOn(ctx.app.get(BotRegistryClass), 'invalidate');
    const initDataInvalidate = jest.spyOn(ctx.app.get(InitDataClass), 'invalidate');

    try {
      // Prime the cache every process reads status through, as a webhook delivery would.
      expect(await registry.find(activeId)).toMatchObject({ status: TenantStatus.ACTIVE });
      expect(await cache.get(tenantRegistryKey(activeId))).not.toBeNull();

      const response = await api()
        .post(`/v1/admin/tenants/${activeId}/suspend`)
        .set('authorization', platformBearer)
        .expect(200);
      expect(tenantSchema.parse((response.body as Body).data).status).toBe('SUSPENDED');

      expect(await cache.get(tenantRegistryKey(activeId))).toBeNull();
      expect(await registry.find(activeId)).toMatchObject({ status: TenantStatus.SUSPENDED });
      expect(botInvalidate).toHaveBeenCalledWith(activeId);
      expect(initDataInvalidate).toHaveBeenCalledWith(activeId);
      expect(await auditCount(activeId, 'tenant.suspended', activeId)).toBe(1);

      // Repeating it answers the row and records no second decision.
      await api().post(`/v1/admin/tenants/${activeId}/suspend`).set('authorization', platformBearer).expect(200);
      expect(await auditCount(activeId, 'tenant.suspended', activeId)).toBe(1);
    } finally {
      botInvalidate.mockRestore();
      initDataInvalidate.mockRestore();
    }

    const locked = await api()
      .post(`/v1/admin/tenants/${TENANT_ZERO_ID}/suspend`)
      .set('authorization', platformBearer)
      .expect(422);
    expect(failure(locked.body).code).toBe('TENANT_PLATFORM_LOCKED');
    const zero = await prisma.tenant.findUniqueOrThrow({
      where: { id: TENANT_ZERO_ID },
      select: { status: true },
    });
    expect(zero.status).toBe(TenantStatus.ACTIVE);
  });

  it('activates again an operator suspended while serving, and refuses one whose Ichancy details changed since', async () => {
    const { TenantRegistryService: RegistryClass } = await import(
      '@core/tenant/services/tenant-registry.service'
    );
    const registry: TenantRegistryService = ctx.app.get(RegistryClass);
    const resumedId = await createOperator('resumed', TenantStatus.ACTIVE);
    const post = (action: 'suspend' | 'activate'): request.Test =>
      api().post(`/v1/admin/tenants/${resumedId}/${action}`).set('authorization', platformBearer);

    await post('suspend').expect(200);
    // The suspension carries a fingerprint of the credentials, and none of the credentials.
    const suspension = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: resumedId, action: 'tenant.suspended', entityId: resumedId },
    });
    const evidence = JSON.stringify(suspension.after);
    expect(evidence).toContain('ichancyFingerprint');
    for (const secret of [SEALED_PASSWORD, 'p9-agent-resumed']) expect(evidence).not.toContain(secret);

    // Prime the cache every process reads status through, as a delivery during the suspension would.
    expect(await registry.find(resumedId)).toMatchObject({ status: TenantStatus.SUSPENDED });

    const resumed = await post('activate').expect(200);
    expect(tenantSchema.parse((resumed.body as Body).data).status).toBe('ACTIVE');
    expect(await cache.get(tenantRegistryKey(resumedId))).toBeNull();
    expect(await registry.find(resumedId)).toMatchObject({ status: TenantStatus.ACTIVE });
    const activations = await prisma.auditLog.findMany({
      where: { tenantId: resumedId, action: 'tenant.activated', entityId: resumedId },
    });
    expect(activations).toHaveLength(1);
    expect(activations[0]?.after).toMatchObject({
      status: 'ACTIVE',
      $meta: { verification: 'resumed-previously-serving', signIn: false },
    });

    // Repeating it answers the row and records no second decision.
    await post('activate').expect(200);
    expect(await auditCount(resumedId, 'tenant.activated', resumedId)).toBe(1);

    // Suspended again, and the agent id changes meanwhile: nothing has proven the new details.
    await post('suspend').expect(200);
    await prisma.tenant.update({ where: { id: resumedId }, data: { ichancyAgentId: '10500' } });
    const refused = await post('activate').expect(503);
    expect(failure(refused.body).code).toBe('TENANT_ACTIVATION_UNAVAILABLE');
    const row = await prisma.tenant.findUniqueOrThrow({
      where: { id: resumedId },
      select: { status: true },
    });
    expect(row.status).toBe(TenantStatus.SUSPENDED);
    expect(await auditCount(resumedId, 'tenant.activated', resumedId)).toBe(1);
  });

  it('stops new deposits while an operator is suspended, still lets a started one be cancelled, and takes deposits again once resumed', async () => {
    const { PlayerService: PlayerServiceClass } = await import('../player/services/player.service');
    const { SessionService: SessionServiceClass } = await import('@core/auth/services/session.service');
    const players: PlayerService = ctx.app.get(PlayerServiceClass);
    const sessions: SessionService = ctx.app.get(SessionServiceClass);

    // The bootstrap operator: it owns the seeded rails, and it is the operator players really use.
    const method = await prisma.paymentMethod.findFirstOrThrow({
      where: { tenantId: TENANT_BOOTSTRAP_ID, code: 'EWALLET_MAIN' },
      select: { id: true, currencyCode: true },
    });
    const telegramUserId = 7_000_000_000n + BigInt(Date.now() % 1_000_000);
    const { playerId } = await ctx.inTenant(() =>
      prisma.runInTransaction((tx) =>
        players.upsertFromTelegram(
          tx,
          TENANT_BOOTSTRAP_ID,
          { telegramUserId, firstName: 'P9 player' },
          method.currencyCode,
        ),
      ),
    );
    const session = await sessions.issueForPlayer(TENANT_BOOTSTRAP_ID, playerId, telegramUserId);
    const playerBearer = `Bearer ${session.accessToken}`;

    const openDeposit = (): request.Test =>
      api()
        .post('/v1/deposits')
        .set('authorization', playerBearer)
        .set('idempotency-key', randomUUID())
        .send({ paymentMethodId: method.id, amount: { amount: '6000.00' } });
    const shortIdOf = (body: unknown): string =>
      z.looseObject({ shortId: z.string() }).parse((body as Body).data).shortId;

    try {
      const started = shortIdOf((await openDeposit().expect(201)).body);

      await api()
        .post(`/v1/admin/tenants/${TENANT_BOOTSTRAP_ID}/suspend`)
        .set('authorization', platformBearer)
        .expect(200);

      const refused = await openDeposit().expect(422);
      expect(failure(refused.body).code).toBe('TENANT_NOT_ACTIVE');

      // Already started, so not new money: the player can still back out of it.
      const cancelled = await api()
        .post(`/v1/deposits/${started}/cancel`)
        .set('authorization', playerBearer)
        .expect(200);
      expect(z.looseObject({ status: z.string() }).parse((cancelled.body as Body).data).status).toBe(
        'REJECTED',
      );

      // It was serving before the suspension, so it resumes, and deposits open again at once.
      await api()
        .post(`/v1/admin/tenants/${TENANT_BOOTSTRAP_ID}/activate`)
        .set('authorization', platformBearer)
        .expect(200);
      expect(shortIdOf((await openDeposit().expect(201)).body)).not.toBe(started);
    } finally {
      // Every other suite signs in to this operator, so it is never left suspended by a failure here.
      await prisma.tenant.update({
        where: { id: TENANT_BOOTSTRAP_ID },
        data: { status: TenantStatus.ACTIVE },
      });
      await cache.del(tenantRegistryKey(TENANT_BOOTSTRAP_ID));
    }
  });

  it('refuses to activate an operator that never served until per-operator Ichancy sign-in exists, and changes nothing', async () => {
    const refused = await api()
      .post(`/v1/admin/tenants/${suspendedId}/activate`)
      .set('authorization', platformBearer)
      .expect(503);
    expect(failure(refused.body)).toMatchObject({
      code: 'TENANT_ACTIVATION_UNAVAILABLE',
      message: expect.stringContaining('The operator stays suspended'),
    });
    const row = await prisma.tenant.findUniqueOrThrow({
      where: { id: suspendedId },
      select: { status: true },
    });
    expect(row.status).toBe(TenantStatus.SUSPENDED);

    // An operator that is already serving is answered as it is.
    const zero = await api()
      .post(`/v1/admin/tenants/${TENANT_ZERO_ID}/activate`)
      .set('authorization', platformBearer)
      .expect(200);
    expect(tenantSchema.parse((zero.body as Body).data).status).toBe('ACTIVE');
  });

  it('seeds platform defaults from the env on first read, exactly once, even when first reads race', async () => {
    // The row exactly as the multi-tenant migration leaves it: literals, never seeded.
    await prisma.platformDefaults.update({
      where: { id: 1 },
      data: {
        ichancyBaseUrl: 'https://agents.ichancy.com',
        ichancyAgentId: null,
        currencyCode: 'NSP',
        dualApprovalThresholdMinor: 0n,
        agentFloatLowWatermarkMinor: 0n,
        depositExpiryMinutes: 30,
        seededFromEnvAt: null,
      },
    });
    const seededBefore = await auditCount(TENANT_ZERO_ID, 'platform.defaults.seeded');

    const answers = await Promise.all(
      [0, 1, 2].map(() =>
        api().get('/v1/admin/platform-defaults').set('authorization', platformBearer).expect(200),
      ),
    );

    const expected = {
      ichancyBaseUrl: config.ichancy.baseUrl,
      ichancyAgentId: config.ichancy.agentId,
      currencyCode: config.ichancy.currency,
      dualApprovalThresholdMinor: config.limits.dualApprovalThresholdMinor.toString(),
      agentFloatLowWatermarkMinor: config.limits.agentFloatLowWatermarkMinor.toString(),
      depositExpiryMinutes: config.limits.depositExpiryMinutes,
      appliesToNewOperatorsOnly: true,
    };
    for (const answer of answers) {
      const view = platformDefaultsSchema.parse((answer.body as Body).data);
      expect(view).toMatchObject(expected);
      expect(view).not.toHaveProperty('seededFromEnvAt');
    }
    expect(await auditCount(TENANT_ZERO_ID, 'platform.defaults.seeded')).toBe(seededBefore + 1);

    const row = await prisma.platformDefaults.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.seededFromEnvAt).not.toBeNull();

    // A later read answers the stored row and seeds nothing.
    await api().get('/v1/admin/platform-defaults').set('authorization', platformBearer).expect(200);
    expect(await auditCount(TENANT_ZERO_ID, 'platform.defaults.seeded')).toBe(seededBefore + 1);
  });

  it('PATCH platform defaults changes only the keys sent, and refuses unknown and inactive currencies distinctly', async () => {
    const before = platformDefaultsSchema.parse(
      (
        (await api().get('/v1/admin/platform-defaults').set('authorization', platformBearer).expect(200))
          .body as Body
      ).data,
    );
    const updatedBefore = await auditCount(TENANT_ZERO_ID, 'platform.defaults.updated');

    const response = await api()
      .patch('/v1/admin/platform-defaults')
      .set('authorization', platformBearer)
      .send({ ichancyAgentId: '10500', depositExpiryMinutes: 45 })
      .expect(200);
    expect(platformDefaultsSchema.parse((response.body as Body).data)).toMatchObject({
      ...before,
      ichancyAgentId: '10500',
      depositExpiryMinutes: 45,
      updatedAt: expect.any(String),
    });
    expect(await auditCount(TENANT_ZERO_ID, 'platform.defaults.updated')).toBe(updatedBefore + 1);

    const unknown = await api()
      .patch('/v1/admin/platform-defaults')
      .set('authorization', platformBearer)
      .send({ currencyCode: 'XQQ' })
      .expect(400);
    expect(failure(unknown.body).code).toBe('VALIDATION_FAILED');
    expect(fieldsOf(unknown.body)).toEqual(['currencyCode: there is no currency XQQ']);

    await prisma.currency.create({
      data: { code: INACTIVE_CURRENCY, name: 'P9 retired', scale: 2, isActive: false },
    });
    const inactive = await api()
      .patch('/v1/admin/platform-defaults')
      .set('authorization', platformBearer)
      .send({ currencyCode: INACTIVE_CURRENCY })
      .expect(400);
    expect(failure(inactive.body).code).toBe('VALIDATION_FAILED');
    expect(fieldsOf(inactive.body)).toEqual([
      `currencyCode: ${INACTIVE_CURRENCY} exists but is not active, so no new operator may use it`,
    ]);

    // Clearing the house agent is not something a PATCH can do by accident.
    const cleared = await api()
      .patch('/v1/admin/platform-defaults')
      .set('authorization', platformBearer)
      .send({ ichancyAgentId: null })
      .expect(400);
    expect(fieldsOf(cleared.body)[0]).toMatch(/^ichancyAgentId/);

    const after = platformDefaultsSchema.parse(
      (
        (await api().get('/v1/admin/platform-defaults').set('authorization', platformBearer).expect(200))
          .body as Body
      ).data,
    );
    expect(after).toMatchObject({ ichancyAgentId: '10500', currencyCode: before.currencyCode });
    expect(await auditCount(TENANT_ZERO_ID, 'platform.defaults.updated')).toBe(updatedBefore + 1);
  });
});
