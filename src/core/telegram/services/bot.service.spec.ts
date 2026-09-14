/**
 * BotService's routing: every send goes through the bot of the operator it names, and the platform
 * sends that have no bot answer null without touching any operator's bot.
 */
import { Logger } from '@nestjs/common';
import { type Bot, GrammyError } from 'grammy';

import { type AppConfigService } from '../../config/config.service';
import { TenantBotErrorCodes, TenantBotUnavailableError } from '../tenant-bot.errors';
import { BotService } from './bot.service';
import { type TenantBotRegistry } from './tenant-bot-registry.service';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ADMIN_CHAT = -1001234567890n;

describe('BotService', () => {
  let apis: Map<string, { sendMessage: jest.Mock; answerCallbackQuery: jest.Mock }>;
  let get: jest.Mock<Promise<Bot>, [string]>;
  let service: BotService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    apis = new Map();
    for (const tenantId of [TENANT_A, TENANT_B]) {
      apis.set(tenantId, {
        sendMessage: jest.fn().mockResolvedValue({ message_id: 1, chat: { id: 1 } }),
        answerCallbackQuery: jest.fn().mockResolvedValue(true),
      });
    }
    get = jest.fn((tenantId: string) =>
      Promise.resolve({ api: apis.get(tenantId) } as unknown as Bot),
    );

    service = new BotService(
      { get } as unknown as TenantBotRegistry,
      { telegram: { adminChatId: ADMIN_CHAT, feedChatId: null } } as unknown as AppConfigService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends through the named operator’s bot and no other', async () => {
    await service.notifyAdmins(TENANT_B, 'card');

    expect(get).toHaveBeenCalledWith(TENANT_B);
    expect(apis.get(TENANT_B)?.sendMessage).toHaveBeenCalledWith(
      ADMIN_CHAT.toString(),
      'card',
      expect.any(Object),
    );
    expect(apis.get(TENANT_A)?.sendMessage).not.toHaveBeenCalled();
  });

  it('still answers null for a chat that blocked the operator’s bot', async () => {
    apis
      .get(TENANT_A)
      ?.sendMessage.mockRejectedValue(
        new GrammyError(
          'Call to sendMessage failed',
          { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
          'sendMessage',
          {},
        ),
      );

    await expect(service.sendMessage(TENANT_A, 42n, 'hi')).resolves.toBeNull();
  });

  it('throws when the operator has no working bot, so the caller’s retry policy decides', async () => {
    const unavailable = new TenantBotUnavailableError(
      TenantBotErrorCodes.TENANT_BOT_UNCONFIGURED,
      TENANT_A,
      false,
      'not set',
    );
    get.mockRejectedValueOnce(unavailable);

    await expect(service.sendMessage(TENANT_A, 42n, 'hi')).rejects.toBe(unavailable);
  });

  it('never throws from answerCallback, even without a working bot', async () => {
    get.mockRejectedValueOnce(new Error('no bot'));

    await expect(service.answerCallback(TENANT_A, 'cbq-1', 'ok')).resolves.toBeUndefined();
  });

  it('answers null for platform alerts without touching any operator’s bot', async () => {
    await expect(service.notifyPlatformAdmins('🚨 ledger')).resolves.toBeNull();
    await expect(service.notifyPlatformFeed('report')).resolves.toBeNull();

    expect(get).not.toHaveBeenCalled();
  });
});
