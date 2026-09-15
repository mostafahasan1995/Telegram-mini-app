/**
 * What the chat projection tells the update processor, without a database. `consumed` is the one
 * answer a mistake in would not show anywhere else: a bind command that is not consumed reaches grammY
 * for an ACTIVE operator, whose player /start handler registers whoever added the bot as a player.
 * So every kind of update the projection owns is pinned here, with who it calls and what it answers.
 */
import type { Message, Update } from 'grammy/types';

import type { PrismaService } from '@core/prisma/prisma.service';

import type { TelegramChatDiscoveryService } from '../services/telegram-chat-discovery.service';
import type { TelegramChatMigrationService } from '../services/telegram-chat-migration.service';
import { hashBindNonce } from '../utils/chat-membership.util';

import type { ChatBindingService } from './chat-binding.service';
import { TelegramChatProjectionService } from './chat-projection.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const NONCE = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const GROUP = { id: -1001234567890, type: 'supergroup', title: 'Staff' };

const groupMessage = (fields: Record<string, unknown>): Update =>
  ({
    update_id: 1,
    message: { message_id: 1, date: 1_700_000_000, chat: GROUP, ...fields },
  }) as unknown as Update;

function build(botUsername: string | null = 'cashier_bot') {
  const findUnique = jest.fn().mockResolvedValue({ botUsername, adminChatId: 0n, feedChatId: null });
  const record = jest.fn().mockResolvedValue(undefined);
  const migrate = jest.fn().mockResolvedValue(undefined);
  const bindFromStartGroup = jest.fn().mockResolvedValue('bound');
  const projection = new TelegramChatProjectionService(
    { tenant: { findUnique } } as unknown as PrismaService,
    { record } as unknown as TelegramChatDiscoveryService,
    { migrate } as unknown as TelegramChatMigrationService,
    { bindFromStartGroup } as unknown as ChatBindingService,
  );
  return { projection, record, migrate, bindFromStartGroup };
}

describe('TelegramChatProjectionService.project', () => {
  it.each([
    ['names this bot', `/start@cashier_bot ${NONCE}`],
    ['names this bot in another case', `/start@Cashier_Bot ${NONCE}`],
    ['names no bot', `/start ${NONCE}`],
    ['is the redacted form the webhook stores', `/start@cashier_bot sha256:${hashBindNonce(NONCE)}`],
  ])('consumes a bind command that %s, and binds by the hash', async (_label, text) => {
    const h = build();
    const update = groupMessage({ text });

    await expect(h.projection.project(TENANT_ID, update)).resolves.toEqual({
      relevant: true,
      consumed: true,
    });
    expect(h.bindFromStartGroup).toHaveBeenCalledWith(
      TENANT_ID,
      update.message as Message,
      hashBindNonce(NONCE),
    );
  });

  it('neither consumes nor binds a bind command naming another bot: it is somebody else’s', async () => {
    const h = build();

    await expect(
      h.projection.project(TENANT_ID, groupMessage({ text: `/start@some_other_bot ${NONCE}` })),
    ).resolves.toEqual({ relevant: false, consumed: false });
    expect(h.bindFromStartGroup).not.toHaveBeenCalled();
  });

  it('does not consume a named bind command when the operator’s bot username is unknown', async () => {
    const h = build(null);

    await expect(
      h.projection.project(TENANT_ID, groupMessage({ text: `/start@cashier_bot ${NONCE}` })),
    ).resolves.toEqual({ relevant: false, consumed: false });
    expect(h.bindFromStartGroup).not.toHaveBeenCalled();
  });

  it('records the bot’s membership in a group without consuming it', async () => {
    const h = build();
    const update = {
      update_id: 2,
      my_chat_member: {
        chat: GROUP,
        from: { id: 42, is_bot: false, first_name: 'Owner' },
        date: 1_700_000_000,
        old_chat_member: { status: 'left', user: { id: 1, is_bot: true, first_name: 'Bot' } },
        new_chat_member: { status: 'administrator', user: { id: 1, is_bot: true, first_name: 'Bot' } },
      },
    } as unknown as Update;

    await expect(h.projection.project(TENANT_ID, update)).resolves.toEqual({
      relevant: true,
      consumed: false,
    });
    expect(h.record).toHaveBeenCalledWith(TENANT_ID, update.my_chat_member);
  });

  it('moves the ids on either half of a supergroup migration without consuming it', async () => {
    const h = build();

    await expect(
      h.projection.project(TENANT_ID, groupMessage({ chat: { ...GROUP, type: 'group', id: -55 }, migrate_to_chat_id: -1009 })),
    ).resolves.toEqual({ relevant: true, consumed: false });
    await expect(
      h.projection.project(TENANT_ID, groupMessage({ migrate_from_chat_id: -55 })),
    ).resolves.toEqual({ relevant: true, consumed: false });

    expect(h.migrate.mock.calls).toEqual([
      [TENANT_ID, -55n, -1009n, 'service_message'],
      [TENANT_ID, -55n, BigInt(GROUP.id), 'service_message'],
    ]);
  });

  it('leaves everything else alone: a plain message, a referral /start, a private bind', async () => {
    const h = build();

    for (const update of [
      groupMessage({ text: 'hello' }),
      groupMessage({ text: '/start ref_12345' }),
      groupMessage({ chat: { id: 42, type: 'private', first_name: 'P' }, text: `/start ${NONCE}` }),
    ]) {
      await expect(h.projection.project(TENANT_ID, update)).resolves.toEqual({
        relevant: false,
        consumed: false,
      });
    }
    expect(h.bindFromStartGroup).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
    expect(h.migrate).not.toHaveBeenCalled();
  });
});
