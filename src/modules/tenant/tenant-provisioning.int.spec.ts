/**
 * Creating and operating an operator's Telegram side through the REAL api: AppModule, the real
 * middleware, guards, validation pipe, idempotency interceptor, exception filter, Postgres and Redis.
 * Callers sign in through the real credentials route, as the console does.
 *
 * TELEGRAM IS THE OFFLINE FAKE (test/setup/telegram-fixtures.ts), injected at the fetch level into the
 * app's own TenantBotRegistry: every getMe, setWebhook and setMyCommands still goes through grammY's
 * request building and the registry's transformers, and every call is recorded with the token it used.
 * No request can reach api.telegram.org. Ichancy is the fake adapter (ICHANCY_FAKE=1 in the test env),
 * and nothing here signs in to it: activation is not attempted yet.
 *
 * API_BASE_URL is an https URL for this suite, because registering an http one is refused before
 * Telegram is asked (unit-tested). The laptop's real failure, Telegram refusing a URL it cannot
 * deliver to, is scripted on the fake.
 *
 * What only this level proves:
 *  - a create answers 201 with a body the console's own zod schemas parse, provisioning included, and
 *    the webhook Telegram was given is exactly this deployment's URL with the operator's own secret;
 *  - a token Telegram refuses never lands a row; an idempotent replay creates one operator;
 *  - slug collisions, default resolution and every refusal arrive in the envelope the console renders;
 *  - a legacy row gets a path token AND a secret on registration, and the ingress accepts them at once;
 *  - replacing a bot evicts the cached Bot, so the very next send uses the new token;
 *  - health's webhookMatches follows what Telegram holds, not what the row says;
 *  - the owner flow, end to end, from the seeded platform admin to an update routed to the operator.
 *
 * `tenants`, `platform_defaults` and `currencies` survive truncateAll, so the operators this suite adds
 * carry a run-unique slug prefix and are deleted in afterAll, after a reset has cleared the append-only
 * audit rows holding them in place. API_BASE_URL and the defaults row are restored to what they held.
 *
 * Run with the escape hatch (no testcontainers):
 *   POSTGRES_TEST_URL=... REDIS_TEST_URL=... TEST_REDIS_URL=... TEST_DATABASE_URL=... \
 *     npx jest --config jest-int.config.cjs --runInBand src/modules/tenant/tenant-provisioning.int.spec.ts
 */
import { randomUUID } from 'node:crypto';

import { getQueueToken } from '@nestjs/bullmq';
import { AdminRole, TenantStatus, type PlatformDefaults } from '@prisma/client';
import { type Queue } from 'bullmq';
import { type Update } from 'grammy/types';
import request from 'supertest';
import { z } from 'zod';

import { PasswordHasherService } from '@core/auth/services/password-hasher.service';
import { InitDataService } from '@core/auth/services/init-data.service';
import { CacheService } from '@core/cache/cache.service';
import { PrismaService } from '@core/prisma/prisma.service';
import { BotService } from '@core/telegram/services/bot.service';
import { TelegramHandlerRegistrar } from '@core/telegram/services/handler-registrar.service';
import { TenantBotRegistry } from '@core/telegram/services/tenant-bot-registry.service';
import {
  TELEGRAM_ALLOWED_UPDATES,
  TELEGRAM_SECRET_HEADER,
  TELEGRAM_UPDATE_QUEUE,
  telegramUpdateJobId,
} from '@core/telegram/telegram.constants';
import { type TelegramUpdateJobData } from '@core/telegram/telegram.types';
import { TenantSecretService } from '@core/tenant/services/tenant-secret.service';
import { TENANT_ZERO_ID, tenantRegistryKey } from '@core/tenant/tenant.constants';

