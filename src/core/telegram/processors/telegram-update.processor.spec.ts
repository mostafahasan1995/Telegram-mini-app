/**
 * The dispatch decisions of TelegramUpdateProcessor, with every collaborator stubbed. The integration
 * spec beside this file runs the same decisions against real rows, real Redis and real grammY bots.
 */
import { Logger } from '@nestjs/common';
import { TenantStatus } from '@prisma/client';
import { type Job, UnrecoverableError } from 'bullmq';
import { type Bot } from 'grammy';
import { type Update } from 'grammy/types';

import { getCurrentActor } from '@core/actor-context/actor-context.storage';
import { ActorContextService } from '@core/actor-context/actor-context.service';

import {
  type TenantRegistryService,
  type TenantSummary,
} from '../../tenant/services/tenant-registry.service';
import { getEffectiveTenantId } from '../../tenant/tenant.storage';
import { type TenantBotRegistry } from '../services/tenant-bot-registry.service';
import { type UpdateDedupeService } from '../services/update-dedupe.service';
import { TELEGRAM_UPDATE_JOB } from '../telegram.constants';
import { TenantBotErrorCodes, TenantBotUnavailableError } from '../tenant-bot.errors';
import { type TelegramUpdateJobData } from '../telegram.types';
import { TelegramUpdateProcessor } from './telegram-update.processor';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

const summary = (id: string, status: TenantStatus): TenantSummary => ({
  id,
  slug: id.slice(0, 4),
  displayName: 'Operator',
  status,
  currencyCode: 'NSP',
});

const jobOf = (
  data: Partial<TelegramUpdateJobData>,
  name: string = TELEGRAM_UPDATE_JOB,
): Job<TelegramUpdateJobData, void, string> =>
  ({
    name,
    attemptsMade: 0,
    data: {
      tenantId: TENANT_A,
      updateRowId: 'row-1',
      updateId: '100',
      update: { update_id: 100 } as Update,
      ...data,
    },
  }) as unknown as Job<TelegramUpdateJobData, void, string>;

