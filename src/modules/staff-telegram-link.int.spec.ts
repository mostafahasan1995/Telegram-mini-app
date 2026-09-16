/**
 * Linking a staff account to Telegram with a one-time code (owner decision 4, 2026-09-15), through the
 * REAL api and the real update pipeline: AppModule, guards, validation, Postgres and Redis; the console
 * routes; the webhook route, the BullMQ job it enqueues and the update processor built from the app's
 * own collaborators, as the worker builds it; and, for the taps, the deposit handlers on a real grammY
 * bot, as src/modules/tenant-isolation.int.spec.ts drives them.
 *
 * TELEGRAM IS THE OFFLINE FAKE (test/setup/telegram-fixtures.ts) at the fetch level; nothing reaches
 * api.telegram.org. Ichancy is the fake adapter (ICHANCY_FAKE=1).
 *
 * What only this level proves:
 *  - the code is shown once and stored only as a keyed digest, nowhere in the update row, the job or
 *    the audit trail; `/link <code>` in a private chat stores the sender's Telegram id on that account;
 *  - a new code revokes the previous one, and a SUSPENDED operator's staff can link;
 *  - another operator's bot, an expired, reused or revoked code, a code posted in a group, a Telegram
 *    account already linked to another staff account and too many attempts are all refused;
 *  - only the staff member (or a platform admin) gets a code; unlinking follows its rules; and the
 *    staff directory still refuses a typed telegramUserId;
 *  - a linked staff member's tap on a card in the staff group is accepted, an unlinked one's refused,
 *    and unlinking takes the tap away at once.
 *
 * Run with the escape hatch (no testcontainers):
 *   POSTGRES_TEST_URL=... REDIS_TEST_URL=... \
 *     npx jest --config jest-int.config.cjs --runInBand src/modules/staff-telegram-link.int.spec.ts
 */
import { randomUUID } from 'node:crypto';

import { getQueueToken } from '@nestjs/bullmq';
import { AdminRole, DepositStatus, PlayerStatus } from '@prisma/client';
import { type Queue } from 'bullmq';
import { Bot } from 'grammy';
import { type Update } from 'grammy/types';
import request from 'supertest';
import { z } from 'zod';

import { ActorContextService } from '@core/actor-context/actor-context.service';
import { AdminIdentityService } from '@core/auth/services/admin-identity.service';
import { SessionService } from '@core/auth/services/session.service';
import { CacheService } from '@core/cache/cache.service';
import { RedisService } from '@core/cache/redis.service';
import { TelegramFileService } from '@core/file/telegram-file.service';
import { PrismaService } from '@core/prisma/prisma.service';
import { TelegramChatProjectionService } from '@core/telegram/chat-binding/chat-projection.service';
import { TelegramUpdateProcessor } from '@core/telegram/processors/telegram-update.processor';
import { BotService } from '@core/telegram/services/bot.service';
import { TelegramHandlerRegistrar } from '@core/telegram/services/handler-registrar.service';
import { TenantBotRegistry } from '@core/telegram/services/tenant-bot-registry.service';
import { UpdateDedupeService } from '@core/telegram/services/update-dedupe.service';
import { staffLinkAttemptsKey } from '@core/telegram/staff-link/staff-link.constants';
import { StaffTelegramLinkService } from '@core/telegram/staff-link/staff-telegram-link.service';
import {
  TELEGRAM_SECRET_HEADER,
  TELEGRAM_UPDATE_QUEUE,
  telegramUpdateJobId,
} from '@core/telegram/telegram.constants';
import { type TelegramUpdateJobData } from '@core/telegram/telegram.types';
import { TenantRegistryService } from '@core/tenant/services/tenant-registry.service';
import { TenantSecretService } from '@core/tenant/services/tenant-secret.service';
import { TENANT_HEADER, TENANT_ZERO_ID } from '@core/tenant/tenant.constants';
import { runWithTenant } from '@core/tenant/tenant.storage';

import { createTestApp, type TestApp } from '../../test/setup/app-factory';
import { createFakeTelegram, testBotInfo } from '../../test/setup/telegram-fixtures';

jest.setTimeout(240_000);

