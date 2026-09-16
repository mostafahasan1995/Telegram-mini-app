/**
 * verifyTelegramChat against a stubbed Bot API: every reason a chat cannot be a staff or feed group,
 * the one hop a supergroup migration earns, and which Telegram failures are thrown rather than reported.
 */
import { GrammyError, HttpError } from 'grammy';

import { verifyTelegramChat, type ChatLookupApi } from './chat-verification.util';

const BOT_ID = 777;
const GROUP = -1001234567890n;
const SUPERGROUP = -1009999999999n;

const telegramError = (
  code: number,
  description: string,
  parameters: Record<string, unknown> = {},
): GrammyError =>
  new GrammyError('failed', { ok: false, error_code: code, description, parameters }, 'getChat', {});

describe('verifyTelegramChat', () => {
  let getChat: jest.Mock;
  let getChatMember: jest.Mock;
  let api: ChatLookupApi;

  beforeEach(() => {
    getChat = jest.fn().mockResolvedValue({ id: Number(GROUP), type: 'supergroup', title: 'Staff' });
    getChatMember = jest.fn().mockResolvedValue({ status: 'administrator', user: { id: BOT_ID } });
    api = { getChat, getChatMember };
  });

  it('accepts a supergroup where the bot is an administrator, asking about the bot itself', async () => {
    await expect(verifyTelegramChat(api, BOT_ID, GROUP)).resolves.toEqual({
      ok: true,
      migratedFrom: null,
      chat: {
        chatId: GROUP,
        chatType: 'SUPERGROUP',
        title: 'Staff',
        username: null,
        facts: { status: 'ADMINISTRATOR', isAdministrator: true, isPresent: true, canPost: true },
      },
    });
    expect(getChat).toHaveBeenCalledWith(GROUP.toString());
    expect(getChatMember).toHaveBeenCalledWith(GROUP.toString(), BOT_ID);
  });

  it('refuses a private chat and a channel before asking about membership', async () => {
    getChat.mockResolvedValueOnce({ id: 42, type: 'private', first_name: 'Person' });
    await expect(verifyTelegramChat(api, BOT_ID, 42n)).resolves.toMatchObject({
      ok: false,
      reason: 'PRIVATE_CHAT',
    });

    getChat.mockResolvedValueOnce({ id: Number(GROUP), type: 'channel', title: 'News' });
    await expect(verifyTelegramChat(api, BOT_ID, GROUP)).resolves.toMatchObject({
      ok: false,
      reason: 'CHANNEL_NOT_ALLOWED',
    });
    expect(getChatMember).not.toHaveBeenCalled();
  });

  it('reports a chat Telegram does not know, with Telegram’s own words', async () => {
    getChat.mockRejectedValueOnce(telegramError(400, 'Bad Request: chat not found'));
    await expect(verifyTelegramChat(api, BOT_ID, GROUP)).resolves.toEqual({
      ok: false,
      reason: 'NOT_FOUND',
      detail: 'Bad Request: chat not found',
      chatId: GROUP,
      migratedFrom: null,
    });
  });

  it('separates a bot that is not in the group from one that is in it but not an administrator', async () => {
    getChatMember.mockResolvedValueOnce({ status: 'left', user: { id: BOT_ID } });
    await expect(verifyTelegramChat(api, BOT_ID, GROUP)).resolves.toMatchObject({ reason: 'BOT_NOT_MEMBER' });

    getChatMember.mockRejectedValueOnce(telegramError(400, 'Bad Request: member not found'));
    await expect(verifyTelegramChat(api, BOT_ID, GROUP)).resolves.toMatchObject({
      reason: 'BOT_NOT_MEMBER',
      detail: 'Bad Request: member not found',
    });

    getChat.mockRejectedValueOnce(telegramError(403, 'Forbidden: bot is not a member of the supergroup chat'));
    await expect(verifyTelegramChat(api, BOT_ID, GROUP)).resolves.toMatchObject({ reason: 'BOT_NOT_MEMBER' });

    getChatMember.mockResolvedValueOnce({ status: 'member', user: { id: BOT_ID } });
    await expect(verifyTelegramChat(api, BOT_ID, GROUP)).resolves.toMatchObject({ reason: 'BOT_NOT_ADMIN' });
  });

  it('follows a group that became a supergroup once, and reports both ids', async () => {
    getChat
      .mockRejectedValueOnce(
        telegramError(400, 'Bad Request: group chat was upgraded to a supergroup chat', {
          migrate_to_chat_id: Number(SUPERGROUP),
        }),
      )
      .mockResolvedValueOnce({ id: Number(SUPERGROUP), type: 'supergroup', title: 'Staff' });

    const verification = await verifyTelegramChat(api, BOT_ID, GROUP);

    expect(verification).toMatchObject({ ok: true, migratedFrom: GROUP, chat: { chatId: SUPERGROUP } });
    expect(getChatMember).toHaveBeenCalledWith(SUPERGROUP.toString(), BOT_ID);
  });

  it('throws what says nothing about the chat: an outage, a flood wait, a revoked token', async () => {
    getChat.mockRejectedValueOnce(new HttpError('Network request failed', new Error('offline')));
    await expect(verifyTelegramChat(api, BOT_ID, GROUP)).rejects.toBeInstanceOf(HttpError);

    getChat.mockRejectedValueOnce(telegramError(502, 'Bad Gateway'));
    await expect(verifyTelegramChat(api, BOT_ID, GROUP)).rejects.toBeInstanceOf(GrammyError);

    getChat.mockRejectedValueOnce(telegramError(401, 'Unauthorized'));
    await expect(verifyTelegramChat(api, BOT_ID, GROUP)).rejects.toBeInstanceOf(GrammyError);
  });
});
