/**
 * The worker's Telegram path against real Postgres and Redis: an update recorded for an operator is
 * dispatched through THAT operator's own bot, built from the sealed token on its tenant row, with the
 * handlers Nest discovery found, inside that operator's tenant context. Only the Bot API is replaced,
 * by the offline fake in test/setup/telegram-fixtures, and BullMQ is left out: what matters is what
 * `process()` does with a job, not the queue.
 *
 * What only this level proves:
 *  - the token is read from `tenants.bot_token_enc` and opened with TenantSecretService;
 *  - the same update_id from two operators runs through two different bots;
 *  - the identity is cached in Redis per operator and bot, and no token is ever written to Redis;
 *  - a rejected, unset or revoked token fails that operator's job, recorded on its real row, and the
 *    next operator's update is still handled;
 *  - a SUSPENDED operator's queued update reaches no bot and no handler.
 *
 * Postgres and Redis come from the shared harness (test/setup): throwaway containers under
 * `npm run test:int`, or the escape hatch when both variables are set:
 *   POSTGRES_TEST_URL=... REDIS_TEST_URL=... npx jest --config jest-int.config.cjs \
 *     --runInBand src/core/telegram/processors/telegram-update.processor.int.spec.ts
 */
import { randomBytes } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, TenantStatus } from '@prisma/client';
import { type Job, UnrecoverableError } from 'bullmq';
import { type Context } from 'grammy';
import { type Update } from 'grammy/types';
import { Redis } from 'ioredis';

import { ActorContextService } from '@core/actor-context/actor-context.service';

import { startPostgres, stopPostgres } from '../../../../test/setup/postgres-container';
import { startRedis, stopRedis } from '../../../../test/setup/redis-container';
import {
  createFakeTelegram,
  testBotInfo,
  type FakeTelegram,
} from '../../../../test/setup/telegram-fixtures';
import { CacheService } from '../../cache/cache.service';
import { LockService } from '../../cache/lock.service';
import { type RedisService } from '../../cache/redis.service';
import { AppConfigService } from '../../config/config.service';
import { type PrismaService } from '../../prisma/prisma.service';
import { TenantRegistryService } from '../../tenant/services/tenant-registry.service';
import { TenantSecretService } from '../../tenant/services/tenant-secret.service';
import { getEffectiveTenantId } from '../../tenant/tenant.storage';
import { type TelegramChatProjectionService } from '../chat-binding/chat-projection.service';
import { type StaffTelegramLinkService } from '../staff-link/staff-telegram-link.service';
import { OnCommand } from '../decorators/handlers.decorator';
import { fingerprintBotToken } from '../services/bot.factory';
import { TelegramHandlerRegistrar } from '../services/handler-registrar.service';
import { TenantBotRegistry } from '../services/tenant-bot-registry.service';
import { UpdateDedupeService } from '../services/update-dedupe.service';
import { TELEGRAM_UPDATE_JOB, telegramBotInfoCacheKey } from '../telegram.constants';
import { TenantBotErrorCodes } from '../tenant-bot.errors';
import { type TelegramUpdateJobData } from '../telegram.types';
import { TelegramUpdateProcessor } from './telegram-update.processor';

const RUN = Date.now().toString(36);
const SLUG_PREFIX = 'p7-bots-';
const ROOT_SECRET = 'p7_int_root_secret_at_least_16_chars_0123456789';

let nextUpdateId = Date.now();
const freshUpdateId = (): number => (nextUpdateId += 1);

const startUpdate = (updateId: number): Update =>
  ({
    update_id: updateId,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 555, type: 'private', first_name: 'Player' },
      from: { id: 555, is_bot: false, first_name: 'Player' },
      text: '/start',
      entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    },
  }) as unknown as Update;

/** A discovered handler, exactly like a feature module's: it records who handled what, then replies. */
@Injectable()
class ProbeHandlers {
  readonly seen: Array<{ tenantId: string | undefined; botId: number; updateId: number }> = [];

  @OnCommand('start')
  async onStart(ctx: Context): Promise<void> {
    this.seen.push({
      tenantId: getEffectiveTenantId(),
      botId: ctx.me.id,
      updateId: ctx.update.update_id,
    });
    await ctx.reply('welcome');
  }
}

interface Operator {
  id: string;
  token: string;
  botId: number;
}