// ── The shapes this surface answers ─────────────────────────────────────────────────────────────
const codeViewSchema = z.object({
  adminUserId: z.string(),
  code: z.string().regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/),
  command: z.string(),
  expiresAt: z.string(),
  ttlSeconds: z.number(),
  botUsername: z.string().nullable(),
  botUrl: z.string().nullable(),
});
const adminViewSchema = z.looseObject({
  id: z.string(),
  telegramUserId: z.string().nullable(),
  telegramLinked: z.boolean(),
});
const errorEnvelopeSchema = z.looseObject({
  success: z.literal(false),
  error: z.looseObject({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
const tenantCreatedSchema = z.looseObject({ id: z.string() });

const RUN = Date.now().toString(36);
const SLUG_PREFIX = 'b2-link-';
const BASE_URL = 'https://api.b2-link.example';
const AGENT_PASSWORD = 'b2 agent password';

/** The one answer every unusable code gets. */
const NOT_VALID = 'This code is not valid or has expired.';
const NOT_AUTHORISED = 'You are not authorised to act on deposits.';

type Body = { success: boolean; data: unknown; error: unknown };

interface Operator {
  id: string;
  token: string;
  botId: number;
  username: string;
}

interface Staff {
  id: string;
  tenantId: string;
  bearer: string;
}

describe('Staff Telegram link (integration)', () => {
  const telegram = createFakeTelegram();

  let ctx: TestApp;
  let prisma: PrismaService;
  let processor: TelegramUpdateProcessor;
  let updatesQueue: Queue<TelegramUpdateJobData, void, string>;
  let baseUrlBefore: string | undefined;

  let nextBot = 0;
  let nextChat = 0;
  let nextPerson = 0;
  let nextUpdateId = Date.now();

  const api = () => request(ctx.httpServer);
  const data = (response: request.Response): unknown => (response.body as Body).data;
  const failure = (response: request.Response) => errorEnvelopeSchema.parse(response.body).error;
  const freshUpdateId = (): number => (nextUpdateId += 1);
  const now = (): number => Math.floor(Date.now() / 1000);
  /** A Telegram user nobody else in this run uses. */
  const person = (): { id: number; is_bot: false; first_name: string; username: string } => {
    nextPerson += 1;
    return { id: 640_000_000 + nextPerson, is_bot: false, first_name: `Staff ${nextPerson}`, username: `b2_staff_${nextPerson}` };
  };

  const bearerFor = async (adminUserId: string, tenantId: string, role: AdminRole): Promise<string> => {
    const { accessToken } = await ctx.app.get(SessionService).issueAdminAccessToken({
      adminUserId,
      tenantId,
      role,
      displayName: 'B2',
      telegramUserId: null,
    });
    return `Bearer ${accessToken}`;
  };

  /** A platform admin of its own, so no two tests share a throttle bucket. */
  const newPlatformAdmin = async (): Promise<Staff> => {
    nextPerson += 1;
    const row = await prisma.adminUser.create({
      data: {
        tenantId: TENANT_ZERO_ID,
        username: `b2-${RUN}-platform-${nextPerson}`,
        displayName: 'B2 platform admin',
        role: AdminRole.PLATFORM_ADMIN,
        telegramUserId: null,
      },
      select: { id: true },
    });
    return { id: row.id, tenantId: TENANT_ZERO_ID, bearer: await bearerFor(row.id, TENANT_ZERO_ID, AdminRole.PLATFORM_ADMIN) };
  };

  const newStaff = async (
    operator: Operator,
    role: AdminRole = AdminRole.REVIEWER,
    telegramUserId: bigint | null = null,
  ): Promise<Staff> => {
    nextPerson += 1;
    const row = await ctx.inTenant(
      () =>
        prisma.adminUser.create({
          data: {
            tenantId: operator.id,
            username: `b2-${RUN}-staff-${nextPerson}`,
            displayName: `B2 staff ${nextPerson}`,
            role,
            telegramUserId,
          },
          select: { id: true },
        }),
      operator.id,
    );
    return { id: row.id, tenantId: operator.id, bearer: await bearerFor(row.id, operator.id, role) };
  };

  const createOperator = async (name: string, platform: Staff): Promise<Operator> => {
    nextBot += 1;
    const botId = 740_000_000 + nextBot;
    const token = `${botId}:AAb2link${RUN}n${nextBot}${'x'.repeat(30)}`;
    const username = `b2_${name.replace(/-/g, '_')}_${RUN}_bot`;
    telegram.accept(token, testBotInfo(botId, username));
    const response = await api()
      .post('/v1/admin/tenants')
      .set('authorization', platform.bearer)
      .send({
        displayName: `B2 link ${RUN} ${name}`,
        botToken: token,
        ichancyUsername: `b2-agent-${name}-${RUN}`,
        ichancyPassword: AGENT_PASSWORD,
        ichancyAgentId: '10077',
      })
      .expect(201);
    return { id: tenantCreatedSchema.parse(data(response)).id, token, botId, username };
  };

  /** Binds a staff group (verified by the fake Telegram) and activates the operator. Returns the group. */
  const serve = async (operator: Operator, platform: Staff): Promise<bigint> => {
    nextChat += 1;
    const group = -1_007_000_000_000n - BigInt(nextChat);
    telegram.setChat(group, { type: 'supergroup', title: `B2 staff group ${group}` });
    telegram.setBotMember(operator.token, group, { status: 'administrator' });
    await api()
      .put(`/v1/admin/tenants/${operator.id}/telegram/chats/STAFF`)
      .set('authorization', platform.bearer)
      .send({ chatId: group.toString() })
      .expect(200);
    await api().post(`/v1/admin/tenants/${operator.id}/activate`).set('authorization', platform.bearer).expect(200);
    return group;
  };

  const askForCode = (caller: Staff, adminUserId: string, tenantId?: string): request.Test => {
    const call = api().post(`/v1/admin/admins/${adminUserId}/telegram-link-code`).set('authorization', caller.bearer);
    return tenantId === undefined ? call : call.set(TENANT_HEADER, tenantId);
  };

  const codeFor = async (caller: Staff, adminUserId: string, tenantId?: string): Promise<z.infer<typeof codeViewSchema>> =>
    codeViewSchema.parse(data(await askForCode(caller, adminUserId, tenantId).expect(200)));

  const linkMessage = (
    from: { id: number; is_bot: boolean; first_name: string; username?: string },
    text: string,
    chat: object = { id: from.id, type: 'private', first_name: from.first_name },
  ): Update =>
    ({
      update_id: freshUpdateId(),
      message: {
        message_id: 1,
        date: now(),
        chat,
        from,
        text,
        entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]?.length ?? 0 }],
      },
    }) as unknown as Update;

  /**
   * Delivers an update the way Telegram does, then runs the job the webhook enqueued through the update
   * processor. Returns false when the webhook dropped it.
   */
  const deliver = async (operator: Operator, update: Update): Promise<boolean> => {
    const registration = telegram.webhookFor(operator.token);
    if (registration === null || registration.secretToken === null) {
      throw new Error('Telegram holds no webhook for this operator');
    }
    await api()
      .post(registration.url.slice(BASE_URL.length))
      .set(TELEGRAM_SECRET_HEADER, registration.secretToken)
      .send(update)
      .expect(200);
    const job = await updatesQueue.getJob(telegramUpdateJobId(operator.id, update.update_id));
    if (job === undefined) return false;
    // A link code never rests in Redis: the webhook queued its keyed digest instead.
    expect(job.data.update.message?.text ?? '').not.toMatch(/^\/link(?:@\w+)?\s+[A-Za-z0-9]{4}[\s-]?[A-Za-z0-9]{4}\s*$/);
    try {
      await processor.process(job);
    } finally {
      await job.remove();
    }
    return true;
  };

  const sentTo = (operator: Operator, chatId: bigint | number): string[] =>
    telegram
      .callsFor(operator.token, 'sendMessage')
      .filter((call) => String(call.payload['chat_id']) === chatId.toString())
      .map((call) => String(call.payload['text']));

  const lastSentTo = (operator: Operator, chatId: bigint | number): string => sentTo(operator, chatId).at(-1) ?? '';

  const staffRow = (staff: Staff) =>
    prisma.adminUser.findFirstOrThrow({ where: { tenantId: staff.tenantId, id: staff.id } });

  const codeRows = (staff: Staff) =>
    prisma.adminTelegramLinkCode.findMany({
      where: { tenantId: staff.tenantId, adminUserId: staff.id },
      orderBy: { createdAt: 'asc' },
    });

  const audits = (tenantId: string, action: string) =>
    prisma.auditLog.findMany({ where: { tenantId, action }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

  const reasonsRefused = async (tenantId: string): Promise<unknown[]> =>
    (await audits(tenantId, 'admin.telegramLink.refused')).map(
      (row) => ((row.after as { $meta?: { reason?: unknown } } | null)?.$meta ?? {}).reason,
    );

  const seedDeposit = (tenantId: string): Promise<string> =>
    ctx.inTenant(async () => {
      const method = await prisma.paymentMethod.findFirstOrThrow({
        where: { tenantId },
        select: { id: true, currencyCode: true },
      });
      nextPerson += 1;
      const player = await prisma.player.create({
        data: {
          tenantId,
          telegramUserId: 890_000_000n + BigInt(nextPerson),
          status: PlayerStatus.ACTIVE,
          currencyCode: method.currencyCode,
        },
        select: { id: true },
      });
      const deposit = await prisma.depositRequest.create({
        data: {
          tenantId,
          shortId: `B2D${String(nextPerson).padStart(7, '0')}`,
          playerId: player.id,
          paymentMethodId: method.id,
          currencyCode: method.currencyCode,
          claimedAmountMinor: 150_000n,
          status: DepositStatus.SUBMITTED,
          submittedAt: new Date(),
        },
        select: { id: true },
      });
      return deposit.id;
    }, tenantId);

  const removeSuiteRows = async (): Promise<void> => {
    await prisma.tenant.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
  };

  beforeAll(async () => {
    baseUrlBefore = process.env.API_BASE_URL;
    ctx = await createTestApp({
      env: { API_BASE_URL: BASE_URL },
      customize: (builder) => {
        builder.overrideProvider(TenantBotRegistry).useFactory({
          factory: (
            prismaService: PrismaService,
            cacheService: CacheService,
            secretService: TenantSecretService,
            registrar: TelegramHandlerRegistrar,
          ) => new TenantBotRegistry(prismaService, cacheService, secretService, registrar, telegram.clientOptions),
          inject: [PrismaService, CacheService, TenantSecretService, TelegramHandlerRegistrar],
        });
      },
    });
    await new Promise<void>((resolve) => {
      ctx.httpServer.listen(0, '127.0.0.1', resolve);
    });

    prisma = ctx.app.get(PrismaService);
    updatesQueue = ctx.app.get<Queue<TelegramUpdateJobData, void, string>>(getQueueToken(TELEGRAM_UPDATE_QUEUE));
    processor = new TelegramUpdateProcessor(
      ctx.app.get(TenantBotRegistry),
      ctx.app.get(UpdateDedupeService),
      ctx.app.get(ActorContextService),
      ctx.app.get(TenantRegistryService),
      ctx.app.get(TelegramChatProjectionService),
      ctx.app.get(StaffTelegramLinkService),
    );

    await ctx.reset();
    await removeSuiteRows();
  });

  afterAll(async () => {
    if (ctx !== undefined) {
      // Reset first: it truncates audit_logs (append-only) so the suite's operators can be deleted.
      await ctx.reset();
      await removeSuiteRows();
      await ctx.close();
    }
    if (baseUrlBefore === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = baseUrlBefore;
  });

  it('links a staff member from a private chat, and keeps the code out of every stored row', async () => {
    const platform = await newPlatformAdmin();
    const operator = await createOperator('private', platform);
    await serve(operator, platform);
    const staff = await newStaff(operator);
    const phone = person();

    const view = await codeFor(staff, staff.id);
    expect(view).toMatchObject({
      adminUserId: staff.id,
      command: `/link ${view.code}`,
      ttlSeconds: 600,
      botUsername: operator.username,
      botUrl: `https://t.me/${operator.username}`,
    });
    const expiresIn = new Date(view.expiresAt).getTime() - Date.now();
    expect(expiresIn).toBeGreaterThan(9 * 60_000);
    expect(expiresIn).toBeLessThanOrEqual(10 * 60_000);

    // A keyed digest only: not the code, and not something a plain hash of the code would give.
    const [stored] = await codeRows(staff);
    expect(stored?.codeDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value))).not.toContain(view.code.replace('-', ''));
    const [issued] = await audits(operator.id, 'admin.telegramLink.codeIssued');
    expect(issued?.actorId).toBe(staff.id);
    expect(JSON.stringify(issued)).not.toContain(view.code.replace('-', ''));

    // The code is typed in lower case without the hyphen, as people do.
    const command = linkMessage(phone, `/link ${view.code.replace('-', '').toLowerCase()}`);
    expect(await deliver(operator, command)).toBe(true);

    expect((await staffRow(staff)).telegramUserId).toBe(BigInt(phone.id));
    const [used] = await codeRows(staff);
    expect(used?.usedAt).not.toBeNull();
    expect(used?.usedByTelegramUserId).toBe(BigInt(phone.id));
    expect(lastSentTo(operator, phone.id)).toContain('is now linked to the staff account');

    const storedUpdate = await prisma.telegramUpdate.findFirstOrThrow({
      where: { tenantId: operator.id, updateId: BigInt(command.update_id) },
      select: { payload: true },
    });
    expect(JSON.stringify(storedUpdate.payload)).not.toMatch(new RegExp(view.code.replace('-', ''), 'i'));
    expect(JSON.stringify(storedUpdate.payload)).toContain(`digest:${used?.codeDigest}`);

    const [linked] = await audits(operator.id, 'admin.telegramLink.linked');
    expect(linked).toMatchObject({ actorType: 'ADMIN', actorId: staff.id, entityId: staff.id });
    expect(linked?.after).toMatchObject({ telegramUserId: String(phone.id), $meta: { via: 'bot', codeId: used?.id } });

    // The directory shows it; the admin menu reached the new staff member's private chat.
    const read = await api().get(`/v1/admin/admins/${staff.id}`).set('authorization', platform.bearer).set(TENANT_HEADER, operator.id).expect(200);
    expect(adminViewSchema.parse(data(read))).toMatchObject({ telegramUserId: String(phone.id), telegramLinked: true });
    expect(
      telegram
        .callsFor(operator.token, 'setMyCommands')
        .some((call) => JSON.stringify(call.payload['scope']) === JSON.stringify({ type: 'chat', chat_id: String(phone.id) })),
    ).toBe(true);

    // The same person sending it again is told it is done; a linked account gets no second code.
    await deliver(operator, linkMessage(phone, `/link ${view.code}`));
    expect(lastSentTo(operator, phone.id)).toContain('is already linked to');
    expect(failure(await askForCode(staff, staff.id).expect(409)).code).toBe('ADMIN_TELEGRAM_ALREADY_LINKED');
  });

  it('gives a code only to the staff member or a platform admin, and never for the agent account or the platform', async () => {
    const platform = await newPlatformAdmin();
    const operator = await createOperator('who', platform);
    await serve(operator, platform);
    const reviewer = await newStaff(operator);
    const owner = await newStaff(operator, AdminRole.SUPER_ADMIN);
    const agent = await newStaff(operator, AdminRole.SUPER_ADMIN, 0n);

    // Nobody gets somebody else's code, not even the operator's SUPER_ADMIN.
    expect(failure(await askForCode(reviewer, owner.id).expect(403)).code).toBe('ADMIN_TELEGRAM_LINK_FORBIDDEN');
    expect(failure(await askForCode(owner, reviewer.id).expect(403)).code).toBe('ADMIN_TELEGRAM_LINK_FORBIDDEN');
    expect(await codeRows(reviewer)).toHaveLength(0);
    expect(await codeRows(owner)).toHaveLength(0);

    // Another operator's staff id is simply not found for its platform admin working elsewhere.
    const other = await createOperator('who-other', platform);
    expect(failure(await askForCode(platform, reviewer.id, other.id).expect(404)).code).toBe('ADMIN_NOT_FOUND');

    expect(failure(await askForCode(platform, agent.id, operator.id).expect(422)).details).toEqual({ reason: 'AGENT_PRINCIPAL' });
    expect(failure(await askForCode(platform, platform.id).expect(422)).details).toEqual({ reason: 'PLATFORM' });

    await ctx.inTenant(() => prisma.adminUser.update({ where: { id: reviewer.id, tenantId: operator.id }, data: { isActive: false } }), operator.id);
    await ctx.app.get(AdminIdentityService).invalidate({ tenantId: operator.id, adminUserId: reviewer.id, telegramUserId: null });
    expect(failure(await askForCode(platform, reviewer.id, operator.id).expect(422)).details).toEqual({ reason: 'INACTIVE' });

    // The directory's own writes still refuse a Telegram id: the link is the only way to set one.
    expect(
      failure(
        await api()
          .post('/v1/admin/admins')
          .set('authorization', platform.bearer)
          .set(TENANT_HEADER, operator.id)
          .send({ displayName: 'Typed', role: 'REVIEWER', username: `b2-${RUN}-typed`, password: 'Correct-Horse-B2', telegramUserId: '123456' })
          .expect(400),
      ).code,
    ).toBe('VALIDATION_FAILED');
    await api()
      .patch(`/v1/admin/admins/${owner.id}`)
      .set('authorization', platform.bearer)
      .set(TENANT_HEADER, operator.id)
      .send({ telegramUserId: '123456' })
      .expect(400);
  });

  it("links a SUSPENDED operator's staff through a platform admin's code, and a newer code revokes the older", async () => {
    const platform = await newPlatformAdmin();
    const operator = await createOperator('suspended', platform);
    const staff = await newStaff(operator, AdminRole.SUPER_ADMIN);
    const phone = person();
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: operator.id } })).status).toBe('SUSPENDED');

    const first = await codeFor(platform, staff.id, operator.id);
    const second = await codeFor(platform, staff.id, operator.id);
    const rows = await codeRows(staff);
    expect(rows.map((row) => row.revokedAt !== null)).toEqual([true, false]);
    expect(rows[0]?.issuedByAdminId).toBe(platform.id);

    expect(await deliver(operator, linkMessage(phone, `/link ${first.code}`))).toBe(true);
    expect(lastSentTo(operator, phone.id)).toContain(NOT_VALID);
    expect((await staffRow(staff)).telegramUserId).toBeNull();
    expect(await reasonsRefused(operator.id)).toEqual(['CODE_REVOKED']);

    expect(await deliver(operator, linkMessage(phone, `/link ${second.code}`))).toBe(true);
    expect((await staffRow(staff)).telegramUserId).toBe(BigInt(phone.id));
    // Still suspended: linking takes no money and serves nothing.
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: operator.id } })).status).toBe('SUSPENDED');
    // And no other update of a suspended operator is kept.
    expect(await deliver(operator, linkMessage(phone, '/start'))).toBe(false);
  });

  it("refuses a code at another operator's bot, where it is simply unknown, and it still works at its own", async () => {
    const platform = await newPlatformAdmin();
    const owner = await createOperator('owner', platform);
    const stranger = await createOperator('stranger', platform);
    const staff = await newStaff(owner);
    const phone = person();
    const { code } = await codeFor(platform, staff.id, owner.id);

    expect(await deliver(stranger, linkMessage(phone, `/link ${code}`))).toBe(true);
    expect(lastSentTo(stranger, phone.id)).toContain(NOT_VALID);
    expect((await staffRow(staff)).telegramUserId).toBeNull();
    expect(await ctx.inTenant(() => prisma.adminUser.count({ where: { tenantId: stranger.id, telegramUserId: BigInt(phone.id) } }), stranger.id)).toBe(0);
    // Unknown there: nothing to audit against in either operator.
    expect(await reasonsRefused(stranger.id)).toEqual([]);
    expect(await reasonsRefused(owner.id)).toEqual([]);

    expect(await deliver(owner, linkMessage(phone, `/link ${code}`))).toBe(true);
    expect((await staffRow(staff)).telegramUserId).toBe(BigInt(phone.id));
  });

  it('refuses an expired code and a used one, and voids a code posted in a group', async () => {
    const platform = await newPlatformAdmin();
    const operator = await createOperator('expiry', platform);
    const group = await serve(operator, platform);
    const staff = await newStaff(operator);
    const phone = person();
    const intruder = person();

    const stale = await codeFor(staff, staff.id);
    await prisma.adminTelegramLinkCode.updateMany({
      where: { tenantId: operator.id, adminUserId: staff.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await deliver(operator, linkMessage(phone, `/link ${stale.code}`));
    expect(lastSentTo(operator, phone.id)).toContain(NOT_VALID);
    expect((await staffRow(staff)).telegramUserId).toBeNull();

    // Posted in the staff group: everyone there has read it, so it no longer works anywhere.
    const exposed = await codeFor(staff, staff.id);
    await deliver(
      operator,
      linkMessage(phone, `/link@${operator.username} ${exposed.code}`, { id: Number(group), type: 'supergroup', title: 'Staff' }),
    );
    expect(lastSentTo(operator, group)).toContain('Never post a link code in a group');
    await deliver(operator, linkMessage(phone, `/link ${exposed.code}`));
    expect(lastSentTo(operator, phone.id)).toContain(NOT_VALID);
    expect((await staffRow(staff)).telegramUserId).toBeNull();

    const fresh = await codeFor(staff, staff.id);
    await deliver(operator, linkMessage(phone, `/link ${fresh.code}`));
    expect((await staffRow(staff)).telegramUserId).toBe(BigInt(phone.id));

    // Somebody else with the same, now used, code.
    await deliver(operator, linkMessage(intruder, `/link ${fresh.code}`));
    expect(lastSentTo(operator, intruder.id)).toContain(NOT_VALID);
    expect((await staffRow(staff)).telegramUserId).toBe(BigInt(phone.id));

    expect(await reasonsRefused(operator.id)).toEqual(['CODE_EXPIRED', 'CODE_EXPOSED', 'CODE_REVOKED', 'CODE_USED']);
    // Never the code in the refusals either.
    for (const { code } of [stale, exposed, fresh]) {
      expect(JSON.stringify(await audits(operator.id, 'admin.telegramLink.refused'))).not.toContain(code.replace('-', ''));
    }
  });

  it('refuses a Telegram account already linked to another staff account, and keeps the code for the right one', async () => {
    const platform = await newPlatformAdmin();
    const operator = await createOperator('collision', platform);
    const phone = person();
    const rightPhone = person();
    const holder = await newStaff(operator, AdminRole.REVIEWER, BigInt(phone.id));
    const newcomer = await newStaff(operator);

    const { code } = await codeFor(platform, newcomer.id, operator.id);
    await deliver(operator, linkMessage(phone, `/link ${code}`));

    expect(lastSentTo(operator, phone.id)).toContain('already linked to another staff account');
    expect((await staffRow(newcomer)).telegramUserId).toBeNull();
    expect((await staffRow(holder)).telegramUserId).toBe(BigInt(phone.id));
    const [refused] = await audits(operator.id, 'admin.telegramLink.refused');
    expect(refused?.after).toMatchObject({
      $meta: { reason: 'TELEGRAM_ALREADY_LINKED', heldByAdminUserId: holder.id, codeRevoked: false },
    });

    // The code is still live for the person it is for.
    await deliver(operator, linkMessage(rightPhone, `/link ${code}`));
    expect((await staffRow(newcomer)).telegramUserId).toBe(BigInt(rightPhone.id));
  });

  it('stops a sender after five attempts, answers once, and lets the code work once the window has passed', async () => {
    const platform = await newPlatformAdmin();
    const operator = await createOperator('limit', platform);
    const staff = await newStaff(operator);
    const guesser = person();
    const { code } = await codeFor(platform, staff.id, operator.id);

    const wrong = ['ABCD-EFGH', 'HGFE-DCBA', 'JKLM-NPQR', 'STUV-WXYZ', '2345-6789'].filter(
      (guess) => guess !== code,
    );
    for (const guess of wrong.slice(0, 5)) await deliver(operator, linkMessage(guesser, `/link ${guess}`));
    while (sentTo(operator, guesser.id).length < 5) await deliver(operator, linkMessage(guesser, '/link'));
    expect(sentTo(operator, guesser.id)).toHaveLength(5);

    // The sixth is the right code, and it is refused before it is looked at.
    await deliver(operator, linkMessage(guesser, `/link ${code}`));
    expect(lastSentTo(operator, guesser.id)).toContain('Too many attempts');
    await deliver(operator, linkMessage(guesser, `/link ${code}`));
    expect(sentTo(operator, guesser.id)).toHaveLength(6);
    expect((await staffRow(staff)).telegramUserId).toBeNull();
    expect((await codeRows(staff))[0]?.usedAt).toBeNull();

    // Another sender is not affected, and the window passing lets this one try again.
    await ctx.app.get(RedisService).del(staffLinkAttemptsKey(operator.id, BigInt(guesser.id)));
    await deliver(operator, linkMessage(guesser, `/link ${code}`));
    expect((await staffRow(staff)).telegramUserId).toBe(BigInt(guesser.id));
  });

  it('answers an edited /link without redeeming it, keeps its code out of the stored row, and the code still works as a new message', async () => {
    const platform = await newPlatformAdmin();
    const operator = await createOperator('edited', platform);
    await serve(operator, platform);
    const staff = await newStaff(operator);
    const phone = person();
    const { code } = await codeFor(staff, staff.id);

    // A typo (seven symbols, not a code) fixed in place: Telegram sends the fixed text as an edit.
    const typo = linkMessage(phone, `/link ${code.slice(0, -1)}`);
    await deliver(operator, typo);
    const { message: typoMessage } = typo as { message: object };
    const edit = {
      update_id: freshUpdateId(),
      edited_message: { ...typoMessage, text: `/link ${code}`, edit_date: now() },
    } as unknown as Update;
    expect(await deliver(operator, edit)).toBe(true);

    expect(lastSentTo(operator, phone.id)).toContain('Edited messages are not read');
    expect((await staffRow(staff)).telegramUserId).toBeNull();
    const storedEdit = await prisma.telegramUpdate.findFirstOrThrow({
      where: { tenantId: operator.id, updateId: BigInt(edit.update_id) },
      select: { payload: true },
    });
    expect(JSON.stringify(storedEdit.payload)).not.toMatch(new RegExp(code.replace('-', '-?'), 'i'));
    const [live] = await codeRows(staff);
    expect(JSON.stringify(storedEdit.payload)).toContain(`digest:${live?.codeDigest}`);
    expect(live?.usedAt).toBeNull();

    await deliver(operator, linkMessage(phone, `/link ${code}`));
    expect((await staffRow(staff)).telegramUserId).toBe(BigInt(phone.id));
  });

  it('counts a retried update once against the attempt limit', async () => {
    const platform = await newPlatformAdmin();
    const operator = await createOperator('retry', platform);
    const phone = person();
    const links = ctx.app.get(StaffTelegramLinkService);
    const redis = ctx.app.get(RedisService);
    const attempts = async (): Promise<string | null> => redis.get(staffLinkAttemptsKey(operator.id, BigInt(phone.id)));

    // The same update handled again, as a BullMQ retry after a database failure would.
    const update = linkMessage(phone, '/link');
    for (let run = 0; run < 7; run += 1) {
      const outcome = await ctx.inTenant(() => links.handleUpdate(operator.id, update), operator.id);
      expect(outcome).toEqual({ consumed: true, result: 'NO_CODE' });
    }
    expect(await attempts()).toBe('1');
    expect(await redis.ttl(staffLinkAttemptsKey(operator.id, BigInt(phone.id)))).toBeGreaterThan(0);

    // A new update is a new attempt.
    await ctx.inTenant(() => links.handleUpdate(operator.id, linkMessage(phone, '/link')), operator.id);
    expect(await attempts()).toBe('2');
  });

  it("refuses, in the database, a link code whose staff account belongs to another operator", async () => {
    const platform = await newPlatformAdmin();
    const home = await createOperator('fk-home', platform);
    const other = await createOperator('fk-other', platform);
    const staff = await newStaff(other);

    await expect(
      prisma.$executeRaw`
        INSERT INTO admin_telegram_link_codes (tenant_id, admin_user_id, code_digest, issued_by_admin_id, expires_at)
        VALUES (${home.id}::uuid, ${staff.id}::uuid, ${'f'.repeat(64)}, ${staff.id}::uuid, now() + interval '10 minutes')`,
    ).rejects.toThrow(/admin_telegram_link_codes_admin_user_id_tenant_fkey/);
  });

  it("accepts a linked staff member's tap in the staff group, refuses an unlinked one's, and unlinking takes it away", async () => {
    const platform = await newPlatformAdmin();
    const operator = await createOperator('taps', platform);
    const group = await serve(operator, platform);
    const reviewer = await newStaff(operator);
    const colleague = await newStaff(operator);
    const owner = await newStaff(operator, AdminRole.SUPER_ADMIN);
    const phone = person();
    const depositId = await seedDeposit(operator.id);

    const { DepositTelegramHandlers } = await import('./deposit/telegram/deposit.handlers');
    const { DepositRepository } = await import('./deposit/repositories/deposit.repository');
    const { DepositService } = await import('./deposit/services/deposit.service');
    const { DepositReviewService } = await import('./deposit/services/deposit-review.service');
    // The handlers are a worker-role provider; this is the same object, built from the api's graph.
    const handlers = new DepositTelegramHandlers(
      prisma,
      ctx.app.get(DepositRepository),
      ctx.app.get(DepositService),
      ctx.app.get(DepositReviewService),
      ctx.app.get(AdminIdentityService),
      ctx.app.get(TelegramFileService),
      ctx.app.get(BotService),
    );
    const bot = new Bot(operator.token, {
      botInfo: testBotInfo(operator.botId, operator.username),
      client: telegram.clientOptions,
    });
    bot.on('callback_query:data', (tgContext) => handlers.onDepositCallback(tgContext));

    const tap = async (action: string): Promise<string> => {
      const updateId = freshUpdateId();
      const update = {
        update_id: updateId,
        callback_query: {
          id: `cb-${randomUUID()}`,
          from: phone,
          chat_instance: 'b2',
          data: `d:${action}:${depositId}`,
          message: {
            message_id: 77,
            date: now(),
            chat: { id: Number(group), type: 'supergroup', title: 'Staff' },
            text: 'card',
          },
        },
      } as unknown as Update;
      // What TelegramUpdateProcessor does: the operator whose bot received the update.
      await runWithTenant(operator.id, () => bot.handleUpdate(update));
      const answer = telegram.callsFor(operator.token, 'answerCallbackQuery').at(-1)?.payload['text'];
      return typeof answer === 'string' ? answer : '';
    };
    const statusOf = async (): Promise<DepositStatus> =>
      (await prisma.depositRequest.findFirstOrThrow({ where: { tenantId: operator.id, id: depositId } })).status;

    // Not linked: the tap is nobody's.
    expect(await tap('c')).toBe(NOT_AUTHORISED);
    expect(await statusOf()).toBe(DepositStatus.SUBMITTED);

    // Linked: the refusal cached a moment ago does not outlive the link.
    const { code } = await codeFor(reviewer, reviewer.id);
    await deliver(operator, linkMessage(phone, `/link ${code}`));
    expect((await staffRow(reviewer)).telegramUserId).toBe(BigInt(phone.id));
    expect(await tap('c')).not.toBe(NOT_AUTHORISED);
    expect(await statusOf()).toBe(DepositStatus.UNDER_REVIEW);

    // Only the staff member, their SUPER_ADMIN or the platform may remove the link.
    expect(failure(await api().delete(`/v1/admin/admins/${reviewer.id}/telegram-link`).set('authorization', colleague.bearer).expect(403)).code).toBe(
      'ADMIN_TELEGRAM_LINK_FORBIDDEN',
    );
    const unlinked = await api().delete(`/v1/admin/admins/${reviewer.id}/telegram-link`).set('authorization', owner.bearer).expect(200);
    expect(adminViewSchema.parse(data(unlinked))).toMatchObject({ telegramUserId: null, telegramLinked: false });
    const [audit] = await audits(operator.id, 'admin.telegramLink.unlinked');
    expect(audit).toMatchObject({ actorId: owner.id, entityId: reviewer.id, before: { telegramUserId: String(phone.id) } });

    // The tap goes with it at once, not a cache TTL later.
    expect(await tap('c')).toBe(NOT_AUTHORISED);

    // Idempotent, and the staff member may do it themselves.
    const again = await api().delete(`/v1/admin/admins/${reviewer.id}/telegram-link`).set('authorization', reviewer.bearer).expect(200);
    expect(adminViewSchema.parse(data(again))).toMatchObject({ telegramLinked: false });
    expect(await audits(operator.id, 'admin.telegramLink.unlinked')).toHaveLength(1);
  });
});
