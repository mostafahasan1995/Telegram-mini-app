/**
 * An operator's staff and feed groups through the REAL api and the real update pipeline: AppModule,
 * guards, validation, Postgres and Redis; the webhook route, the BullMQ job it enqueues and the update
 * processor (built from the app's own collaborators, as the worker builds it) with the chat projection.
 *
 * TELEGRAM IS THE OFFLINE FAKE (test/setup/telegram-fixtures.ts), injected at the fetch level into the
 * app's TenantBotRegistry: getChat, getChatMember, sendMessage, setMyCommands and supergroup migration
 * all go through grammY. Nothing reaches api.telegram.org. Ichancy is the fake adapter (ICHANCY_FAKE=1),
 * which accepts sign-ins, so any refusal of an activation here is the staff-group rule and nothing else.
 *
 * What only this level proves (owner decisions 1, 2, 3 and 5 of 2026-09-15):
 *  - an operator is created with no staff group, stays SUSPENDED, and activation refuses it before any
 *    sign-in until a group is bound;
 *  - a SUSPENDED operator's bot being added to a group reaches the chat directory through the webhook;
 *  - the one-time link binds the group Telegram hands the nonce back in, verified, confirmed in the
 *    group, with the admin menu pushed and a card job for every deposit that waited, and the command
 *    never registers a player;
 *  - another operator's link, an expired, reused or revoked link, a channel, a private chat and a bot
 *    that is not an administrator are all refused, and a refused link can still be used once fixed;
 *  - a link belongs to the first group that presents it: replayed from another group it is refused
 *    (LINK_OTHER_CHAT), groups racing for it cannot both have it, and the first group keeps its retry,
 *    its "already bound" reply and its link when it becomes a supergroup;
 *  - binding from the directory, by PATCH and removal follow their rules, and an operator's own staff
 *    can do none of it;
 *  - a group that becomes a supergroup moves every stored id, from its service message and from a send;
 *  - a bot removed from the staff group keeps the binding and shows in health.
 *
 * Run with the escape hatch (no testcontainers):
 *   POSTGRES_TEST_URL=... REDIS_TEST_URL=... \
 *     npx jest --config jest-int.config.cjs --runInBand src/modules/tenant/tenant-telegram-chats.int.spec.ts
 */
import { createHash } from 'node:crypto';

import { getQueueToken } from '@nestjs/bullmq';
import { AdminRole, DepositStatus, PlayerStatus } from '@prisma/client';
import { type Job, type Queue } from 'bullmq';
import { type Message, type Update } from 'grammy/types';
import request from 'supertest';
import { z } from 'zod';

import { ActorContextService } from '@core/actor-context/actor-context.service';
import { PasswordHasherService } from '@core/auth/services/password-hasher.service';
import { CacheService } from '@core/cache/cache.service';
import { FakeIchancyAdapter } from '@core/ichancy/fake-ichancy.adapter';
import { PrismaService } from '@core/prisma/prisma.service';
import { QUEUE_NAMES } from '@core/queue/queue.constants';
import { TASKS } from '@core/queue/queue.types';
import { ChatBindingService } from '@core/telegram/chat-binding/chat-binding.service';
import { TelegramChatProjectionService } from '@core/telegram/chat-binding/chat-projection.service';
import { StaffTelegramLinkService } from '@core/telegram/staff-link/staff-telegram-link.service';
import { TelegramUpdateProcessor } from '@core/telegram/processors/telegram-update.processor';
import { BotService } from '@core/telegram/services/bot.service';
import { TelegramHandlerRegistrar } from '@core/telegram/services/handler-registrar.service';
import { TenantBotRegistry } from '@core/telegram/services/tenant-bot-registry.service';
import { UpdateDedupeService } from '@core/telegram/services/update-dedupe.service';
import {
  TELEGRAM_SECRET_HEADER,
  TELEGRAM_UPDATE_QUEUE,
  telegramUpdateJobId,
} from '@core/telegram/telegram.constants';
import { type TelegramUpdateJobData } from '@core/telegram/telegram.types';
import { TenantRegistryService } from '@core/tenant/services/tenant-registry.service';
import { TenantSecretService } from '@core/tenant/services/tenant-secret.service';
import { TENANT_BOOTSTRAP_ID, TENANT_ZERO_ID } from '@core/tenant/tenant.constants';

import { createTestApp, type TestApp } from '../../../test/setup/app-factory';
import { createFakeTelegram, testBotInfo } from '../../../test/setup/telegram-fixtures';

import { STAFF_GROUP_REQUIRED_MESSAGE } from './tenant-admin.constants';

jest.setTimeout(240_000);

