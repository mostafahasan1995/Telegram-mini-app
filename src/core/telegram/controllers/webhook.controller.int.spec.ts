/**
 * POST /telegram/webhook/:token against real Postgres and Redis: the tenant lookup by
 * `webhook_path_token`, the per-tenant sealed secret, the tenant-keyed dedupe row and the job
 * payload. The controller is built directly from its real collaborators. Only the BullMQ queue is a
 * recording fake, because what matters is what gets enqueued, not BullMQ itself.
 *
 * What only this level proves:
 *  - a secret sealed with TenantSecretService on a real row authenticates, and nothing else does;
 *  - an unknown token, a wrong secret, a missing header and an unset secret are one refusal;
 *  - two operators delivering the same update_id both persist and both enqueue;
 *  - a SUSPENDED or CLOSED operator is answered 200 and nothing is stored or enqueued;
 *  - no Redis key carries a path token.
 *
 * Run with the escape hatch:
 *   POSTGRES_TEST_URL=... REDIS_TEST_URL=... npx jest --config jest-int.config.cjs --runInBand \
 *     src/core/telegram/controllers/webhook.controller.int.spec.ts
 */
import { randomBytes } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, TenantStatus } from '@prisma/client';
import { type Queue } from 'bullmq';
import { type Update } from 'grammy/types';
import { Redis } from 'ioredis';

import { AppException } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';

import { CacheService } from '../../cache/cache.service';
import { LockService } from '../../cache/lock.service';
import { type RedisService } from '../../cache/redis.service';
import { type PrismaService } from '../../prisma/prisma.service';
import { TenantRegistryService } from '../../tenant/services/tenant-registry.service';
import { TenantSecretService } from '../../tenant/services/tenant-secret.service';
import { UpdateDedupeService } from '../services/update-dedupe.service';
import { TELEGRAM_UPDATE_JOB } from '../telegram.constants';
import { type TelegramUpdateJobData } from '../telegram.types';
import { TelegramWebhookController } from './webhook.controller';

const REDIS_URL = process.env.TEST_REDIS_URL ?? process.env.REDIS_TEST_URL ?? '';
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.POSTGRES_TEST_URL ?? '';
if (REDIS_URL === '' || DATABASE_URL === '') {
  throw new Error('Set POSTGRES_TEST_URL and REDIS_TEST_URL to a THROWAWAY database and Redis.');
}

const RUN = Date.now().toString(36);
const SLUG_PREFIX = 'p6-webhook-';
const ROOT_SECRET = 'p6_int_root_secret_at_least_16_chars_0123456789';

let nextUpdateId = Date.now();
const freshUpdateId = (): number => (nextUpdateId += 1);

const messageUpdate = (updateId: number): Update => ({
  update_id: updateId,
  message: {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 555, type: 'private', first_name: 'Player' },
    from: { id: 555, is_bot: false, first_name: 'Player' },
    text: '/start',
  },
});

interface Operator {
  id: string;
  pathToken: string;
  secret: string;
}

interface Refusal {
  status: number;
  code: string;
  message: string;
}

type AddCall = [string, TelegramUpdateJobData, { jobId: string }];