describe('TelegramUpdateProcessor', () => {
  let statuses: Map<string, TenantStatus>;
  let get: jest.Mock<Promise<Bot>, [string]>;
  let markProcessed: jest.Mock;
  let markFailed: jest.Mock;
  let seen: Array<{ tenantId: string | undefined; actor: string }>;
  let warn: jest.SpyInstance;
  let processor: TelegramUpdateProcessor;

  const botFor = (label: string): Bot =>
    ({
      handleUpdate: jest.fn(() => {
        seen.push({
          tenantId: getEffectiveTenantId(),
          actor: `${label}:${getCurrentActor().type}`,
        });
        return Promise.resolve();
      }),
    }) as unknown as Bot;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    statuses = new Map([
      [TENANT_A, TenantStatus.ACTIVE],
      [TENANT_B, TenantStatus.ACTIVE],
    ]);
    seen = [];
    get = jest.fn((tenantId: string) => Promise.resolve(botFor(tenantId)));
    markProcessed = jest.fn().mockResolvedValue(undefined);
    markFailed = jest.fn().mockResolvedValue(undefined);

    processor = new TelegramUpdateProcessor(
      { get } as unknown as TenantBotRegistry,
      { markProcessed, markFailed } as unknown as UpdateDedupeService,
      new ActorContextService(),
      {
        find: (id: string) => {
          const status = statuses.get(id);
          return Promise.resolve(status === undefined ? null : summary(id, status));
        },
      } as unknown as TenantRegistryService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('dispatches through the job’s operator’s bot inside that operator’s tenant context', async () => {
    await processor.process(jobOf({ tenantId: TENANT_B, updateRowId: 'row-b' }));

    expect(get).toHaveBeenCalledWith(TENANT_B);
    expect(seen).toEqual([{ tenantId: TENANT_B, actor: `${TENANT_B}:SYSTEM` }]);
    expect(markProcessed).toHaveBeenCalledWith('row-b', TelegramUpdateProcessor.name);
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('refuses a job on another queue name', async () => {
    await expect(processor.process(jobOf({}, 'something-else'))).rejects.toThrow('Unexpected job');
    expect(get).not.toHaveBeenCalled();
  });

  it('fails a job with no tenant without retries and without dispatching anything', async () => {
    // Job data is JSON from Redis: a job queued before ingress was per-operator has no tenantId.
    const job = jobOf({ tenantId: undefined });

    await expect(processor.process(job)).rejects.toBeInstanceOf(UnrecoverableError);

    expect(get).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith('row-1', expect.stringContaining('has no tenant'));
  });

  it.each([TenantStatus.SUSPENDED, TenantStatus.CLOSED])(
    'drops a %s operator’s update: no bot, no handler, the row says why, the job completes',
    async (status) => {
      statuses.set(TENANT_A, status);

      await expect(processor.process(jobOf({}))).resolves.toBeUndefined();
      await expect(processor.process(jobOf({ updateRowId: 'row-2' }))).resolves.toBeUndefined();

      expect(get).not.toHaveBeenCalled();
      expect(seen).toHaveLength(0);
      expect(markProcessed).not.toHaveBeenCalled();
      expect(markFailed).toHaveBeenCalledWith('row-1', expect.stringContaining(status));
      // A backlog logs once, not once per update.
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );

  it('drops the update of an operator that no longer exists', async () => {
    statuses.delete(TENANT_A);

    await expect(processor.process(jobOf({}))).resolves.toBeUndefined();

    expect(get).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith('row-1', expect.stringContaining('NOT_FOUND'));
  });

  it('fails the job without retries when the operator’s token cannot work', async () => {
    const rejected = new TenantBotUnavailableError(
      TenantBotErrorCodes.TENANT_BOT_TOKEN_REJECTED,
      TENANT_A,
      false,
      `Telegram rejected the bot token of tenant ${TENANT_A}`,
    );
    get.mockRejectedValueOnce(rejected);

    await expect(processor.process(jobOf({}))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(markFailed).toHaveBeenCalledWith(
      'row-1',
      expect.stringContaining(TenantBotErrorCodes.TENANT_BOT_TOKEN_REJECTED),
    );
    expect(markProcessed).not.toHaveBeenCalled();
  });

  it('rethrows a retryable bot failure so BullMQ backs off and tries again', async () => {
    const unreachable = new TenantBotUnavailableError(
      TenantBotErrorCodes.TENANT_BOT_UNREACHABLE,
      TENANT_A,
      true,
      'getMe timed out',
    );
    get.mockRejectedValueOnce(unreachable);

    await expect(processor.process(jobOf({}))).rejects.toBe(unreachable);
    expect(markFailed).toHaveBeenCalledTimes(1);
  });

  it('keeps serving other operators after one operator’s bot fails', async () => {
    get.mockImplementation((tenantId: string) =>
      tenantId === TENANT_A
        ? Promise.reject(
            new TenantBotUnavailableError(
              TenantBotErrorCodes.TENANT_BOT_UNCONFIGURED,
              TENANT_A,
              false,
              'not set',
            ),
          )
        : Promise.resolve(botFor(tenantId)),
    );

    await expect(processor.process(jobOf({}))).rejects.toBeInstanceOf(UnrecoverableError);
    await processor.process(jobOf({ tenantId: TENANT_B, updateRowId: 'row-b' }));

    expect(seen).toEqual([{ tenantId: TENANT_B, actor: `${TENANT_B}:SYSTEM` }]);
    expect(markProcessed).toHaveBeenCalledWith('row-b', TelegramUpdateProcessor.name);
  });

  it('records a failure that escapes handleUpdate and rethrows it for a retry', async () => {
    const boom = new Error('grammY internal failure');
    get.mockResolvedValueOnce({
      handleUpdate: jest.fn().mockRejectedValue(boom),
    } as unknown as Bot);

    await expect(processor.process(jobOf({}))).rejects.toBe(boom);
    expect(markFailed).toHaveBeenCalledWith('row-1', boom);
  });

  it('never lets a failing row write replace the error that explains the failure', async () => {
    markFailed.mockRejectedValue(new Error('database is down'));
    get.mockRejectedValueOnce(
      new TenantBotUnavailableError(
        TenantBotErrorCodes.TENANT_BOT_TOKEN_REJECTED,
        TENANT_A,
        false,
        'rejected',
      ),
    );

    await expect(processor.process(jobOf({}))).rejects.toThrow('rejected');
  });
});