describe('TelegramUpdateProcessor (integration)', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let secrets: TenantSecretService;
  let cache: CacheService;
  let tenants: TenantRegistryService;
  let dedupe: UpdateDedupeService;
  let telegram: FakeTelegram;
  let moduleRef: TestingModule;
  let registrar: TelegramHandlerRegistrar;
  let probe: ProbeHandlers;
  let processor: TelegramUpdateProcessor;

  let operatorA: Operator;
  let operatorE: Operator;
  let rejected: Operator;
  let unset: Operator;
  let suspended: Operator;
  let revokedLater: Operator;

  let nextBotId = 7_100_000_000;

  const createOperator = async (
    name: string,
    status: TenantStatus,
    options: { accepted?: boolean; sealToken?: boolean } = {},
  ): Promise<Operator> => {
    nextBotId += 1;
    const botId = nextBotId;
    const token = `${botId}:AA${randomBytes(18).toString('hex')}`;
    if (options.accepted !== false) telegram.accept(token, testBotInfo(botId, `p7_${name}_bot`));

    const tenant = await prisma.tenant.create({
      data: {
        slug: `${SLUG_PREFIX}${RUN}-${name}`,
        displayName: `P7 bots ${name}`,
        status,
        botTokenEnc:
          options.sealToken === false ? 'REPLACE-ME-BOT-TOKEN' : secrets.sealBotToken(token),
        adminChatId: 0n,
        ichancyBaseUrl: 'https://example.invalid',
        ichancyUsername: 'unused',
        ichancyPasswordEnc: 'P7-INT-NO-AGENT',
        ichancyAgentId: 'unused',
        currencyCode: 'NSP',
        dualApprovalThresholdMinor: 0n,
        agentFloatLowWatermarkMinor: 0n,
        depositExpiryMinutes: 30,
      },
      select: { id: true },
    });
    return { id: tenant.id, token, botId };
  };

  const removeSuiteOperators = async (): Promise<void> => {
    await prisma.tenant.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
  };

  const newProcessor = (): TelegramUpdateProcessor =>
    new TelegramUpdateProcessor(
      new TenantBotRegistry(
        prisma as unknown as PrismaService,
        cache,
        secrets,
        registrar,
        telegram.clientOptions,
      ),
      dedupe,
      new ActorContextService(),
      tenants,
      // These updates are all player /start messages, which the chat projection never claims; the
      // projection itself runs against real rows in chat-binding.int.spec.ts.
      {
        project: () => Promise.resolve({ relevant: false, consumed: false }),
      } as unknown as TelegramChatProjectionService,
      // Nor is any of them a `/link`; the link flow runs against real rows in admin-telegram-link.int.spec.ts.
      {
        handleUpdate: () => Promise.resolve({ consumed: false, result: null }),
      } as unknown as StaffTelegramLinkService,
    );

  /** Records the update the way the webhook does, and returns the job the webhook would queue. */
  const queued = async (
    operator: Operator,
    updateId: number = freshUpdateId(),
  ): Promise<Job<TelegramUpdateJobData, void, string>> => {
    const update = startUpdate(updateId);
    const recorded = await dedupe.record(operator.id, update);
    if (recorded.id === null) throw new Error('update was unexpectedly deduplicated');
    return {
      name: TELEGRAM_UPDATE_JOB,
      attemptsMade: 0,
      data: {
        tenantId: operator.id,
        updateRowId: recorded.id,
        updateId: String(updateId),
        update,
      },
    } as unknown as Job<TelegramUpdateJobData, void, string>;
  };

  const rowOf = (job: Job<TelegramUpdateJobData, void, string>) =>
    prisma.telegramUpdate.findUniqueOrThrow({
      where: { id: job.data.updateRowId },
      select: { processedAt: true, processingError: true, handler: true },
    });

  beforeAll(async () => {
    const [postgres, redisHandle] = await Promise.all([startPostgres(), startRedis()]);
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: postgres.url }) });
    redis = new Redis(redisHandle.url, { maxRetriesPerRequest: null });
    await redis.ping();

    const redisService = redis as unknown as RedisService;
    const prismaService = prisma as unknown as PrismaService;
    cache = new CacheService(redisService);
    secrets = new TenantSecretService(ROOT_SECRET);
    tenants = new TenantRegistryService(prismaService, cache);
    dedupe = new UpdateDedupeService(prismaService, new LockService(redisService));
    telegram = createFakeTelegram();

    // The real discovery scan over a real Nest container, so the probe is found the way feature
    // handlers are.
    moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: [
        TelegramHandlerRegistrar,
        ProbeHandlers,
        { provide: AppConfigService, useValue: { app: { isWorker: true } } },
      ],
    }).compile();
    registrar = moduleRef.get(TelegramHandlerRegistrar);
    probe = moduleRef.get(ProbeHandlers);

    await removeSuiteOperators();
    operatorA = await createOperator('a', TenantStatus.ACTIVE);
    operatorE = await createOperator('e', TenantStatus.ACTIVE);
    rejected = await createOperator('rejected', TenantStatus.ACTIVE, { accepted: false });
    unset = await createOperator('unset', TenantStatus.ACTIVE, { sealToken: false });
    suspended = await createOperator('suspended', TenantStatus.SUSPENDED);
    revokedLater = await createOperator('revoked', TenantStatus.ACTIVE);
  });

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await redis.flushdb();
    probe.seen.length = 0;
    telegram.calls.length = 0;
    processor = newProcessor();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await removeSuiteOperators();
    await redis.flushdb();
    await moduleRef.close();
    await prisma.$disconnect();
    await redis.quit();
    await Promise.all([stopPostgres(), stopRedis()]);
  });

  it('dispatches an update through the bot of the operator that received it, in its tenant context', async () => {
    const job = await queued(operatorA);

    await processor.process(job);

    expect(probe.seen).toEqual([
      { tenantId: operatorA.id, botId: operatorA.botId, updateId: job.data.update.update_id },
    ]);
    expect(telegram.callsFor(operatorA.token, 'sendMessage')).toHaveLength(1);
    expect(telegram.calls.every((call) => call.token === operatorA.token)).toBe(true);
    const row = await rowOf(job);
    expect(row.processedAt).not.toBeNull();
    expect(row.processingError).toBeNull();
    expect(row.handler).toBe(TelegramUpdateProcessor.name);
  });

  it('runs the same update_id from two operators through two different bots', async () => {
    const updateId = freshUpdateId();

    await processor.process(await queued(operatorA, updateId));
    await processor.process(await queued(operatorE, updateId));

    expect(probe.seen).toEqual([
      { tenantId: operatorA.id, botId: operatorA.botId, updateId },
      { tenantId: operatorE.id, botId: operatorE.botId, updateId },
    ]);
    expect(telegram.callsFor(operatorA.token, 'sendMessage')).toHaveLength(1);
    expect(telegram.callsFor(operatorE.token, 'sendMessage')).toHaveLength(1);
  });

  it('caches the identity per operator and bot, bound to its token, and writes no token to Redis', async () => {
    await processor.process(await queued(operatorA));

    const key = telegramBotInfoCacheKey(operatorA.id, String(operatorA.botId));
    const cached = JSON.parse((await redis.get(key)) ?? '{}') as {
      tokenFingerprint?: string;
      botInfo?: { id?: number };
    };
    expect(cached.tokenFingerprint).toBe(fingerprintBotToken(operatorA.token));
    expect(cached.botInfo?.id).toBe(operatorA.botId);
    expect(await redis.exists('telegram:botinfo')).toBe(0);

    for (const redisKey of await redis.keys('*')) {
      if ((await redis.type(redisKey)) !== 'string') continue;
      expect(redisKey).not.toContain(operatorA.token);
      expect((await redis.get(redisKey)) ?? '').not.toContain(operatorA.token);
    }

    // A fresh worker process presets the identity from Redis instead of calling getMe.
    telegram.calls.length = 0;
    await newProcessor().process(await queued(operatorA));
    expect(telegram.callsFor(operatorA.token, 'getMe')).toHaveLength(0);
    expect(telegram.callsFor(operatorA.token, 'sendMessage')).toHaveLength(1);
  });

  it('fails the job of an operator whose token Telegram rejects, and keeps serving the others', async () => {
    const first = await queued(rejected);
    await expect(processor.process(first)).rejects.toBeInstanceOf(UnrecoverableError);

    const failedRow = await rowOf(first);
    expect(failedRow.processedAt).toBeNull();
    expect(failedRow.processingError).toContain(TenantBotErrorCodes.TENANT_BOT_TOKEN_REJECTED);
    expect(failedRow.processingError).not.toContain(rejected.token);

    // The next operator's update is handled as if nothing happened.
    const served = await queued(operatorA);
    await processor.process(served);
    expect(probe.seen.map((entry) => entry.tenantId)).toEqual([operatorA.id]);
    expect((await rowOf(served)).processedAt).not.toBeNull();

    // The rejected operator's backlog does not ask Telegram again.
    await expect(processor.process(await queued(rejected))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(telegram.callsFor(rejected.token, 'getMe')).toHaveLength(1);
  });

  it('fails the job of an operator with no token set, without calling Telegram', async () => {
    const job = await queued(unset);

    await expect(processor.process(job)).rejects.toBeInstanceOf(UnrecoverableError);

    expect((await rowOf(job)).processingError).toContain(
      TenantBotErrorCodes.TENANT_BOT_UNCONFIGURED,
    );
    expect(telegram.calls).toHaveLength(0);
    expect(probe.seen).toHaveLength(0);
  });

  it('drops a SUSPENDED operator’s queued update before any bot or handler', async () => {
    const job = await queued(suspended);

    await expect(processor.process(job)).resolves.toBeUndefined();

    expect(probe.seen).toHaveLength(0);
    expect(telegram.callsFor(suspended.token)).toHaveLength(0);
    const row = await rowOf(job);
    expect(row.processedAt).toBeNull();
    expect(row.processingError).toContain(TenantStatus.SUSPENDED);
  });

  it('catches a token revoked while its bot is cached at the next Telegram call', async () => {
    await processor.process(await queued(revokedLater));
    expect(probe.seen).toHaveLength(1);

    telegram.revoke(revokedLater.token);

    // The cached bot still dispatches (the identity is preset), the handler's reply gets 401, and
    // that 401 drops the bot and its cached identity. The handler error itself is contained.
    await processor.process(await queued(revokedLater));
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      await redis.exists(telegramBotInfoCacheKey(revokedLater.id, String(revokedLater.botId))),
    ).toBe(0);

    // From then on the operator's updates fail cleanly instead of pretending to be served.
    const after = await queued(revokedLater);
    await expect(processor.process(after)).rejects.toBeInstanceOf(UnrecoverableError);
    expect((await rowOf(after)).processingError).toContain(
      TenantBotErrorCodes.TENANT_BOT_TOKEN_REJECTED,
    );
  });
});