describe('TelegramWebhookController (integration)', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let registry: TenantRegistryService;
  let secrets: TenantSecretService;
  let controller: TelegramWebhookController;
  const add = jest.fn<Promise<unknown>, AddCall>();

  let active: Operator;
  let other: Operator;
  let suspended: Operator;
  let closed: Operator;
  let unconfigured: Operator;

  const createOperator = async (
    name: string,
    status: TenantStatus,
    options: { sealSecret?: boolean } = {},
  ): Promise<Operator> => {
    const pathToken = `p6${randomBytes(24).toString('hex')}`;
    const secret = randomBytes(24).toString('base64url');
    const tenant = await prisma.tenant.create({
      data: {
        slug: `${SLUG_PREFIX}${RUN}-${name}`,
        displayName: `P6 webhook ${name}`,
        status,
        botTokenEnc: 'P6-INT-NO-BOT',
        webhookPathToken: pathToken,
        webhookSecretEnc: options.sealSecret === false ? null : secrets.sealWebhookSecret(secret),
        adminChatId: 0n,
        ichancyBaseUrl: 'https://example.invalid',
        ichancyUsername: 'unused',
        ichancyPasswordEnc: 'P6-INT-NO-AGENT',
        ichancyAgentId: 'unused',
        currencyCode: 'NSP',
        dualApprovalThresholdMinor: 0n,
        agentFloatLowWatermarkMinor: 0n,
        depositExpiryMinutes: 30,
      },
      select: { id: true },
    });
    return { id: tenant.id, pathToken, secret };
  };

  const removeSuiteOperators = async (): Promise<void> => {
    await prisma.tenant.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
  };

  const rowCount = (tenantId: string, updateId: number): Promise<number> =>
    prisma.telegramUpdate.count({ where: { tenantId, updateId: BigInt(updateId) } });

  const refusalOf = async (call: Promise<unknown>): Promise<Refusal> => {
    const outcome = await call.then(
      () => null,
      (error: unknown) => error,
    );
    if (!(outcome instanceof AppException)) {
      throw new Error(`Expected an AppException refusal, got ${String(outcome)}`);
    }
    return { status: outcome.httpStatus, code: outcome.errorCode, message: outcome.message };
  };

  const EXPECTED_REFUSAL: Refusal = {
    status: 403,
    code: CommonErrorCodes.TELEGRAM_WEBHOOK_SECRET_INVALID,
    message: 'Invalid webhook credentials.',
  };

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    await redis.ping();

    const redisService = redis as unknown as RedisService;
    const prismaService = prisma as unknown as PrismaService;
    registry = new TenantRegistryService(prismaService, new CacheService(redisService));
    secrets = new TenantSecretService(ROOT_SECRET);
    const dedupe = new UpdateDedupeService(prismaService, new LockService(redisService));
    controller = new TelegramWebhookController(registry, secrets, dedupe, {
      add,
    } as unknown as Queue<TelegramUpdateJobData>);

    await removeSuiteOperators();
    active = await createOperator('active', TenantStatus.ACTIVE);
    other = await createOperator('other', TenantStatus.ACTIVE);
    suspended = await createOperator('suspended', TenantStatus.SUSPENDED);
    closed = await createOperator('closed', TenantStatus.CLOSED);
    unconfigured = await createOperator('unconfigured', TenantStatus.ACTIVE, { sealSecret: false });
  });

  beforeEach(async () => {
    add.mockReset();
    add.mockResolvedValue(undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await redis.flushdb();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await removeSuiteOperators();
    await prisma.$disconnect();
    await redis.quit();
  });

  describe('a genuine delivery', () => {
    it('persists the update under its operator and enqueues it tagged with the tenant', async () => {
      const updateId = freshUpdateId();
      const update = messageUpdate(updateId);

      await expect(controller.receive(active.pathToken, active.secret, update)).resolves.toEqual({
        ok: true,
      });

      const row = await prisma.telegramUpdate.findFirstOrThrow({
        where: { tenantId: active.id, updateId: BigInt(updateId) },
      });
      expect(add).toHaveBeenCalledTimes(1);
      const [name, data, options] = add.mock.calls[0] as AddCall;
      expect(name).toBe(TELEGRAM_UPDATE_JOB);
      expect(data).toEqual({
        tenantId: active.id,
        updateRowId: row.id,
        updateId: String(updateId),
        update,
      });
      expect(options.jobId).toBe(`tg-${active.id}-${updateId}`);
    });

    it('persists and enqueues the same update_id from two operators separately', async () => {
      const updateId = freshUpdateId();

      await controller.receive(active.pathToken, active.secret, messageUpdate(updateId));
      await controller.receive(other.pathToken, other.secret, messageUpdate(updateId));

      expect(await rowCount(active.id, updateId)).toBe(1);
      expect(await rowCount(other.id, updateId)).toBe(1);
      const jobs = add.mock.calls.map(([, data, options]) => ({
        tenantId: data.tenantId,
        jobId: options.jobId,
      }));
      expect(jobs).toEqual([
        { tenantId: active.id, jobId: `tg-${active.id}-${updateId}` },
        { tenantId: other.id, jobId: `tg-${other.id}-${updateId}` },
      ]);
    });

    it('answers 200 without storing anything when the body has no update_id', async () => {
      const probe = { message: { text: 'no id' } } as unknown as Update;

      await expect(controller.receive(active.pathToken, active.secret, probe)).resolves.toEqual({
        ok: true,
      });
      expect(add).not.toHaveBeenCalled();
    });
  });

  describe('replay', () => {
    it('dedupes a redelivery for the same operator and enqueues once', async () => {
      const updateId = freshUpdateId();
      const update = messageUpdate(updateId);

      await controller.receive(active.pathToken, active.secret, update);
      const replay = await controller.receive(active.pathToken, active.secret, update);

      expect(replay).toEqual({ ok: true, deduped: true });
      expect(add).toHaveBeenCalledTimes(1);
      expect(await rowCount(active.id, updateId)).toBe(1);
    });

    it('still dedupes after Redis is flushed, and still accepts the other operator', async () => {
      const updateId = freshUpdateId();
      await controller.receive(active.pathToken, active.secret, messageUpdate(updateId));
      await redis.flushdb();

      const replay = await controller.receive(
        active.pathToken,
        active.secret,
        messageUpdate(updateId),
      );
      const fromOther = await controller.receive(
        other.pathToken,
        other.secret,
        messageUpdate(updateId),
      );

      expect(replay).toEqual({ ok: true, deduped: true });
      expect(fromOther).toEqual({ ok: true });
      expect(add).toHaveBeenCalledTimes(2);
    });

    it('rolls the record back when the enqueue fails, so the retry is accepted', async () => {
      const updateId = freshUpdateId();
      add.mockRejectedValueOnce(new Error('redis went away'));

      await expect(
        controller.receive(active.pathToken, active.secret, messageUpdate(updateId)),
      ).rejects.toThrow('redis went away');
      expect(await rowCount(active.id, updateId)).toBe(0);

      await expect(
        controller.receive(active.pathToken, active.secret, messageUpdate(updateId)),
      ).resolves.toEqual({ ok: true });
      expect(await rowCount(active.id, updateId)).toBe(1);
    });
  });

  describe('refusals', () => {
    it('refuses a wrong secret for a real token with 403 and stores nothing', async () => {
      const updateId = freshUpdateId();

      const refusal = await refusalOf(
        controller.receive(active.pathToken, 'not-the-secret', messageUpdate(updateId)),
      );

      expect(refusal).toEqual(EXPECTED_REFUSAL);
      expect(await rowCount(active.id, updateId)).toBe(0);
      expect(add).not.toHaveBeenCalled();
    });

    it("refuses another operator's secret on this operator's path", async () => {
      const refusal = await refusalOf(
        controller.receive(active.pathToken, other.secret, messageUpdate(freshUpdateId())),
      );
      expect(refusal).toEqual(EXPECTED_REFUSAL);
    });

    it('refuses a missing secret header', async () => {
      const refusal = await refusalOf(
        controller.receive(active.pathToken, undefined, messageUpdate(freshUpdateId())),
      );
      expect(refusal).toEqual(EXPECTED_REFUSAL);
    });

    it('refuses an unknown token exactly like a wrong secret', async () => {
      const unknown = `p6${randomBytes(24).toString('hex')}`;

      const wrongSecret = await refusalOf(
        controller.receive(active.pathToken, 'guess', messageUpdate(freshUpdateId())),
      );
      const unknownToken = await refusalOf(
        controller.receive(unknown, active.secret, messageUpdate(freshUpdateId())),
      );
      const malformedToken = await refusalOf(
        controller.receive('../etc', active.secret, messageUpdate(freshUpdateId())),
      );

      expect(unknownToken).toEqual(wrongSecret);
      expect(malformedToken).toEqual(wrongSecret);
      expect(add).not.toHaveBeenCalled();
    });

    it('caches the miss without ever writing a path token into a Redis key', async () => {
      const unknown = `p6${randomBytes(24).toString('hex')}`;
      await refusalOf(controller.receive(unknown, 'x', messageUpdate(freshUpdateId())));
      await controller.receive(active.pathToken, active.secret, messageUpdate(freshUpdateId()));

      const keys = await redis.keys('*');
      expect(keys.some((key) => key.startsWith('tenant:webhook:'))).toBe(true);
      expect(keys.some((key) => key.includes(unknown) || key.includes(active.pathToken))).toBe(
        false,
      );
    });

    it('refuses every delivery for an operator whose secret was never set', async () => {
      const refusal = await refusalOf(
        controller.receive(unconfigured.pathToken, '', messageUpdate(freshUpdateId())),
      );
      expect(refusal).toEqual(EXPECTED_REFUSAL);
    });
  });

  describe('an operator that is not ACTIVE', () => {
    it('answers a SUSPENDED operator 200, stores nothing, enqueues nothing, and logs once', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const first = freshUpdateId();
      const second = freshUpdateId();

      await expect(
        controller.receive(suspended.pathToken, suspended.secret, messageUpdate(first)),
      ).resolves.toEqual({ ok: true });
      await expect(
        controller.receive(suspended.pathToken, suspended.secret, messageUpdate(second)),
      ).resolves.toEqual({ ok: true });

      expect(await rowCount(suspended.id, first)).toBe(0);
      expect(await rowCount(suspended.id, second)).toBe(0);
      expect(add).not.toHaveBeenCalled();
      const mentions = warn.mock.calls.filter(([message]) =>
        String(message).includes(suspended.id),
      );
      expect(mentions).toHaveLength(1);
    });

    it('answers a CLOSED operator 200 and stores nothing', async () => {
      const updateId = freshUpdateId();

      await expect(
        controller.receive(closed.pathToken, closed.secret, messageUpdate(updateId)),
      ).resolves.toEqual({ ok: true });

      expect(await rowCount(closed.id, updateId)).toBe(0);
      expect(add).not.toHaveBeenCalled();
    });

    it('still refuses a wrong secret for a SUSPENDED operator, so the status never leaks', async () => {
      const refusal = await refusalOf(
        controller.receive(suspended.pathToken, 'guess', messageUpdate(freshUpdateId())),
      );
      expect(refusal).toEqual(EXPECTED_REFUSAL);
    });

    it('stops storing as soon as a suspension is invalidated, and resumes on reactivation', async () => {
      const toggled = await createOperator('toggled', TenantStatus.ACTIVE);
      const setStatus = async (status: TenantStatus): Promise<void> => {
        await prisma.tenant.update({ where: { id: toggled.id }, data: { status } });
        await registry.invalidate(toggled.id);
      };

      const before = freshUpdateId();
      await controller.receive(toggled.pathToken, toggled.secret, messageUpdate(before));
      expect(await rowCount(toggled.id, before)).toBe(1);

      await setStatus(TenantStatus.SUSPENDED);
      const during = freshUpdateId();
      await controller.receive(toggled.pathToken, toggled.secret, messageUpdate(during));
      expect(await rowCount(toggled.id, during)).toBe(0);

      await setStatus(TenantStatus.ACTIVE);
      const after = freshUpdateId();
      await controller.receive(toggled.pathToken, toggled.secret, messageUpdate(after));
      expect(await rowCount(toggled.id, after)).toBe(1);
    });
  });
});