// ── The shapes this surface answers ─────────────────────────────────────────────────────────────
const isoDateTime = z.string();
const purposeSchema = z.enum(['STAFF', 'FEED']);
const botChatStatusSchema = z.enum(['CREATOR', 'ADMINISTRATOR', 'MEMBER', 'RESTRICTED', 'LEFT', 'KICKED']);
const tenantViewSchema = z.looseObject({
  id: z.string(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']),
  displayName: z.string(),
  adminChatId: z.string().nullable(),
  feedChatId: z.string().nullable(),
  botUsername: z.string().nullable(),
});
const tenantCreatedSchema = tenantViewSchema.extend({
  provisioning: z.looseObject({ activated: z.boolean(), activationError: z.string().nullable() }),
});
const discoveredChatSchema = z.object({
  chatId: z.string(),
  chatType: z.enum(['GROUP', 'SUPERGROUP', 'CHANNEL']),
  title: z.string().nullable(),
  username: z.string().nullable(),
  status: botChatStatusSchema,
  isAdministrator: z.boolean(),
  isPresent: z.boolean(),
  canPost: z.boolean(),
  alreadyBound: z.boolean(),
  boundAs: z.array(purposeSchema),
  migratedToChatId: z.string().nullable(),
  lastChangedByTelegramUserId: z.string().nullable(),
  lastChangedByUsername: z.string().nullable(),
  firstSeenAt: isoDateTime,
  lastSeenAt: isoDateTime,
});
const bindLinkSchema = z.object({
  purpose: purposeSchema,
  url: z.string(),
  botUsername: z.string(),
  expiresAt: isoDateTime,
  adminRights: z.array(z.string()),
});
const boundChatHealthSchema = z.object({
  chatId: z.string().nullable(),
  title: z.string().nullable(),
  status: botChatStatusSchema.nullable(),
  isPresent: z.boolean().nullable(),
  isAdministrator: z.boolean().nullable(),
  canPost: z.boolean().nullable(),
  lastSeenAt: isoDateTime.nullable(),
});
const healthSchema = z.looseObject({
  chats: z.object({ staff: boundChatHealthSchema, feed: boundChatHealthSchema }),
});
const errorEnvelopeSchema = z.looseObject({
  success: z.literal(false),
  data: z.null(),
  error: z.looseObject({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

const RUN = Date.now().toString(36);
/** Every operator this suite creates starts with it, so a crashed run's leftovers are found. */
const SLUG_PREFIX = 'b1-chats-';
const BASE_URL = 'https://api.b1-chats.example';
const PASSWORD = 'Correct-Horse-B1';
const AGENT_PASSWORD = 'b1 agent password';
const login = (name: string): string => `b1-${RUN}-${name}`;
const OWNER = { id: 555_000_001, is_bot: false, first_name: 'Owner', username: 'b1_owner' };

type Body = { success: boolean; data: unknown; error: unknown };

interface Operator {
  id: string;
  token: string;
  botId: number;
  username: string;
}

describe('Staff and feed groups (integration)', () => {
  const telegram = createFakeTelegram();

  let ctx: TestApp;
  let prisma: PrismaService;
  let ichancy: FakeIchancyAdapter;
  let processor: TelegramUpdateProcessor;
  let updatesQueue: Queue<TelegramUpdateJobData, void, string>;
  let cardQueue: Queue<{ depositRequestId: string; reason: string }>;
  let platformBearer: string;
  let staffBearer: string;
  let baseUrlBefore: string | undefined;

  let nextBot = 0;
  let nextChat = 0;
  let nextPlayer = 0;
  let nextUpdateId = Date.now();

  const api = () => request(ctx.httpServer);
  const failure = (body: unknown) => errorEnvelopeSchema.parse(body).error;
  const data = (response: request.Response): unknown => (response.body as Body).data;
  const freshUpdateId = (): number => (nextUpdateId += 1);
  const newGroup = (): bigint => {
    nextChat += 1;
    return -1_008_000_000_000n - BigInt(nextChat);
  };
  const now = (): number => Math.floor(Date.now() / 1000);

  const signIn = async (username: string): Promise<string> => {
    const response = await api()
      .post('/v1/admin/auth/credentials')
      .send({ username, password: PASSWORD })
      .expect(200);
    return `Bearer ${z.looseObject({ accessToken: z.string() }).parse(data(response)).accessToken}`;
  };

  const createOperator = async (
    name: string,
  ): Promise<Operator & { created: z.infer<typeof tenantCreatedSchema> }> => {
    nextBot += 1;
    const botId = 730_000_000 + nextBot;
    const token = `${botId}:AAb1chats${RUN}n${nextBot}${'x'.repeat(30)}`;
    const username = `b1_${name.replace(/-/g, '_')}_${RUN}_bot`;
    telegram.accept(token, testBotInfo(botId, username));
    const response = await api()
      .post('/v1/admin/tenants')
      .set('authorization', platformBearer)
      .send({
        displayName: `B1 chats ${RUN} ${name}`,
        botToken: token,
        ichancyUsername: `b1-agent-${name}-${RUN}`,
        ichancyPassword: AGENT_PASSWORD,
        ichancyAgentId: '10077',
      })
      .expect(201);
    const created = tenantCreatedSchema.parse(data(response));
    return { id: created.id, token, botId, username, created };
  };

  /** The group exists at Telegram and this operator's bot is `status` in it. */
  const botIn = (
    operator: Operator,
    chatId: bigint,
    status: string,
    type: 'group' | 'supergroup' | 'channel' = 'supergroup',
  ): void => {
    telegram.setChat(chatId, { type, title: `B1 group ${chatId}` });
    telegram.setBotMember(operator.token, chatId, { status });
  };

  /**
   * Delivers an update the way Telegram does (to the URL and with the secret the operator's bot was
   * registered with), then runs the job the webhook enqueued through the update processor. Returns
   * false when the webhook dropped it and enqueued nothing.
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
    // A bind link's nonce never rests in Redis: the webhook queued its hash instead.
    expect(job.data.update.message?.text ?? '').not.toMatch(/^\/start(?:@\w+)?\s+[A-Za-z0-9_-]{32}\s*$/);
    try {
      await processor.process(job);
    } finally {
      await job.remove();
    }
    return true;
  };

  const membership = (
    operator: Operator,
    chatId: bigint,
    status: string,
    options: { type?: string; date?: number } = {},
  ): Update =>
    ({
      update_id: freshUpdateId(),
      my_chat_member: {
        chat:
          options.type === 'private'
            ? { id: OWNER.id, type: 'private', first_name: OWNER.first_name }
            : { id: Number(chatId), type: options.type ?? 'supergroup', title: `B1 group ${chatId}` },
        from: OWNER,
        date: options.date ?? now(),
        old_chat_member: { status: 'left', user: { id: operator.botId, is_bot: true, first_name: 'bot' } },
        new_chat_member: { status, user: { id: operator.botId, is_bot: true, first_name: 'bot' } },
      },
    }) as unknown as Update;

  const startCommand = (
    chatId: bigint,
    mention: string,
    nonce: string,
    type: 'group' | 'supergroup' = 'supergroup',
  ): Update => {
    const command = `/start@${mention}`;
    return {
      update_id: freshUpdateId(),
      message: {
        message_id: 1,
        date: now(),
        chat: { id: Number(chatId), type, title: `B1 group ${chatId}` },
        from: OWNER,
        text: `${command} ${nonce}`,
        entities: [{ type: 'bot_command', offset: 0, length: command.length }],
      },
    } as unknown as Update;
  };

  const issueLink = async (
    operator: Operator,
    purpose: 'STAFF' | 'FEED' = 'STAFF',
  ): Promise<{ nonce: string; link: z.infer<typeof bindLinkSchema> }> => {
    const response = await api()
      .post(`/v1/admin/tenants/${operator.id}/telegram/bind-links`)
      .set('authorization', platformBearer)
      .send({ purpose })
      .expect(200);
    const link = bindLinkSchema.parse(data(response));
    const nonce = /startgroup=([A-Za-z0-9_-]{32})&/.exec(link.url)?.[1];
    if (nonce === undefined) throw new Error('the link carries no nonce');
    return { nonce, link };
  };

  const rowOf = (id: string) =>
    prisma.tenant.findUniqueOrThrow({
      where: { id },
      select: { status: true, adminChatId: true, feedChatId: true },
    });

  const audits = (tenantId: string, action: string) =>
    // The id is a uuidv7, time-ordered, so it breaks a tie between two rows of the same millisecond.
    prisma.auditLog.findMany({
      where: { tenantId, action },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

  const chatsOf = async (operator: Operator) =>
    z
      .array(discoveredChatSchema)
      .parse(
        data(
          await api()
            .get(`/v1/admin/tenants/${operator.id}/telegram/chats`)
            .set('authorization', platformBearer)
            .expect(200),
        ),
      );

  const sentTo = (operator: Operator, chatId: bigint): string[] =>
    telegram
      .callsFor(operator.token, 'sendMessage')
      .filter((call) => String(call.payload['chat_id']) === chatId.toString())
      .map((call) => String(call.payload['text']));

  const putChat = (operator: Operator, purpose: 'STAFF' | 'FEED', chatId: bigint | string) =>
    api()
      .put(`/v1/admin/tenants/${operator.id}/telegram/chats/${purpose}`)
      .set('authorization', platformBearer)
      .send({ chatId: chatId.toString() });

  /** A deposit of `tenantId` on one of its provisioned rails, with its own player. */
  const seedDeposit = (
    tenantId: string,
    status: DepositStatus,
    card: { chatId: bigint; messageId: bigint } | null = null,
  ): Promise<string> =>
    ctx.inTenant(async () => {
      const method = await prisma.paymentMethod.findFirstOrThrow({
        where: { tenantId },
        select: { id: true, currencyCode: true },
      });
      nextPlayer += 1;
      const player = await prisma.player.create({
        data: {
          tenantId,
          telegramUserId: 880_000_000n + BigInt(nextPlayer),
          status: PlayerStatus.ACTIVE,
          currencyCode: method.currencyCode,
        },
        select: { id: true },
      });
      const deposit = await prisma.depositRequest.create({
        data: {
          tenantId,
          shortId: `B1D${String(nextPlayer).padStart(7, '0')}`,
          playerId: player.id,
          paymentMethodId: method.id,
          currencyCode: method.currencyCode,
          claimedAmountMinor: 150_000n,
          status,
          submittedAt: new Date(),
          ...(card === null ? {} : { adminChatId: card.chatId, adminMessageId: card.messageId }),
        },
        select: { id: true },
      });
      return deposit.id;
    }, tenantId);

  const queuedCards = async (): Promise<Job<{ depositRequestId: string; reason: string }>[]> =>
    (await cardQueue.getJobs(['waiting', 'delayed', 'prioritized', 'paused'])).filter(
      (job) => job.name === TASKS.TELEGRAM_ADMIN_CARD_UPDATE,
    );

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
    ichancy = ctx.app.get(FakeIchancyAdapter);
    updatesQueue = ctx.app.get<Queue<TelegramUpdateJobData, void, string>>(
      getQueueToken(TELEGRAM_UPDATE_QUEUE),
    );
    cardQueue = ctx.app.get(getQueueToken(QUEUE_NAMES.TELEGRAM));
    // The worker's processor, from the app's own collaborators and its chat projection.
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

    const hash = await ctx.app.get(PasswordHasherService).hash(PASSWORD);
    await prisma.adminUser.create({
      data: {
        tenantId: TENANT_ZERO_ID,
        username: login('platform'),
        displayName: 'B1 platform admin',
        role: AdminRole.PLATFORM_ADMIN,
        isActive: true,
        passwordHash: hash,
        telegramUserId: null,
      },
    });
    await prisma.adminUser.create({
      data: {
        tenantId: TENANT_BOOTSTRAP_ID,
        username: login('staff'),
        displayName: 'B1 operator SUPER_ADMIN',
        role: AdminRole.SUPER_ADMIN,
        isActive: true,
        passwordHash: hash,
        telegramUserId: null,
      },
    });
    platformBearer = await signIn(login('platform'));
    staffBearer = await signIn(login('staff'));
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

  afterEach(async () => {
    for (const job of await queuedCards()) await job.remove();
  });

  it('creates an operator with no staff group, keeps it SUSPENDED, and refuses activation before any sign-in', async () => {
    const operator = await createOperator('unbound');

    expect(operator.created).toMatchObject({ status: 'SUSPENDED', adminChatId: null });
    expect(operator.created.provisioning).toMatchObject({
      activated: false,
      activationError: STAFF_GROUP_REQUIRED_MESSAGE,
    });

    const refused = await api()
      .post(`/v1/admin/tenants/${operator.id}/activate`)
      .set('authorization', platformBearer)
      .expect(422);
    expect(failure(refused.body)).toMatchObject({
      code: 'TENANT_STAFF_GROUP_REQUIRED',
      message: STAFF_GROUP_REQUIRED_MESSAGE,
    });

    expect(await rowOf(operator.id)).toMatchObject({ status: 'SUSPENDED', adminChatId: 0n });
    // Refused on the rule, so Ichancy was never asked: once at create, once here, both recorded.
    expect(ichancy.callsFor('signIn').filter((call) => call.tenantId === operator.id)).toHaveLength(0);
    const refusals = await audits(operator.id, 'tenant.activation.refused');
    expect(refusals).toHaveLength(2);
    expect(JSON.stringify(refusals)).toContain('TENANT_STAFF_GROUP_REQUIRED');

    const health = healthSchema.parse(
      data(
        await api()
          .get(`/v1/admin/tenants/${operator.id}/health`)
          .set('authorization', platformBearer)
          .expect(200),
      ),
    );
    expect(health.chats.staff).toEqual({
      chatId: null,
      title: null,
      status: null,
      isPresent: null,
      isAdministrator: null,
      canPost: null,
      lastSeenAt: null,
    });
  });

  it("records the groups a SUSPENDED operator's bot is added to, newest sighting first, and only its own", async () => {
    const operator = await createOperator('directory');
    const other = await createOperator('directory-other');
    const group = newGroup();
    const addedAt = now();

    expect(await deliver(operator, membership(operator, group, 'administrator', { date: addedAt }))).toBe(true);

    const [row] = await chatsOf(operator);
    expect(row).toMatchObject({
      chatId: group.toString(),
      chatType: 'SUPERGROUP',
      status: 'ADMINISTRATOR',
      isAdministrator: true,
      isPresent: true,
      canPost: true,
      alreadyBound: false,
      boundAs: [],
      migratedToChatId: null,
      lastChangedByTelegramUserId: String(OWNER.id),
      lastChangedByUsername: OWNER.username,
    });
    const stored = await prisma.telegramUpdate.findFirstOrThrow({
      where: { tenantId: operator.id, kind: 'my_chat_member' },
      select: { handler: true, processedAt: true },
    });
    expect(stored.handler).toBe('TelegramChatProjection');
    expect(stored.processedAt).not.toBeNull();

    // A late retry of an older "removed" never overwrites the newer "administrator".
    await deliver(operator, membership(operator, group, 'kicked', { date: addedAt - 60 }));
    // A player blocking the bot in a private chat is not a group and is never recorded.
    await deliver(operator, membership(operator, group, 'kicked', { type: 'private' }));
    expect(await chatsOf(operator)).toEqual([expect.objectContaining({ status: 'ADMINISTRATOR', isPresent: true })]);

    // Another operator's directory does not contain it.
    expect(await chatsOf(other)).toEqual([]);
    // Still SUSPENDED: the sighting ran nothing else.
    expect((await rowOf(operator.id)).status).toBe('SUSPENDED');
  });

  it('binds the staff group from a one-time link: verified, confirmed in the group, menus pushed, waiting deposits carded, and only then activates', async () => {
    const operator = await createOperator('link');
    const other = await createOperator('link-other');
    const group = newGroup();

    const submitted = await seedDeposit(operator.id, DepositStatus.SUBMITTED);
    const underReview = await seedDeposit(operator.id, DepositStatus.UNDER_REVIEW);
    await seedDeposit(operator.id, DepositStatus.AWAITING_PROOF);
    await seedDeposit(operator.id, DepositStatus.SUBMITTED, { chatId: -1001n, messageId: 7n });
    await seedDeposit(other.id, DepositStatus.SUBMITTED);

    const { nonce, link } = await issueLink(operator);
    expect(link).toMatchObject({
      purpose: 'STAFF',
      botUsername: operator.username,
      adminRights: ['post_messages', 'delete_messages', 'pin_messages', 'manage_chat'],
    });
    expect(link.url).toBe(
      `https://t.me/${operator.username}?startgroup=${nonce}&admin=post_messages+delete_messages+pin_messages+manage_chat`,
    );
    const expiresIn = new Date(link.expiresAt).getTime() - Date.now();
    expect(expiresIn).toBeGreaterThan(14 * 60_000);
    expect(expiresIn).toBeLessThanOrEqual(15 * 60_000);

    // Only the hash is stored, and the nonce is nowhere in the evidence.
    const stored = await prisma.telegramChatBindLink.findFirstOrThrow({ where: { tenantId: operator.id } });
    expect(stored.nonceHash).toBe(createHash('sha256').update(nonce).digest('hex'));
    expect(JSON.stringify(stored)).not.toContain(nonce);
    expect(JSON.stringify(await audits(operator.id, 'tenant.telegramChat.bindLinkIssued'))).not.toContain(nonce);

    // The owner opens the link and adds the bot as an administrator; Telegram sends the command.
    botIn(operator, group, 'administrator');
    const command = startCommand(group, operator.username, nonce);
    expect(await deliver(operator, command)).toBe(true);

    expect(await rowOf(operator.id)).toMatchObject({ status: 'SUSPENDED', adminChatId: group });
    // The stored update holds the hash, never the nonce, and it still bound the link.
    const storedUpdate = await prisma.telegramUpdate.findFirstOrThrow({
      where: { tenantId: operator.id, updateId: BigInt(command.update_id) },
      select: { payload: true },
    });
    expect(JSON.stringify(storedUpdate.payload)).not.toContain(nonce);
    expect(JSON.stringify(storedUpdate.payload)).toContain(`sha256:${stored.nonceHash}`);
    const used = await prisma.telegramChatBindLink.findUniqueOrThrow({
      where: { id: stored.id, tenantId: operator.id },
    });
    expect(used.usedAt).not.toBeNull();
    expect(used.usedChatId).toBe(group);

    const [bound] = await audits(operator.id, 'tenant.telegramChat.bound');
    expect(bound?.actorType).toBe('ADMIN');
    expect(bound?.after).toMatchObject({
      purpose: 'STAFF',
      chatId: group.toString(),
      $meta: { via: 'startgroup', linkId: stored.id, telegramUserId: String(OWNER.id) },
    });

    // Confirmed in the group, announcing the two deposits that waited; admin menu for its admins.
    const confirmation = sentTo(operator, group);
    expect(confirmation).toHaveLength(1);
    expect(confirmation[0]).toContain('staff group');
    expect(confirmation[0]).toContain('2 deposit(s) are waiting');
    expect(
      telegram
        .callsFor(operator.token, 'setMyCommands')
        .some((call) => JSON.stringify(call.payload['scope']) === JSON.stringify({ type: 'chat_administrators', chat_id: group.toString() })),
    ).toBe(true);

    // A card job for each waiting deposit with no card, and nothing for anybody else's.
    const cards = await queuedCards();
    expect(cards.map((job) => job.data.depositRequestId).sort()).toEqual([submitted, underReview].sort());
    expect(cards.every((job) => job.data.reason === 'staff-group-bound')).toBe(true);

    // The /start was the bind, not a player registration.
    expect(await prisma.player.count({ where: { tenantId: operator.id, telegramUserId: BigInt(OWNER.id) } })).toBe(0);
    expect((await chatsOf(operator))[0]).toMatchObject({ chatId: group.toString(), boundAs: ['STAFF'], alreadyBound: true });

    const activated = await api()
      .post(`/v1/admin/tenants/${operator.id}/activate`)
      .set('authorization', platformBearer)
      .expect(200);
    expect(tenantViewSchema.parse(data(activated))).toMatchObject({ status: 'ACTIVE', adminChatId: group.toString() });

    const health = healthSchema.parse(
      data(await api().get(`/v1/admin/tenants/${operator.id}/health`).set('authorization', platformBearer).expect(200)),
    );
    expect(health.chats.staff).toMatchObject({ chatId: group.toString(), isPresent: true, status: 'ADMINISTRATOR' });
  });

  it("refuses another operator's link, and a used, expired or revoked link, while a valid one still binds", async () => {
    const owner = await createOperator('refuse-owner');
    const stranger = await createOperator('refuse-stranger');
    const { nonce } = await issueLink(owner);

    // Owner's nonce, typed into a group through the stranger's bot: unknown there, silently.
    const strangerGroup = newGroup();
    botIn(stranger, strangerGroup, 'administrator');
    await deliver(stranger, startCommand(strangerGroup, stranger.username, nonce));
    expect((await rowOf(stranger.id)).adminChatId).toBe(0n);
    expect((await rowOf(owner.id)).adminChatId).toBe(0n);
    expect(sentTo(stranger, strangerGroup)).toEqual([]);
    expect(await audits(stranger.id, 'tenant.telegramChat.bindRefused')).toHaveLength(0);
    expect(
      (await prisma.telegramChatBindLink.findFirstOrThrow({ where: { tenantId: owner.id } })).usedAt,
    ).toBeNull();

    // The same link still binds for its own operator.
    const ownGroup = newGroup();
    botIn(owner, ownGroup, 'administrator');
    await deliver(owner, startCommand(ownGroup, owner.username, nonce));
    expect((await rowOf(owner.id)).adminChatId).toBe(ownGroup);

    // Used once: a second group is refused and told why; the staff group does not move.
    const secondGroup = newGroup();
    botIn(owner, secondGroup, 'administrator');
    await deliver(owner, startCommand(secondGroup, owner.username, nonce));
    expect((await rowOf(owner.id)).adminChatId).toBe(ownGroup);
    expect(sentTo(owner, secondGroup).join('\n')).toContain('already used');

    // Expired.
    const { nonce: expiredNonce } = await issueLink(owner);
    await prisma.telegramChatBindLink.updateMany({
      where: { tenantId: owner.id, usedAt: null, revokedAt: null },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await deliver(owner, startCommand(secondGroup, owner.username, expiredNonce));
    expect((await rowOf(owner.id)).adminChatId).toBe(ownGroup);

    // Revoked by a newer link for the same purpose.
    const { nonce: revokedNonce } = await issueLink(owner);
    await issueLink(owner);
    await deliver(owner, startCommand(secondGroup, owner.username, revokedNonce));
    expect((await rowOf(owner.id)).adminChatId).toBe(ownGroup);

    const reasons = (await audits(owner.id, 'tenant.telegramChat.bindRefused')).map(
      (row) => (row.after as { $meta?: { reason?: string } } | null)?.$meta?.reason,
    );
    expect(reasons).toEqual(['LINK_USED', 'LINK_EXPIRED', 'LINK_REVOKED']);

    // A command naming a different bot is not this bot's: nothing happens and grammY is not skipped.
    const { nonce: liveNonce } = await issueLink(owner);
    await deliver(owner, startCommand(secondGroup, 'some_other_bot', liveNonce));
    expect((await rowOf(owner.id)).adminChatId).toBe(ownGroup);
  });

  it('refuses a channel, a private chat, a chat Telegram does not know and a bot that is not an administrator, and binds once that is fixed', async () => {
    const operator = await createOperator('reasons');
    const reasonOf = async (chatId: bigint): Promise<unknown> => {
      const answer = await putChat(operator, 'STAFF', chatId).expect(400);
      const error = failure(answer.body);
      expect(error.code).toBe('TELEGRAM_CHAT_REJECTED');
      return error.details;
    };

    const channel = newGroup();
    botIn(operator, channel, 'administrator', 'channel');
    expect(await reasonOf(channel)).toMatchObject({ reason: 'CHANNEL_NOT_ALLOWED', purpose: 'STAFF', field: 'chatId' });

    telegram.setChat(BigInt(OWNER.id), { type: 'private', title: 'Owner' });
    expect(await reasonOf(BigInt(OWNER.id))).toMatchObject({ reason: 'PRIVATE_CHAT' });

    expect(await reasonOf(newGroup())).toMatchObject({ reason: 'NOT_FOUND' });

    const group = newGroup();
    botIn(operator, group, 'member');
    expect(await reasonOf(group)).toMatchObject({ reason: 'BOT_NOT_ADMIN', chatId: group.toString() });
    expect((await rowOf(operator.id)).adminChatId).toBe(0n);
    expect(await audits(operator.id, 'tenant.telegramChat.bindRefused')).toHaveLength(4);

    // Through the link: refused while the bot is only a member, the link stays usable, and the
    // same command binds once the bot is promoted.
    const { nonce } = await issueLink(operator);
    await deliver(operator, startCommand(group, operator.username, nonce));
    expect((await rowOf(operator.id)).adminChatId).toBe(0n);
    expect(sentTo(operator, group).join('\n')).toContain('administrator');
    expect(
      (await prisma.telegramChatBindLink.findFirstOrThrow({ where: { tenantId: operator.id } })).usedAt,
    ).toBeNull();

    botIn(operator, group, 'administrator');
    await deliver(operator, startCommand(group, operator.username, nonce));
    expect((await rowOf(operator.id)).adminChatId).toBe(group);
  });

  it("binds from the directory and by PATCH only when the chat changes, removes by the rules, and never lets an operator's staff do any of it", async () => {
    const operator = await createOperator('console');
    const staffGroup = newGroup();
    botIn(operator, staffGroup, 'administrator');
    await deliver(operator, membership(operator, staffGroup, 'administrator'));

    // The operator's own SUPER_ADMIN (of another operator here, and of its own): 403 everywhere.
    for (const tenantId of [operator.id, TENANT_BOOTSTRAP_ID]) {
      for (const call of [
        api().post(`/v1/admin/tenants/${tenantId}/telegram/bind-links`).send({ purpose: 'STAFF' }),
        api().get(`/v1/admin/tenants/${tenantId}/telegram/chats`),
        api().put(`/v1/admin/tenants/${tenantId}/telegram/chats/STAFF`).send({ chatId: staffGroup.toString() }),
        api().delete(`/v1/admin/tenants/${tenantId}/telegram/chats/FEED`),
        api().patch(`/v1/admin/tenants/${tenantId}`).send({ adminChatId: staffGroup.toString() }),
      ]) {
        const answer = await call.set('authorization', staffBearer).expect(403);
        expect(failure(answer.body).code).toBe('INSUFFICIENT_ROLE');
      }
    }
    expect((await rowOf(operator.id)).adminChatId).toBe(0n);

    // Picked from the directory: verified, bound, confirmed once.
    const picked = tenantViewSchema.parse(data(await putChat(operator, 'STAFF', staffGroup).expect(200)));
    expect(picked.adminChatId).toBe(staffGroup.toString());
    expect(await audits(operator.id, 'tenant.telegramChat.bound')).toHaveLength(1);
    expect(sentTo(operator, staffGroup)).toHaveLength(1);

    // The same chat again: nothing is written or sent.
    await putChat(operator, 'STAFF', staffGroup).expect(200);
    expect(await audits(operator.id, 'tenant.telegramChat.bound')).toHaveLength(1);
    expect(sentTo(operator, staffGroup)).toHaveLength(1);

    // PATCH re-sending the stored staff group asks Telegram nothing.
    const checksBefore = telegram.callsFor(operator.token, 'getChat').length;
    await api()
      .patch(`/v1/admin/tenants/${operator.id}`)
      .set('authorization', platformBearer)
      .send({ displayName: `B1 chats ${RUN} console renamed`, adminChatId: staffGroup.toString() })
      .expect(200);
    expect(telegram.callsFor(operator.token, 'getChat')).toHaveLength(checksBefore);

    // PATCH to a feed group the bot was removed from: refused, and nothing in the body is saved.
    const deadFeed = newGroup();
    botIn(operator, deadFeed, 'kicked');
    const refused = await api()
      .patch(`/v1/admin/tenants/${operator.id}`)
      .set('authorization', platformBearer)
      .send({ displayName: 'Must not land', feedChatId: deadFeed.toString() })
      .expect(400);
    expect(failure(refused.body)).toMatchObject({
      code: 'TELEGRAM_CHAT_REJECTED',
      details: { reason: 'BOT_NOT_MEMBER', purpose: 'FEED', field: 'feedChatId' },
    });
    expect(
      (await prisma.tenant.findUniqueOrThrow({ where: { id: operator.id }, select: { displayName: true } })).displayName,
    ).toBe(`B1 chats ${RUN} console renamed`);

    // PATCH to a feed group the bot administers binds it.
    const feed = newGroup();
    botIn(operator, feed, 'administrator');
    const patched = tenantViewSchema.parse(
      data(
        await api()
          .patch(`/v1/admin/tenants/${operator.id}`)
          .set('authorization', platformBearer)
          .send({ feedChatId: feed.toString() })
          .expect(200),
      ),
    );
    expect(patched.feedChatId).toBe(feed.toString());

    // Removing: the staff group of an ACTIVE operator is refused; the feed group always goes.
    await api().post(`/v1/admin/tenants/${operator.id}/activate`).set('authorization', platformBearer).expect(200);
    const serving = await api()
      .delete(`/v1/admin/tenants/${operator.id}/telegram/chats/STAFF`)
      .set('authorization', platformBearer)
      .expect(422);
    expect(failure(serving.body).code).toBe('TENANT_STAFF_GROUP_REQUIRED');
    const removed = tenantViewSchema.parse(
      data(
        await api()
          .delete(`/v1/admin/tenants/${operator.id}/telegram/chats/FEED`)
          .set('authorization', platformBearer)
          .expect(200),
      ),
    );
    expect(removed).toMatchObject({ adminChatId: staffGroup.toString(), feedChatId: null });
    expect(await audits(operator.id, 'tenant.telegramChat.unbound')).toHaveLength(1);

    // Tenant zero is not an operator and has no groups.
    const platform = await api()
      .post(`/v1/admin/tenants/${TENANT_ZERO_ID}/telegram/bind-links`)
      .set('authorization', platformBearer)
      .send({ purpose: 'STAFF' })
      .expect(422);
    expect(failure(platform.body).code).toBe('TENANT_PLATFORM_LOCKED');
  });

  it('moves every stored id when the staff group becomes a supergroup, from the service message and from a failed send', async () => {
    const operator = await createOperator('migrate');
    const basicGroup = newGroup();
    const supergroup = newGroup();
    botIn(operator, basicGroup, 'administrator', 'group');
    await putChat(operator, 'STAFF', basicGroup).expect(200);
    const carded = await seedDeposit(operator.id, DepositStatus.UNDER_REVIEW, { chatId: basicGroup, messageId: 42n });

    await deliver(operator, {
      update_id: freshUpdateId(),
      message: {
        message_id: 2,
        date: now(),
        chat: { id: Number(basicGroup), type: 'group', title: 'B1 basic' },
        migrate_to_chat_id: Number(supergroup),
      },
    } as unknown as Update);

    expect((await rowOf(operator.id)).adminChatId).toBe(supergroup);
    const deposit = await prisma.depositRequest.findUniqueOrThrow({
      where: { id: carded, tenantId: operator.id },
      select: { adminChatId: true, adminMessageId: true },
    });
    expect(deposit).toEqual({ adminChatId: supergroup, adminMessageId: 42n });
    const directory = await chatsOf(operator);
    expect(directory.find((chat) => chat.chatId === basicGroup.toString())).toMatchObject({
      migratedToChatId: supergroup.toString(),
      isPresent: false,
    });
    expect(directory.find((chat) => chat.chatId === supergroup.toString())).toMatchObject({
      chatType: 'SUPERGROUP',
      boundAs: ['STAFF'],
    });
    expect((await audits(operator.id, 'tenant.telegramChat.migrated'))[0]?.after).toMatchObject({
      adminChatId: supergroup.toString(),
      $meta: { source: 'service_message' },
    });

    // The next migration is only discovered by a send: moved, and the send lands in the new group.
    const nextSupergroup = newGroup();
    telegram.migrateChat(supergroup, nextSupergroup);
    const sent = await ctx.app.get(BotService).notifyAdmins(operator.id, 'B1 ping');
    expect(sent?.chat.id).toBe(Number(nextSupergroup));
    expect((await rowOf(operator.id)).adminChatId).toBe(nextSupergroup);
    expect(sentTo(operator, nextSupergroup)).toContain('B1 ping');
  });

  it('keeps the staff group bound when the bot is removed from it, and says so in the directory and in health', async () => {
    const operator = await createOperator('removed');
    const group = newGroup();
    botIn(operator, group, 'administrator');
    await putChat(operator, 'STAFF', group).expect(200);

    botIn(operator, group, 'kicked');
    await deliver(operator, membership(operator, group, 'kicked'));

    expect((await rowOf(operator.id)).adminChatId).toBe(group);
    expect((await chatsOf(operator))[0]).toMatchObject({
      chatId: group.toString(),
      status: 'KICKED',
      isPresent: false,
      boundAs: ['STAFF'],
    });
    const health = healthSchema.parse(
      data(await api().get(`/v1/admin/tenants/${operator.id}/health`).set('authorization', platformBearer).expect(200)),
    );
    expect(health.chats.staff).toMatchObject({
      chatId: group.toString(),
      status: 'KICKED',
      isPresent: false,
      canPost: false,
    });
  });

  it('rebinds an ACTIVE operator through a link without dispatching the command, and only says so when the link is opened in the group already bound', async () => {
    const operator = await createOperator('active-rebind');
    const first = newGroup();
    botIn(operator, first, 'administrator');
    await putChat(operator, 'STAFF', first).expect(200);
    await api().post(`/v1/admin/tenants/${operator.id}/activate`).set('authorization', platformBearer).expect(200);
    const waiting = await seedDeposit(operator.id, DepositStatus.SUBMITTED);

    const second = newGroup();
    botIn(operator, second, 'administrator');
    const { nonce } = await issueLink(operator);
    const command = startCommand(second, operator.username, nonce);
    expect(await deliver(operator, command)).toBe(true);

    expect(await rowOf(operator.id)).toMatchObject({ status: 'ACTIVE', adminChatId: second });
    // Consumed by the projection: the row names it, not the grammY dispatch, and no player exists.
    const stored = await prisma.telegramUpdate.findFirstOrThrow({
      where: { tenantId: operator.id, updateId: BigInt(command.update_id) },
      select: { handler: true, processedAt: true, payload: true },
    });
    expect(stored.handler).toBe('TelegramChatProjection');
    expect(stored.processedAt).not.toBeNull();
    expect(JSON.stringify(stored.payload)).not.toContain(nonce);
    expect(await prisma.player.count({ where: { tenantId: operator.id, telegramUserId: BigInt(OWNER.id) } })).toBe(0);
    expect((await queuedCards()).map((job) => job.data.depositRequestId)).toEqual([waiting]);
    expect(sentTo(operator, second)).toHaveLength(1);
    expect(await audits(operator.id, 'tenant.telegramChat.bound')).toHaveLength(2);

    // A fresh link opened in the group that is already the staff group: told so, nothing written,
    // and the link is not used up.
    const { nonce: again } = await issueLink(operator);
    await deliver(operator, startCommand(second, operator.username, again));

    const replies = sentTo(operator, second);
    expect(replies).toHaveLength(2);
    expect(replies[1]).toContain('already the staff group');
    expect(await audits(operator.id, 'tenant.telegramChat.bound')).toHaveLength(2);
    const live = await prisma.telegramChatBindLink.findFirstOrThrow({
      where: { tenantId: operator.id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    expect(live.nonceHash).toBe(createHash('sha256').update(again).digest('hex'));
    expect(live.usedAt).toBeNull();
    expect(await rowOf(operator.id)).toMatchObject({ status: 'ACTIVE', adminChatId: second });
  });

  describe('a link belongs to the first group that presents it', () => {
    const OTHER_GROUP_REPLY =
      'This link was opened in another group. Create a new one from the console.';

    const linkOf = (operator: Operator) =>
      prisma.telegramChatBindLink.findFirstOrThrow({
        where: { tenantId: operator.id },
        orderBy: { createdAt: 'desc' },
      });

    const refusalsOf = async (operator: Operator) =>
      (await audits(operator.id, 'tenant.telegramChat.bindRefused')).map(
        (row) => (row.after as { $meta?: Record<string, unknown> } | null)?.$meta,
      );

    it('refuses a link refused on chat grounds when a member replays it from a group they control, and the first group still binds once fixed', async () => {
      const operator = await createOperator('pin-refused');
      const group = newGroup();
      const intruder = newGroup();
      botIn(operator, group, 'member');
      botIn(operator, intruder, 'administrator');
      const { nonce } = await issueLink(operator);

      // Refused on chat grounds: nothing bound, the link not used up, and pinned to this group.
      await deliver(operator, startCommand(group, operator.username, nonce));
      expect((await rowOf(operator.id)).adminChatId).toBe(0n);
      expect(await linkOf(operator)).toMatchObject({ usedAt: null, pinnedChatId: group });

      // Every member of that group read the nonce. Typed in a group where the bot is an administrator:
      await deliver(operator, startCommand(intruder, operator.username, nonce));
      expect((await rowOf(operator.id)).adminChatId).toBe(0n);
      expect(sentTo(operator, intruder)).toEqual([expect.stringContaining(OTHER_GROUP_REPLY)]);
      expect(await linkOf(operator)).toMatchObject({ usedAt: null, pinnedChatId: group });

      // The owner fixes the bot's rights and opens the link again in the first group.
      botIn(operator, group, 'administrator');
      await deliver(operator, startCommand(group, operator.username, nonce));
      expect((await rowOf(operator.id)).adminChatId).toBe(group);
      const link = await linkOf(operator);
      expect(link).toMatchObject({ usedChatId: group, pinnedChatId: group });

      expect(await refusalsOf(operator)).toEqual([
        expect.objectContaining({ reason: 'BOT_NOT_ADMIN', chatId: group.toString() }),
        expect.objectContaining({
          reason: 'LINK_OTHER_CHAT',
          purpose: 'STAFF',
          chatId: intruder.toString(),
          via: 'startgroup',
          linkId: link.id,
          telegramUserId: String(OWNER.id),
        }),
      ]);
      expect(
        JSON.stringify(await audits(operator.id, 'tenant.telegramChat.bindRefused')),
      ).not.toContain(nonce);
    });

    it('refuses a link opened in the group already bound when it is replayed from another group: the staff group and its cards stay', async () => {
      const operator = await createOperator('pin-bound');
      const staff = newGroup();
      botIn(operator, staff, 'administrator');
      await putChat(operator, 'STAFF', staff).expect(200);
      await api()
        .post(`/v1/admin/tenants/${operator.id}/activate`)
        .set('authorization', platformBearer)
        .expect(200);
      const waiting = await seedDeposit(operator.id, DepositStatus.SUBMITTED);

      const { nonce } = await issueLink(operator);
      await deliver(operator, startCommand(staff, operator.username, nonce));
      expect(sentTo(operator, staff).at(-1)).toContain('already the staff group');

      const intruder = newGroup();
      botIn(operator, intruder, 'administrator');
      await deliver(operator, startCommand(intruder, operator.username, nonce));

      expect(await rowOf(operator.id)).toMatchObject({ status: 'ACTIVE', adminChatId: staff });
      expect((await queuedCards()).map((job) => job.data.depositRequestId)).not.toContain(waiting);
      expect(sentTo(operator, intruder)).toEqual([expect.stringContaining(OTHER_GROUP_REPLY)]);
      expect(await audits(operator.id, 'tenant.telegramChat.bound')).toHaveLength(1);
      expect((await refusalsOf(operator)).map((meta) => meta?.['reason'])).toEqual([
        'LINK_OTHER_CHAT',
      ]);
      expect(await linkOf(operator)).toMatchObject({ usedAt: null, pinnedChatId: staff });

      // The bound group still hears it is bound.
      const repliesBefore = sentTo(operator, staff).length;
      await deliver(operator, startCommand(staff, operator.username, nonce));
      expect(sentTo(operator, staff)).toHaveLength(repliesBefore + 1);
      expect(sentTo(operator, staff).at(-1)).toContain('already the staff group');
    });

    it('lets exactly one of several groups racing for one unpinned link have it', async () => {
      const operator = await createOperator('pin-race');
      // Four, not more: the contention that matters is several chats on ONE row, which four make as
      // well as forty, and DB_POOL_MAX is 5 here — a wider race would queue on connections instead.
      const groups = Array.from({ length: 4 }, () => newGroup());
      for (const group of groups) botIn(operator, group, 'administrator');
      const { nonce } = await issueLink(operator);
      const nonceHash = createHash('sha256').update(nonce).digest('hex');
      const bindings = ctx.app.get(ChatBindingService);

      // Straight into the service and all at once, so the only thing between them is the pin.
      const outcomes = await Promise.all(
        groups.map((group) =>
          ctx.inTenant(
            () =>
              bindings.bindFromStartGroup(
                operator.id,
                startCommand(group, operator.username, nonce).message as Message,
                nonceHash,
              ),
            operator.id,
          ),
        ),
      );

      expect(outcomes.filter((outcome) => outcome === 'bound')).toHaveLength(1);
      const winner = groups[outcomes.indexOf('bound')];
      expect(await linkOf(operator)).toMatchObject({ pinnedChatId: winner, usedChatId: winner });
      expect((await rowOf(operator.id)).adminChatId).toBe(winner);
      expect((await refusalsOf(operator)).map((meta) => meta?.['reason'])).toEqual(
        Array.from({ length: groups.length - 1 }, () => 'LINK_OTHER_CHAT'),
      );
      expect(await audits(operator.id, 'tenant.telegramChat.bound')).toHaveLength(1);
    });

    it('moves the pin when the group becomes a supergroup as the bot is promoted, so the owner can still open the link there', async () => {
      const operator = await createOperator('pin-migrate');
      const basic = newGroup();
      const supergroup = newGroup();
      botIn(operator, basic, 'member', 'group');
      const { nonce } = await issueLink(operator);

      await deliver(operator, startCommand(basic, operator.username, nonce, 'group'));
      expect(await linkOf(operator)).toMatchObject({ usedAt: null, pinnedChatId: basic });

      // Promoting the bot with custom rights turns the basic group into a supergroup with a new id.
      telegram.migrateChat(basic, supergroup);
      telegram.setBotMember(operator.token, supergroup, { status: 'administrator' });
      await deliver(operator, {
        update_id: freshUpdateId(),
        message: {
          message_id: 3,
          date: now(),
          chat: { id: Number(basic), type: 'group', title: 'B1 basic' },
          migrate_to_chat_id: Number(supergroup),
        },
      } as unknown as Update);
      expect(await linkOf(operator)).toMatchObject({ usedAt: null, pinnedChatId: supergroup });

      await deliver(operator, startCommand(supergroup, operator.username, nonce));
      expect((await rowOf(operator.id)).adminChatId).toBe(supergroup);
      expect((await refusalsOf(operator)).map((meta) => meta?.['reason'])).toEqual(['BOT_NOT_ADMIN']);
    });
  });
});
