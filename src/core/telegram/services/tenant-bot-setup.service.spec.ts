import type { PrismaService } from '../../prisma/prisma.service';
import { getEffectiveTenantId } from '../../tenant/tenant.storage';
import {
  TenantBotErrorCodes,
  TenantBotUnavailableError,
} from '../tenant-bot.errors';
import type { TenantBotRegistry } from './tenant-bot-registry.service';
import {
  ADMIN_EXTRA_COMMANDS,
  PLAYER_COMMANDS,
  TenantBotSetupService,
} from './tenant-bot-setup.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function harness(adminChatId: bigint, admins: { telegramUserId: bigint | null }[] = []) {
  const api = {
    setMyCommands: jest.fn().mockResolvedValue(true),
    setMyDescription: jest.fn().mockResolvedValue(true),
    setMyShortDescription: jest.fn().mockResolvedValue(true),
    setChatMenuButton: jest.fn().mockResolvedValue(true),
  };
  const bots = { get: jest.fn().mockResolvedValue({ api }) };
  const contexts: (string | undefined)[] = [];
  const prisma = {
    tenant: { findUnique: jest.fn().mockResolvedValue({ adminChatId }) },
    adminUser: {
      findMany: jest.fn((_args: { where: Record<string, unknown> }) => {
        contexts.push(getEffectiveTenantId());
        return Promise.resolve(admins);
      }),
    },
  };
  const service = new TenantBotSetupService(
    bots as unknown as TenantBotRegistry,
    prisma as unknown as PrismaService,
  );
  const scopes = (): unknown[] =>
    api.setMyCommands.mock.calls.map((call) => (call[1] as { scope: unknown }).scope);
  return { service, api, bots, prisma, contexts, scopes };
}

describe('TenantBotSetupService', () => {
  it('pushes the player menu to default and all_private_chats, and the admin menu to a private admin chat', async () => {
    const h = harness(912_911_246n);

    const result = await h.service.pushMenus(TENANT_ID);

    expect(h.bots.get).toHaveBeenCalledWith(TENANT_ID);
    expect(h.scopes()).toEqual([
      { type: 'default' },
      { type: 'all_private_chats' },
      { type: 'chat', chat_id: '912911246' },
    ]);
    expect(result).toEqual({
      commandsSet: PLAYER_COMMANDS.length + ADMIN_EXTRA_COMMANDS.length,
      scopes: ['default', 'all_private_chats', 'chat'],
      fatalError: null,
      warnings: [],
    });
  });

  it('uses chat_administrators for an admin group, and pushes each admin once, inside the operator', async () => {
    const h = harness(-1001234567890n, [
      { telegramUserId: 777n },
      { telegramUserId: 777n },
      { telegramUserId: null },
    ]);

    const result = await h.service.pushMenus(TENANT_ID);

    expect(h.scopes()).toEqual([
      { type: 'default' },
      { type: 'all_private_chats' },
      { type: 'chat_administrators', chat_id: '-1001234567890' },
      { type: 'chat', chat_id: '777' },
    ]);
    expect(result.scopes).toEqual(['default', 'all_private_chats', 'chat_administrators', 'chat']);
    expect(h.contexts).toEqual([TENANT_ID]);
    expect(h.prisma.adminUser.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { tenantId: TENANT_ID, isActive: true },
    });
  });

  it('pushes only the player menus when no admin chat is set', async () => {
    const h = harness(0n);
    const result = await h.service.pushMenus(TENANT_ID);
    expect(result).toMatchObject({ commandsSet: PLAYER_COMMANDS.length, scopes: ['default', 'all_private_chats'] });
  });

  it('fails the push when a player menu is refused, but only warns for a chat or a cosmetic call', async () => {
    const warned = harness(912_911_246n);
    warned.api.setMyCommands.mockImplementation((_menu: unknown, options: { scope: { type: string } }) =>
      options.scope.type === 'chat'
        ? Promise.reject(new Error('Bad Request: chat not found'))
        : Promise.resolve(true),
    );
    warned.api.setChatMenuButton.mockRejectedValue(new Error('Too Many Requests'));
    const soft = await warned.service.pushMenus(TENANT_ID);
    expect(soft.fatalError).toBeNull();
    expect(soft.scopes).toEqual(['default', 'all_private_chats']);
    expect(soft.warnings).toHaveLength(2);

    const refused = harness(0n);
    refused.api.setMyCommands.mockRejectedValueOnce(new Error('Bad Request: BOT_COMMANDS_TOO_MUCH'));
    const hard = await refused.service.pushMenus(TENANT_ID);
    expect(hard.fatalError).toBe(
      'setMyCommands for scope default failed: Bad Request: BOT_COMMANDS_TOO_MUCH',
    );
    expect(hard.scopes).toEqual(['all_private_chats']);
  });

  it('answers an operator with no working bot without calling anything', async () => {
    const h = harness(0n);
    h.bots.get.mockRejectedValue(
      new TenantBotUnavailableError(
        TenantBotErrorCodes.TENANT_BOT_UNCONFIGURED,
        TENANT_ID,
        false,
        `The bot token of tenant ${TENANT_ID} has not been set; set it from the dashboard`,
      ),
    );

    expect(await h.service.pushMenus(TENANT_ID)).toEqual({
      commandsSet: 0,
      scopes: [],
      fatalError: `The bot token of tenant ${TENANT_ID} has not been set; set it from the dashboard`,
      warnings: [],
    });
    expect(h.api.setMyCommands).not.toHaveBeenCalled();
  });
});
