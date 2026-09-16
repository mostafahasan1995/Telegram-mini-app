/**
 * BotService's routing: every send goes through the bot of the operator it names, and the staff and
 * feed chats are that operator's own, read off its tenant row. No chat id comes from anywhere else.
 */
import { Logger } from '@nestjs/common';
import { type Bot, GrammyError } from 'grammy';

import { type PrismaService } from '../../prisma/prisma.service';
import { TenantBotErrorCodes, TenantBotUnavailableError } from '../tenant-bot.errors';
import { BotService } from './bot.service';
import { type TelegramChatMigrationService } from './telegram-chat-migration.service';
import { type TenantBotRegistry } from './tenant-bot-registry.service';

const upgraded = (newChatId: number): GrammyError =>
  new GrammyError(
    'Call to sendMessage failed',
    {
      ok: false,
      error_code: 400,
      description: 'Bad Request: group chat was upgraded to a supergroup chat',
      parameters: { migrate_to_chat_id: newChatId },
    },
    'sendMessage',
    {},
  );

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
/** An operator created before anybody chose its groups: the migration's 0, and no feed. */
const TENANT_NO_CHATS = '33333333-3333-4333-8333-333333333333';

const ADMIN_CHAT_A = -1001111111111n;
const ADMIN_CHAT_B = -1002222222222n;
const FEED_CHAT_B = -1002222222299n;

describe('BotService', () => {
  let apis: Map<string, { sendMessage: jest.Mock; answerCallbackQuery: jest.Mock }>;
  let get: jest.Mock<Promise<Bot>, [string]>;
  let findUnique: jest.Mock;
  let service: BotService;
  let warnSpy: jest.SpyInstance;
  let migrate: jest.Mock;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    apis = new Map();
    for (const tenantId of [TENANT_A, TENANT_B, TENANT_NO_CHATS]) {
      apis.set(tenantId, {
        sendMessage: jest.fn().mockResolvedValue({ message_id: 1, chat: { id: 1 } }),
        answerCallbackQuery: jest.fn().mockResolvedValue(true),
      });
    }
    get = jest.fn((tenantId: string) =>
      Promise.resolve({ api: apis.get(tenantId) } as unknown as Bot),
    );

    const rows = new Map<string, { adminChatId: bigint; feedChatId: bigint | null }>([
      [TENANT_A, { adminChatId: ADMIN_CHAT_A, feedChatId: null }],
      [TENANT_B, { adminChatId: ADMIN_CHAT_B, feedChatId: FEED_CHAT_B }],
      [TENANT_NO_CHATS, { adminChatId: 0n, feedChatId: null }],
    ]);
    findUnique = jest.fn((args: { where: { id: string } }) =>
      Promise.resolve(rows.get(args.where.id) ?? null),
    );

    migrate = jest.fn().mockResolvedValue({ staffMoved: true, feedMoved: false, cardsMoved: 0 });
    service = new BotService(
      { get } as unknown as TenantBotRegistry,
      { tenant: { findUnique } } as unknown as PrismaService,
      { migrate } as unknown as TelegramChatMigrationService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends a staff notification through the named operator’s bot, to that operator’s admin chat', async () => {
    await service.notifyAdmins(TENANT_B, 'card');

    expect(get).toHaveBeenCalledWith(TENANT_B);
    expect(apis.get(TENANT_B)?.sendMessage).toHaveBeenCalledWith(
      ADMIN_CHAT_B.toString(),
      'card',
      expect.any(Object),
    );
    expect(apis.get(TENANT_A)?.sendMessage).not.toHaveBeenCalled();
  });

  it('gives two operators two different admin chats', async () => {
    await service.notifyAdmins(TENANT_A, 'a');
    await service.notifyAdmins(TENANT_B, 'b');

    expect(apis.get(TENANT_A)?.sendMessage.mock.calls[0]?.[0]).toBe(ADMIN_CHAT_A.toString());
    expect(apis.get(TENANT_B)?.sendMessage.mock.calls[0]?.[0]).toBe(ADMIN_CHAT_B.toString());
  });

  it('answers null without touching any bot when the operator has no admin chat yet', async () => {
    await expect(service.notifyAdmins(TENANT_NO_CHATS, 'card')).resolves.toBeNull();
    await expect(service.notifyAdmins(TENANT_NO_CHATS, 'card')).resolves.toBeNull();

    expect(get).not.toHaveBeenCalled();
    // Visible once, not once per card.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('posts to the operator’s own feed chat, and to nothing when it has none', async () => {
    await service.notifyFeed(TENANT_B, 'masked card');
    expect(apis.get(TENANT_B)?.sendMessage).toHaveBeenCalledWith(
      FEED_CHAT_B.toString(),
      'masked card',
      expect.any(Object),
    );

    await expect(service.notifyFeed(TENANT_A, 'masked card')).resolves.toBeNull();
    expect(apis.get(TENANT_A)?.sendMessage).not.toHaveBeenCalled();
  });

  it('reports an operator’s chats, with 0 and unknown operators reading as unset', async () => {
    await expect(service.chatsOf(TENANT_B)).resolves.toEqual({
      adminChatId: ADMIN_CHAT_B,
      feedChatId: FEED_CHAT_B,
    });
    await expect(service.chatsOf(TENANT_NO_CHATS)).resolves.toEqual({
      adminChatId: null,
      feedChatId: null,
    });
    await expect(service.chatsOf('not-a-uuid')).resolves.toEqual({
      adminChatId: null,
      feedChatId: null,
    });
    // A malformed id never reaches Postgres, where it would raise instead of matching nothing.
    expect(findUnique).toHaveBeenCalledTimes(2);
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

  it('moves a group that became a supergroup and retries the send once, against the new id', async () => {
    const api = apis.get(TENANT_A);
    api?.sendMessage.mockRejectedValueOnce(upgraded(-1009999999999));

    await expect(service.notifyAdmins(TENANT_A, 'card')).resolves.toMatchObject({ message_id: 1 });

    expect(migrate).toHaveBeenCalledWith(TENANT_A, ADMIN_CHAT_A, -1009999999999n, 'send_error');
    expect(api?.sendMessage.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      ADMIN_CHAT_A.toString(),
      '-1009999999999',
    ]);
  });

  it('retries a migrated chat only once, and does not follow a @username at all', async () => {
    const api = apis.get(TENANT_A);
    api?.sendMessage.mockRejectedValue(upgraded(-1009999999999));

    await expect(service.sendMessage(TENANT_A, ADMIN_CHAT_A, 'card')).rejects.toBeInstanceOf(
      GrammyError,
    );
    expect(api?.sendMessage).toHaveBeenCalledTimes(2);

    migrate.mockClear();
    await expect(service.sendMessage(TENANT_A, '@public_group', 'card')).rejects.toBeInstanceOf(
      GrammyError,
    );
    expect(migrate).not.toHaveBeenCalled();
  });

  it('never throws from answerCallback, even without a working bot', async () => {
    get.mockRejectedValueOnce(new Error('no bot'));

    await expect(service.answerCallback(TENANT_A, 'cbq-1', 'ok')).resolves.toBeUndefined();
  });
});