import { seedPlatformAdmin } from '../../../prisma/seed/platform-admin.seed';
import { createTestApp, type TestApp } from '../../../test/setup/app-factory';
import { createFakeTelegram, testBotInfo } from '../../../test/setup/telegram-fixtures';

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
const tenantWebhookSchema = z.looseObject({
  url: z.string().nullable(),
  registered: z.boolean(),
  pendingUpdateCount: z.number(),
  lastErrorMessage: z.string().nullable(),
  lastErrorDate: isoDateTime.nullable(),
});
const tenantBotSetupSchema = z.looseObject({ commandsSet: z.number(), scopes: z.array(z.string()) });
const tenantHealthSchema = z.looseObject({
  bot: z.looseObject({
    ok: z.boolean(),
    username: z.string().nullable(),
    webhookUrl: z.string().nullable(),
    webhookMatches: z.boolean(),
    pendingUpdateCount: z.number(),
    lastErrorMessage: z.string().nullable(),
    lastErrorDate: isoDateTime.nullable(),
  }),
  ichancy: z.looseObject({
    ok: z.boolean(),
    baseUrl: z.string(),
    username: z.string(),
    agentId: z.string(),
    checkedAt: isoDateTime,
    error: z.string().nullable(),
    floatMinor: z.string().nullable(),
    belowWatermark: z.boolean(),
    sharesAgentWith: z.array(z.string()),
  }),
  counts: z.looseObject({ players: z.number(), deposits: z.number() }),
});
// Strict on the two import fields (the console reads them with `.catch()` fallbacks): this backend
// must actually send them.
const tenantProvisioningSchema = z.looseObject({
  webhookRegistered: z.boolean(),
  webhookUrl: z.string().nullable(),
  webhookError: z.string().nullable(),
  menusPushed: z.boolean(),
  menuScopes: z.array(z.string()),
  menuError: z.string().nullable(),
  activated: z.boolean(),
  activationError: z.string().nullable(),
  paymentMethodsCreated: z.number(),
  paymentMethodsError: z.string().nullable(),
  paymentMethodsNeedAccounts: z.boolean(),
  playersImported: z.number(),
  playersImportError: z.string().nullable(),
});
const tenantCreatedSchema = tenantSchema.extend({ provisioning: tenantProvisioningSchema });
const errorEnvelopeSchema = z.looseObject({
  success: z.literal(false),
  data: z.null(),
  error: z.looseObject({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

const RUN = Date.now().toString(36);
/** Every operator this suite creates starts with it, so a crashed run's leftovers are found. */
const SLUG_PREFIX = 'p10-int-';
const BASE_URL = 'https://api.p10-int.example';
const PASSWORD = 'Correct-Horse-10';
const AGENT_PASSWORD = 'agent password with spaces';
const PLATFORM_DEFAULT_AGENT = '10045';
const SHARED_AGENT_LOGIN = `p10-agent-${RUN}`;
const PLATFORM_TELEGRAM_ID = 7_100_000_000n + BigInt(Date.now() % 1_000_000);
const OWNER_TELEGRAM_ID = PLATFORM_TELEGRAM_ID + 1n;
const login = (name: string): string => `p10-${RUN}-${name}`;

let nextBot = 0;
/** A fresh BotFather-shaped token whose numeric id is its bot's id, as Telegram's are. */
const newToken = (): { token: string; botId: number } => {
  nextBot += 1;
  const botId = 710_000_000 + nextBot;
  return { token: `${botId}:AAp10int${RUN}n${nextBot}${'x'.repeat(30)}`, botId };
};

let nextUpdateId = Date.now();
const messageUpdate = (): Update => {
  nextUpdateId += 1;
  return {
    update_id: nextUpdateId,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 555, type: 'private', first_name: 'Player' },
      from: { id: 555, is_bot: false, first_name: 'Player' },
      text: '/start',
    },
  };
};

type Body = { success: boolean; data: unknown; error: unknown };

describe('Tenant creation and Telegram operations (integration)', () => {
  const telegram = createFakeTelegram();

  let ctx: TestApp;
  let prisma: PrismaService;
  let cache: CacheService;
  let secrets: TenantSecretService;
  let platformBearer: string;
  let consoleOnlyBearer: string;
  let defaultsBefore: PlatformDefaults | null = null;
  let baseUrlBefore: string | undefined;

  const api = () => request(ctx.httpServer);

  const failure = (body: unknown) => errorEnvelopeSchema.parse(body).error;
  const fieldsOf = (body: unknown): string[] =>
    z.looseObject({ fields: z.array(z.string()) }).parse(failure(body).details).fields;

  /** The four fields the console's form requires, with a token Telegram accepts unless told not to. */
  const fourFields = (
    name: string,
    options: { accept?: boolean; agentLogin?: string } = {},
  ): { body: Record<string, unknown>; token: string; username: string } => {
    const { token, botId } = newToken();
    const username = `p10_${name.replace(/-/g, '_')}_${RUN}_bot`;
    if (options.accept !== false) telegram.accept(token, testBotInfo(botId, username));
    return {
      token,
      username,
      body: {
        displayName: `P10 int ${RUN} ${name}`,
        botToken: token,
        ichancyUsername: options.agentLogin ?? `p10-agent-${name}`,
        ichancyPassword: AGENT_PASSWORD,
      },
    };
  };

  const postTenant = (bearer: string, body: Record<string, unknown>): request.Test =>
    api().post('/v1/admin/tenants').set('authorization', bearer).send(body);

  const createOperator = async (
    name: string,
    options: { accept?: boolean; agentLogin?: string; extra?: Record<string, unknown> } = {},
  ): Promise<{ id: string; token: string; username: string; created: z.infer<typeof tenantCreatedSchema> }> => {
    const fields = fourFields(name, options);
    const response = await postTenant(platformBearer, { ...fields.body, ...options.extra }).expect(201);
    const created = tenantCreatedSchema.parse((response.body as Body).data);
    return { id: created.id, token: fields.token, username: fields.username, created };
  };

  const auditCount = (tenantId: string, action: string): Promise<number> =>
    prisma.auditLog.count({ where: { tenantId, action } });

  const signIn = async (username: string): Promise<string> => {
    const response = await api()
      .post('/v1/admin/auth/credentials')
      .send({ username, password: PASSWORD })
      .expect(200);
    return `Bearer ${z.looseObject({ accessToken: z.string() }).parse((response.body as Body).data).accessToken}`;
  };

  const removeSuiteRows = async (): Promise<void> => {
    await prisma.tenant.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
  };

  beforeAll(async () => {
    baseUrlBefore = process.env.API_BASE_URL;
    ctx = await createTestApp({
      env: { API_BASE_URL: BASE_URL },
      customize: (builder) => {
        // The app's own registry, built with the offline Telegram as its client.
        builder.overrideProvider(TenantBotRegistry).useFactory({
          factory: (
            prismaService: PrismaService,
            cacheService: CacheService,
            secretService: TenantSecretService,
            registrar: TelegramHandlerRegistrar,
          ) =>
            new TenantBotRegistry(
              prismaService,
              cacheService,
              secretService,
              registrar,
              telegram.clientOptions,
            ),
          inject: [PrismaService, CacheService, TenantSecretService, TelegramHandlerRegistrar],
        });
      },
    });
    await new Promise<void>((resolve) => {
      ctx.httpServer.listen(0, '127.0.0.1', resolve);
    });

    prisma = ctx.app.get(PrismaService);
    cache = ctx.app.get(CacheService);
    secrets = ctx.app.get(TenantSecretService);
    const hasher = ctx.app.get(PasswordHasherService);

    await ctx.reset();
    await removeSuiteRows();
    defaultsBefore = await prisma.platformDefaults.findUnique({ where: { id: 1 } });
    // A named house agent, and marked seeded so the first read does not overwrite it from the env.
    await prisma.platformDefaults.update({
      where: { id: 1 },
      data: { ichancyAgentId: PLATFORM_DEFAULT_AGENT, seededFromEnvAt: new Date() },
    });

    const hash = await hasher.hash(PASSWORD);
    await prisma.adminUser.create({
      data: {
        tenantId: TENANT_ZERO_ID,
        username: login('platform'),
        displayName: 'P10 platform admin',
        role: AdminRole.PLATFORM_ADMIN,
        isActive: true,
        passwordHash: hash,
        telegramUserId: PLATFORM_TELEGRAM_ID,
      },
    });
    await prisma.adminUser.create({
      data: {
        tenantId: TENANT_ZERO_ID,
        username: login('console-only'),
        displayName: 'P10 console-only admin',
        role: AdminRole.PLATFORM_ADMIN,
        isActive: true,
        passwordHash: hash,
        telegramUserId: null,
      },
    });
    platformBearer = await signIn(login('platform'));
    consoleOnlyBearer = await signIn(login('console-only'));
  });

  afterAll(async () => {
    if (ctx !== undefined) {
      // Reset first: it truncates audit_logs (append-only) so the suite's operators can be deleted.
      await ctx.reset();
      await removeSuiteRows();
      if (defaultsBefore !== null) {
        const { id: _id, updatedAt: _updatedAt, ...values } = defaultsBefore;
        await prisma.platformDefaults.update({ where: { id: 1 }, data: values });
      }
      await ctx.close();
    }
    if (baseUrlBefore === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = baseUrlBefore;
  });

  it('creates an operator from four fields: verified, sealed, SUSPENDED, webhook and menus pushed, rails on placeholders', async () => {
    const fields = fourFields('north', { agentLogin: SHARED_AGENT_LOGIN });
    const response = await postTenant(platformBearer, fields.body).expect(201);
    const created = tenantCreatedSchema.parse((response.body as Body).data);
    const defaults = await prisma.platformDefaults.findUniqueOrThrow({ where: { id: 1 } });

    expect(created).toMatchObject({
      slug: `${SLUG_PREFIX}${RUN}-north`,
      displayName: `P10 int ${RUN} north`,
      status: 'SUSPENDED',
      hasWebhookPath: true,
      adminChatId: PLATFORM_TELEGRAM_ID.toString(),
      feedChatId: null,
      botUsername: fields.username,
      ichancyBaseUrl: defaults.ichancyBaseUrl,
      ichancyUsername: SHARED_AGENT_LOGIN,
      ichancyAgentId: PLATFORM_DEFAULT_AGENT,
      currencyCode: defaults.currencyCode,
      dualApprovalThresholdMinor: defaults.dualApprovalThresholdMinor.toString(),
      agentFloatLowWatermarkMinor: defaults.agentFloatLowWatermarkMinor.toString(),
      depositExpiryMinutes: defaults.depositExpiryMinutes,
      depositMode: 'MANUAL',
      withdrawalMode: 'MANUAL',
      miniAppUrl: null,
    });
    expect(created.provisioning).toEqual({
      webhookRegistered: true,
      webhookUrl: `${BASE_URL}/telegram/webhook/[REDACTED]`,
      webhookError: null,
      menusPushed: true,
      menuScopes: ['default', 'all_private_chats', 'chat'],
      menuError: null,
      activated: false,
      activationError: expect.stringMatching(/^Not activated: .*stays suspended\.$/),
      paymentMethodsCreated: 4,
      paymentMethodsError: null,
      paymentMethodsNeedAccounts: true,
      playersImported: 0,
      playersImportError:
        'Players were not imported: the operator was not activated. Import them from the operator once it is.',
    });

    // Sealed on the row, and the webhook Telegram holds is exactly this deployment's, with its secret.
    const row = await prisma.tenant.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.status).toBe(TenantStatus.SUSPENDED);
    expect(row.botTokenEnc).not.toContain(fields.token);
    expect(secrets.openBotToken(row)).toBe(fields.token);
    expect(secrets.openIchancyPassword(row)).toBe(AGENT_PASSWORD);
    expect(row.webhookPathToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const secret = secrets.openWebhookSecret(row);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const setWebhook = telegram.callsFor(fields.token, 'setWebhook');
    expect(setWebhook).toHaveLength(1);
    expect(setWebhook[0]?.payload['url']).toBe(`${BASE_URL}/telegram/webhook/${row.webhookPathToken}`);
    expect(setWebhook[0]?.payload['secret_token']).toBe(secret);
    expect(setWebhook[0]?.payload['allowed_updates']).toEqual([...TELEGRAM_ALLOWED_UPDATES]);
    expect(telegram.callsFor(fields.token, 'setMyCommands').map((call) => call.payload['scope'])).toEqual([
      { type: 'default' },
      { type: 'all_private_chats' },
      { type: 'chat', chat_id: PLATFORM_TELEGRAM_ID.toString() },
    ]);

    const methods = await prisma.paymentMethod.findMany({
      where: { tenantId: created.id },
      select: { code: true, destinations: { select: { tenantId: true, accountIdentifier: true } } },
      orderBy: { sortOrder: 'asc' },
    });
    expect(methods.map((method) => method.code)).toEqual([
      'BANK_TRANSFER_MAIN',
      'EWALLET_MAIN',
      'SHAMCASH_MAIN',
      'SYRIATEL_CASH',
    ]);
    for (const method of methods) {
      expect(method.destinations).toEqual([
        { tenantId: created.id, accountIdentifier: expect.stringMatching(/^SEED-PLACEHOLDER-/) },
      ]);
    }

    // No staff, and every step's evidence in the new operator's own log.
    expect(await prisma.adminUser.count({ where: { tenantId: created.id } })).toBe(0);
    for (const action of [
      'tenant.created',
      'tenant.webhook.registered',
      'tenant.bot.menusPushed',
      'tenant.paymentMethods.provisioned',
      'tenant.provisioned',
    ]) {
      expect(await auditCount(created.id, action)).toBe(1);
    }

    const wire = JSON.stringify(response.body);
    const evidence = JSON.stringify(await prisma.auditLog.findMany({ where: { tenantId: created.id } }));
    for (const credential of [fields.token, AGENT_PASSWORD, row.webhookPathToken ?? '', secret]) {
      expect(wire).not.toContain(credential);
      expect(evidence).not.toContain(credential);
    }
  });

  it('refuses a token Telegram rejects with 400 naming botToken, and never lands a row', async () => {
    const rejected = fourFields('rejected', { accept: false });
    const answer = await postTenant(platformBearer, rejected.body).expect(400);
    expect(failure(answer.body).code).toBe('VALIDATION_FAILED');
    const fields = fieldsOf(answer.body);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatch(/^botToken was not accepted by Telegram \(Telegram answered 401: Unauthorized\)/);
    expect(JSON.stringify(answer.body)).not.toContain(rejected.token);

    expect(await prisma.tenant.count({ where: { slug: `${SLUG_PREFIX}${RUN}-rejected` } })).toBe(0);
    expect(telegram.callsFor(rejected.token).map((call) => call.method)).toEqual(['getMe']);

    // A token not even shaped like one is refused by the DTO, before Telegram is asked.
    const malformed = fourFields('malformed');
    const shape = await postTenant(platformBearer, { ...malformed.body, botToken: 'not-a-token' }).expect(400);
    expect(fieldsOf(shape.body)).toEqual([
      'botToken must look like 123456789:AA... — the token BotFather gave you',
    ]);
    expect(telegram.callsFor('not-a-token')).toHaveLength(0);
  });

  it('replays an idempotent create instead of creating a second operator', async () => {
    const fields = fourFields('replay');
    const key = randomUUID();

    const first = await postTenant(platformBearer, fields.body).set('idempotency-key', key).expect(201);
    const second = await postTenant(platformBearer, fields.body).set('idempotency-key', key).expect(201);

    expect(second.headers['idempotency-replayed']).toBe('true');
    expect((second.body as Body).data).toEqual((first.body as Body).data);
    expect(await prisma.tenant.count({ where: { slug: { startsWith: `${SLUG_PREFIX}${RUN}-replay` } } })).toBe(1);
    expect(telegram.callsFor(fields.token, 'setWebhook')).toHaveLength(1);
  });

  it('de-duplicates a derived slug with -2, and refuses a chosen slug that is taken with 409 before asking Telegram', async () => {
    const first = await createOperator('twin');
    const second = await createOperator('twin');
    expect(first.created.slug).toBe(`${SLUG_PREFIX}${RUN}-twin`);
    expect(second.created.slug).toBe(`${SLUG_PREFIX}${RUN}-twin-2`);

    const chosen = fourFields('chosen');
    const answer = await postTenant(platformBearer, { ...chosen.body, slug: first.created.slug }).expect(409);
    expect(failure(answer.body)).toMatchObject({
      code: 'DUPLICATE_RESOURCE',
      message: 'A record with these values already exists.',
      details: { fields: ['slug'] },
    });
    expect(telegram.callsFor(chosen.token)).toHaveLength(0);

    const free = await postTenant(platformBearer, {
      ...chosen.body,
      slug: `${SLUG_PREFIX}${RUN}-picked`.slice(0, 32).replace(/-+$/, ''),
    }).expect(201);
    expect(tenantCreatedSchema.parse((free.body as Body).data).slug.startsWith(SLUG_PREFIX)).toBe(true);
  });

  it('refuses a bot another operator holds, on create and on bot replace, without touching that operator’s webhook', async () => {
    const holder = await createOperator('bot-holder');
    const holderRow = await prisma.tenant.findUniqueOrThrow({ where: { id: holder.id } });
    const holderUrl = `${BASE_URL}/telegram/webhook/${holderRow.webhookPathToken}`;
    expect(holderRow.botId).toBe(BigInt(holder.token.split(':')[0] ?? ''));
    expect(telegram.webhookFor(holder.token)).toMatchObject({ url: holderUrl });
    const setWebhooksBefore = telegram.callsFor(holder.token, 'setWebhook').length;

    // Create with the holder's token: 409 naming botToken, no row, and the holder's bot keeps
    // delivering to the holder.
    const reuse = fourFields('bot-reuse');
    const refused = await postTenant(platformBearer, { ...reuse.body, botToken: holder.token }).expect(409);
    expect(failure(refused.body).code).toBe('DUPLICATE_RESOURCE');
    expect(fieldsOf(refused.body)).toEqual(['botToken']);
    expect(JSON.stringify(refused.body)).not.toContain(holder.token);
    expect(await prisma.tenant.count({ where: { displayName: reuse.body['displayName'] as string } })).toBe(0);
    expect(telegram.callsFor(holder.token, 'setWebhook')).toHaveLength(setWebhooksBefore);
    expect(telegram.callsFor(holder.token, 'setMyCommands').length).toBeGreaterThan(0);
    expect(telegram.webhookFor(holder.token)).toMatchObject({ url: holderUrl });

    // Replace another operator's bot with the holder's token: 409, and no deleteWebhook reaches the
    // holder's bot through the shared token.
    const other = await createOperator('bot-other');
    const otherBefore = await prisma.tenant.findUniqueOrThrow({ where: { id: other.id } });
    const deletesBefore = telegram.callsFor(holder.token, 'deleteWebhook').length;
    const swap = await api()
      .patch(`/v1/admin/tenants/${other.id}/bot`)
      .set('authorization', platformBearer)
      .send({ botToken: holder.token })
      .expect(409);
    expect(failure(swap.body).code).toBe('DUPLICATE_RESOURCE');
    expect(fieldsOf(swap.body)).toEqual(['botToken']);
    expect(telegram.callsFor(holder.token, 'deleteWebhook')).toHaveLength(deletesBefore);
    expect(telegram.callsFor(other.token, 'deleteWebhook')).toHaveLength(0);
    expect(telegram.webhookFor(holder.token)).toMatchObject({ url: holderUrl });
    const otherAfter = await prisma.tenant.findUniqueOrThrow({ where: { id: other.id } });
    expect(otherAfter.botTokenEnc).toBe(otherBefore.botTokenEnc);
    expect(otherAfter.botId).toBe(otherBefore.botId);

    // Re-pasting an operator's own bot (a token regenerated at BotFather) is not a duplicate.
    await api()
      .patch(`/v1/admin/tenants/${holder.id}/bot`)
      .set('authorization', platformBearer)
      .send({ botToken: holder.token })
      .expect(200);

    // A row written before bot_id existed holds only a sealed token; it is found by opening it.
    const { token: legacyToken, botId: legacyBotId } = newToken();
    telegram.accept(legacyToken, testBotInfo(legacyBotId, `p10_prebotid_${RUN}_bot`));
    await prisma.tenant.create({
      data: {
        slug: `${SLUG_PREFIX}${RUN}-pre-bot-id`,
        displayName: 'P10 pre bot_id',
        status: TenantStatus.SUSPENDED,
        botTokenEnc: secrets.sealBotToken(legacyToken),
        adminChatId: 1n,
        ichancyBaseUrl: 'https://example.invalid',
        ichancyUsername: 'p10-pre-bot-id-agent',
        ichancyPasswordEnc: secrets.sealIchancyPassword('legacy agent password'),
        ichancyAgentId: '10098',
        currencyCode: 'NSP',
        dualApprovalThresholdMinor: 0n,
        agentFloatLowWatermarkMinor: 0n,
        depositExpiryMinutes: 30,
      },
    });
    const legacyReuse = fourFields('bot-legacy-reuse');
    const legacyRefused = await postTenant(platformBearer, { ...legacyReuse.body, botToken: legacyToken }).expect(409);
    expect(fieldsOf(legacyRefused.body)).toEqual(['botToken']);
    expect(telegram.callsFor(legacyToken, 'setWebhook')).toHaveLength(0);
  });

  it('resolves the admin chat and the agent id as the contract orders, refusing by field name where nothing is left', async () => {
    // A console-only platform admin has no Telegram id to default the admin chat to.
    const orphan = fourFields('orphan');
    const noChat = await postTenant(consoleOnlyBearer, orphan.body).expect(400);
    expect(fieldsOf(noChat.body)).toEqual([expect.stringMatching(/^adminChatId is required/)]);
    expect(telegram.callsFor(orphan.token)).toHaveLength(0);

    const named = await postTenant(consoleOnlyBearer, { ...orphan.body, adminChatId: '-1001234567890' }).expect(201);
    const namedView = tenantCreatedSchema.parse((named.body as Body).data);
    expect(namedView.adminChatId).toBe('-1001234567890');
    expect(namedView.provisioning.menuScopes).toEqual(['default', 'all_private_chats', 'chat_administrators']);

    // No house agent, and tenant zero's is a placeholder: 400 naming the field, in the mock's words.
    await prisma.platformDefaults.update({ where: { id: 1 }, data: { ichancyAgentId: null } });
    try {
      const agentless = fourFields('agentless');
      const noAgent = await postTenant(platformBearer, agentless.body).expect(400);
      expect(fieldsOf(noAgent.body)).toEqual([
        'ichancyAgentId is required: no platform default and no tenant zero to fall back to',
      ]);
      expect(telegram.callsFor(agentless.token)).toHaveLength(0);

      // Supplied values win over every default, currency upper-cased as the form does.
      const supplied = await postTenant(platformBearer, {
        ...agentless.body,
        ichancyAgentId: '20077',
        currencyCode: 'nsp',
        dualApprovalThresholdMinor: '75000000',
        depositExpiryMinutes: 45,
        withdrawalMode: 'AUTO',
        feedChatId: '-1009876543210',
      }).expect(201);
      expect(tenantCreatedSchema.parse((supplied.body as Body).data)).toMatchObject({
        ichancyAgentId: '20077',
        currencyCode: 'NSP',
        dualApprovalThresholdMinor: '75000000',
        depositExpiryMinutes: 45,
        withdrawalMode: 'AUTO',
        feedChatId: '-1009876543210',
      });
    } finally {
      await prisma.platformDefaults.update({
        where: { id: 1 },
        data: { ichancyAgentId: PLATFORM_DEFAULT_AGENT },
      });
    }

    // An optional field sent empty is refused, never stored as the empty value.
    const empty = fourFields('empty');
    const blank = await postTenant(platformBearer, { ...empty.body, currencyCode: '' }).expect(400);
    expect(fieldsOf(blank.body)[0]).toMatch(/^currencyCode/);
  });

  it('answers 201 with webhookRegistered false and Telegram’s reason when Telegram refuses the URL, as on the laptop', async () => {
    const fields = fourFields('laptop', { agentLogin: SHARED_AGENT_LOGIN });
    const reason = 'Bad Request: bad webhook: Failed to resolve host: Name or service not known';
    telegram.refuseWebhook(fields.token, reason);

    const response = await postTenant(platformBearer, fields.body).expect(201);
    const created = tenantCreatedSchema.parse((response.body as Body).data);

    expect(created.hasWebhookPath).toBe(true);
    expect(created.provisioning).toMatchObject({
      webhookRegistered: false,
      webhookUrl: null,
      webhookError: `Telegram refused to register the webhook: ${reason}`,
      menusPushed: true,
      paymentMethodsCreated: 4,
    });
    expect(await prisma.tenant.count({ where: { id: created.id } })).toBe(1);
    expect(await auditCount(created.id, 'tenant.webhook.registered')).toBe(0);

    const health = tenantHealthSchema.parse(
      ((await api().get(`/v1/admin/tenants/${created.id}/health`).set('authorization', platformBearer).expect(200))
        .body as Body).data,
    );
    expect(health.bot).toMatchObject({ ok: false, webhookUrl: null, webhookMatches: false });

    // The explicit route answers the same refusal as a contract error, never a 500.
    const retry = await api()
      .post(`/v1/admin/tenants/${created.id}/webhook`)
      .set('authorization', platformBearer)
      .expect(422);
    expect(failure(retry.body)).toMatchObject({
      code: 'TENANT_TELEGRAM_REJECTED',
      message: `Telegram refused to register the webhook: ${reason}`,
    });
    telegram.allowWebhook(fields.token);
  });

  it('gives a legacy operator a path token AND a secret on registration, which the webhook route accepts at once', async () => {
    const { token, botId } = newToken();
    telegram.accept(token, testBotInfo(botId, `p10_legacy_${RUN}_bot`));
    const legacy = await prisma.tenant.create({
      data: {
        slug: `${SLUG_PREFIX}${RUN}-legacy`,
        displayName: 'P10 legacy',
        status: TenantStatus.SUSPENDED,
        botTokenEnc: secrets.sealBotToken(token),
        webhookPathToken: null,
        webhookSecretEnc: null,
        adminChatId: 0n,
        ichancyBaseUrl: 'https://example.invalid',
        ichancyUsername: 'p10-legacy-agent',
        ichancyPasswordEnc: secrets.sealIchancyPassword('legacy agent password'),
        ichancyAgentId: '10099',
        currencyCode: 'NSP',
        dualApprovalThresholdMinor: 0n,
        agentFloatLowWatermarkMinor: 0n,
        depositExpiryMinutes: 30,
      },
      select: { id: true },
    });

    const response = await api()
      .post(`/v1/admin/tenants/${legacy.id}/webhook`)
      .set('authorization', platformBearer)
      .expect(200);
    expect(tenantWebhookSchema.parse((response.body as Body).data)).toEqual({
      url: `${BASE_URL}/telegram/webhook/[REDACTED]`,
      registered: true,
      pendingUpdateCount: 0,
      lastErrorMessage: null,
      lastErrorDate: null,
    });

    const row = await prisma.tenant.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(row.webhookPathToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const secret = secrets.openWebhookSecret(row);
    expect(telegram.webhookFor(token)).toMatchObject({
      url: `${BASE_URL}/telegram/webhook/${row.webhookPathToken}`,
      secretToken: secret,
    });
    expect(await auditCount(legacy.id, 'tenant.webhook.credentialsGenerated')).toBe(1);
    expect(JSON.stringify(response.body)).not.toContain(row.webhookPathToken ?? '');

    // The ingress knows the new credentials immediately. SUSPENDED: accepted and dropped.
    const path = `/telegram/webhook/${row.webhookPathToken}`;
    await api().post(path).set(TELEGRAM_SECRET_HEADER, 'not-the-secret').send(messageUpdate()).expect(403);
    const accepted = await api().post(path).set(TELEGRAM_SECRET_HEADER, secret).send(messageUpdate()).expect(200);
    expect(accepted.body).toMatchObject({ success: true, data: { ok: true } });

    // Registering again keeps the credentials Telegram now holds.
    await api().post(`/v1/admin/tenants/${legacy.id}/webhook`).set('authorization', platformBearer).expect(200);
    const again = await prisma.tenant.findUniqueOrThrow({ where: { id: legacy.id } });
    expect([again.webhookPathToken, again.webhookSecretEnc]).toEqual([row.webhookPathToken, row.webhookSecretEnc]);
    expect(await auditCount(legacy.id, 'tenant.webhook.credentialsGenerated')).toBe(1);

    // DELETE stops delivery and leaves the operator exactly as it was.
    const removed = await api()
      .delete(`/v1/admin/tenants/${legacy.id}/webhook`)
      .set('authorization', platformBearer)
      .expect(200);
    expect(tenantWebhookSchema.parse((removed.body as Body).data)).toMatchObject({ url: null, registered: false });
    expect(telegram.webhookFor(token)).toBeNull();
    const afterRemoval = await prisma.tenant.findUniqueOrThrow({
      where: { id: legacy.id },
      select: { status: true, webhookPathToken: true },
    });
    expect(afterRemoval).toEqual({ status: TenantStatus.SUSPENDED, webhookPathToken: row.webhookPathToken });

    // Tenant zero has no bot: refused by code, and nothing is generated for it.
    const zeroBefore = await prisma.tenant.findUniqueOrThrow({
      where: { id: TENANT_ZERO_ID },
      select: { webhookPathToken: true, webhookSecretEnc: true },
    });
    const zero = await api()
      .post(`/v1/admin/tenants/${TENANT_ZERO_ID}/webhook`)
      .set('authorization', platformBearer)
      .expect(422);
    expect(failure(zero.body).code).toBe('TENANT_BOT_UNAVAILABLE');
    expect(
      await prisma.tenant.findUniqueOrThrow({
        where: { id: TENANT_ZERO_ID },
        select: { webhookPathToken: true, webhookSecretEnc: true },
      }),
    ).toEqual(zeroBefore);
  });

  it('pushes the command menus on demand, per the contract shape', async () => {
    const operator = await createOperator('menus');
    const before = telegram.callsFor(operator.token, 'setMyCommands').length;

    const response = await api()
      .post(`/v1/admin/tenants/${operator.id}/bot-setup`)
      .set('authorization', platformBearer)
      .expect(200);

    expect(tenantBotSetupSchema.parse((response.body as Body).data)).toEqual({
      commandsSet: 15,
      scopes: ['default', 'all_private_chats', 'chat'],
    });
    expect(telegram.callsFor(operator.token, 'setMyCommands')).toHaveLength(before + 3);
    expect(await auditCount(operator.id, 'tenant.bot.menusPushed')).toBe(2);
  });

  it('replaces the bot: verified, old webhook cleared, caches evicted, and the very next send uses the new token', async () => {
    const operator = await createOperator('swap');
    const bots = ctx.app.get(BotService);
    const initDataInvalidate = jest.spyOn(ctx.app.get(InitDataService), 'invalidate');
    const rowBefore = await prisma.tenant.findUniqueOrThrow({ where: { id: operator.id } });

    try {
      // The registry now holds a Bot built from the old token.
      await bots.sendMessage(operator.id, 555, 'before the swap');
      expect(telegram.callsFor(operator.token, 'sendMessage')).toHaveLength(1);

      // A replacement Telegram refuses changes nothing.
      const refused = fourFields('swap-refused', { accept: false });
      const bad = await api()
        .patch(`/v1/admin/tenants/${operator.id}/bot`)
        .set('authorization', platformBearer)
        .send({ botToken: refused.token })
        .expect(400);
      expect(fieldsOf(bad.body)[0]).toMatch(/^botToken was not accepted by Telegram/);
      expect((await prisma.tenant.findUniqueOrThrow({ where: { id: operator.id } })).botTokenEnc).toBe(
        rowBefore.botTokenEnc,
      );

      const next = fourFields('swap-new');
      const response = await api()
        .patch(`/v1/admin/tenants/${operator.id}/bot`)
        .set('authorization', platformBearer)
        .send({ botToken: next.token })
        .expect(200);
      expect(tenantSchema.parse((response.body as Body).data)).toMatchObject({
        id: operator.id,
        botUsername: next.username,
        hasWebhookPath: true,
      });

      const row = await prisma.tenant.findUniqueOrThrow({ where: { id: operator.id } });
      expect(secrets.openBotToken(row)).toBe(next.token);
      expect(row.webhookPathToken).toBe(rowBefore.webhookPathToken);
      expect(row.webhookSecretEnc).not.toBe(rowBefore.webhookSecretEnc);
      expect(telegram.callsFor(operator.token, 'deleteWebhook')).toHaveLength(1);
      expect(telegram.webhookFor(operator.token)).toBeNull();
      expect(initDataInvalidate).toHaveBeenCalledWith(operator.id);
      expect(await auditCount(operator.id, 'tenant.bot.replaced')).toBe(1);

      await bots.sendMessage(operator.id, 555, 'after the swap');
      expect(telegram.callsFor(next.token, 'sendMessage')).toHaveLength(1);
      expect(telegram.callsFor(operator.token, 'sendMessage')).toHaveLength(1);

      // The console sends the admin back to "register webhook"; health agrees until it is done.
      const health = tenantHealthSchema.parse(
        ((await api().get(`/v1/admin/tenants/${operator.id}/health`).set('authorization', platformBearer).expect(200))
          .body as Body).data,
      );
      expect(health.bot).toMatchObject({ ok: false, username: next.username, webhookMatches: false });

      await api().post(`/v1/admin/tenants/${operator.id}/webhook`).set('authorization', platformBearer).expect(200);
      expect(telegram.webhookFor(next.token)).toMatchObject({
        url: `${BASE_URL}/telegram/webhook/${row.webhookPathToken}`,
        secretToken: secrets.openWebhookSecret(row),
      });
    } finally {
      initDataInvalidate.mockRestore();
    }
  });

  it('reports health from what Telegram holds: webhookMatches true, false for another deployment, not ok with a delivery error', async () => {
    const north = await prisma.tenant.findUniqueOrThrow({
      where: { slug: `${SLUG_PREFIX}${RUN}-north` },
      select: { id: true, botTokenEnc: true, webhookPathToken: true, botUsername: true },
    });
    const token = secrets.openBotToken({ id: north.id, botTokenEnc: north.botTokenEnc });
    const expected = `${BASE_URL}/telegram/webhook/${north.webhookPathToken}`;
    const read = async () =>
      tenantHealthSchema.parse(
        ((await api().get(`/v1/admin/tenants/${north.id}/health`).set('authorization', platformBearer).expect(200))
          .body as Body).data,
      );

    const healthy = await read();
    expect(healthy.bot).toEqual({
      ok: true,
      username: north.botUsername,
      webhookUrl: `${BASE_URL}/telegram/webhook/[REDACTED]`,
      webhookMatches: true,
      pendingUpdateCount: 0,
      lastErrorMessage: null,
      lastErrorDate: null,
    });
    expect(healthy.ichancy).toMatchObject({
      ok: false,
      username: SHARED_AGENT_LOGIN,
      agentId: PLATFORM_DEFAULT_AGENT,
      error: expect.stringMatching(/^Not checked/),
      floatMinor: null,
      belowWatermark: false,
      sharesAgentWith: [`${SLUG_PREFIX}${RUN}-laptop`],
    });
    expect(healthy.counts).toEqual({ players: 0, deposits: 0 });
    expect(JSON.stringify(healthy)).not.toContain(north.webhookPathToken ?? '');

    try {
      telegram.setWebhookState(token, {
        url: `https://old-staging.example/telegram/webhook/${north.webhookPathToken}`,
      });
      expect((await read()).bot).toMatchObject({ ok: false, webhookMatches: false });

      telegram.setWebhookState(token, {
        url: expected,
        pendingUpdateCount: 3,
        lastErrorMessage: 'Wrong response from the webhook: 502 Bad Gateway',
      });
      expect((await read()).bot).toMatchObject({
        ok: false,
        webhookMatches: true,
        pendingUpdateCount: 3,
        lastErrorMessage: 'Wrong response from the webhook: 502 Bad Gateway',
        lastErrorDate: expect.any(String),
      });
    } finally {
      telegram.setWebhookState(token, { url: expected });
    }
  });

  it('runs the owner flow end to end: seeded platform admin, sign in, create, list, webhook, health, and an update routed once ACTIVE', async () => {
    const owner = await seedPlatformAdmin(
      prisma,
      {
        username: login('owner'),
        password: PASSWORD,
        displayName: 'P10 owner',
        telegramUserId: OWNER_TELEGRAM_ID,
        resetPassword: false,
      },
      ctx.app.get(PasswordHasherService),
    );
    expect(owner.outcome).toBe('created');
    const ownerBearer = await signIn(login('owner'));

    const fields = fourFields('owner-flow');
    const created = tenantCreatedSchema.parse(
      ((await postTenant(ownerBearer, fields.body).expect(201)).body as Body).data,
    );
    expect(created).toMatchObject({ status: 'SUSPENDED', adminChatId: OWNER_TELEGRAM_ID.toString() });

    const list = tenantListSchema.parse(
      ((await api().get('/v1/admin/tenants').set('authorization', ownerBearer).expect(200)).body as Body).data,
    );
    expect(list.tenants.find((tenant) => tenant.id === created.id)).toMatchObject({
      slug: created.slug,
      botUsername: fields.username,
      hasWebhookPath: true,
    });

    const webhook = tenantWebhookSchema.parse(
      ((await api().post(`/v1/admin/tenants/${created.id}/webhook`).set('authorization', ownerBearer).expect(200))
        .body as Body).data,
    );
    expect(webhook.registered).toBe(true);

    const health = tenantHealthSchema.parse(
      ((await api().get(`/v1/admin/tenants/${created.id}/health`).set('authorization', ownerBearer).expect(200))
        .body as Body).data,
    );
    expect(health.bot).toMatchObject({ ok: true, webhookMatches: true, username: fields.username });

    // Deliver the way Telegram would: to the URL and with the secret it was given.
    const registration = telegram.webhookFor(fields.token);
    if (registration === null || registration.secretToken === null) {
      throw new Error('Telegram holds no webhook for the new operator');
    }
    const path = registration.url.slice(BASE_URL.length);
    const deliver = (update: Update): request.Test =>
      api().post(path).set(TELEGRAM_SECRET_HEADER, registration.secretToken ?? '').send(update);

    // SUSPENDED: acknowledged so Telegram stops retrying, and nothing is stored.
    await deliver(messageUpdate()).expect(200);
    expect(await prisma.telegramUpdate.count({ where: { tenantId: created.id } })).toBe(0);

    // Activation is a later step, so the status is set directly here, as the contract's activate would.
    await prisma.tenant.update({ where: { id: created.id }, data: { status: TenantStatus.ACTIVE } });
    await cache.del(tenantRegistryKey(created.id));

    const update = messageUpdate();
    const accepted = await deliver(update).expect(200);
    expect(accepted.body).toMatchObject({ success: true, data: { ok: true } });

    const stored = await prisma.telegramUpdate.findMany({
      where: { tenantId: created.id },
      select: { tenantId: true, updateId: true },
    });
    expect(stored).toEqual([{ tenantId: created.id, updateId: BigInt(update.update_id) }]);

    const queue = ctx.app.get<Queue<TelegramUpdateJobData>>(getQueueToken(TELEGRAM_UPDATE_QUEUE));
    const job = await queue.getJob(telegramUpdateJobId(created.id, update.update_id));
    expect(job?.data).toMatchObject({ tenantId: created.id, updateId: String(update.update_id) });
    await job?.remove();
  });
});
