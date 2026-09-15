/**
 * The Telegram CLI, per operator: who a command may target, and that each operator's bot is pointed
 * at that operator's own URL, secret and chats, with nothing deployment-wide taking part.
 */
import { Logger } from '@nestjs/common';

import { type AppConfigService } from '../../config/config.service';
import { type PrismaService } from '../../prisma/prisma.service';
import { TenantSecretService } from '../../tenant/services/tenant-secret.service';
import { getEffectiveTenantId } from '../../tenant/tenant.storage';
import { TENANT_ZERO_ID } from '../../tenant/tenant.constants';
import { type BotService } from '../services/bot.service';
import { TELEGRAM_ALLOWED_UPDATES } from '../telegram.constants';
import { SetupBotCommand } from './setup-bot.command';
import { SetWebhookCommand } from './set-webhook.command';
import { TENANT_TARGET_USAGE, type TenantTarget, resolveTenantTargets } from './tenant-targets';

const secrets = new TenantSecretService('cli-spec-root-secret-0123456789abcdef');

const ALPHA: TenantTarget = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'alpha',
  status: 'ACTIVE',
  webhookPathToken: 'alpha_path_token_0123456789',
  webhookSecretEnc: secrets.sealWebhookSecret('alpha_secret_0123456789abcdef'),
  adminChatId: -1001111111111n,
};

const BETA: TenantTarget = {
  id: '22222222-2222-4222-8222-222222222222',
  slug: 'beta',
  status: 'ACTIVE',
  webhookPathToken: 'beta_path_token_0123456789ab',
  webhookSecretEnc: secrets.sealWebhookSecret('beta_secret_0123456789abcdefgh'),
  adminChatId: 0n,
};

/** A migrated legacy operator: never given a webhook. */
const LEGACY: TenantTarget = {
  id: '00000000-0000-0000-0000-000000000001',
  slug: 'default',
  status: 'SUSPENDED',
  webhookPathToken: null,
  webhookSecretEnc: null,
  adminChatId: 0n,
};

function prismaWith(
  rows: TenantTarget[],
  admins: unknown[] = [],
): {
  prisma: PrismaService;
  findMany: jest.Mock;
  adminFindMany: jest.Mock;
} {
  const findMany = jest.fn().mockResolvedValue(rows.filter((row) => row.status === 'ACTIVE'));
  const adminFindMany = jest.fn().mockResolvedValue(admins);
  const findUnique = jest.fn((args: { where: { slug: string } }) =>
    Promise.resolve(rows.find((row) => row.slug === args.where.slug) ?? null),
  );
  return {
    prisma: {
      tenant: { findMany, findUnique },
      adminUser: { findMany: adminFindMany },
    } as unknown as PrismaService,
    findMany,
    adminFindMany,
  };
}

let errorSpy: jest.SpyInstance;
/** Everything logged at log and warn level, as one string. */
let printedLines: () => string;

beforeEach(() => {
  const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  printedLines = () => JSON.stringify([logSpy.mock.calls, warnSpy.mock.calls]);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('resolveTenantTargets', () => {
  it('refuses a command that names no target, or both kinds', async () => {
    const { prisma } = prismaWith([ALPHA]);
    await expect(resolveTenantTargets(prisma, {})).rejects.toThrow(TENANT_TARGET_USAGE);
    await expect(resolveTenantTargets(prisma, { tenant: '  ' })).rejects.toThrow(
      TENANT_TARGET_USAGE,
    );
    await expect(
      resolveTenantTargets(prisma, { tenant: 'alpha', allActive: true }),
    ).rejects.toThrow(TENANT_TARGET_USAGE);
  });

  it('finds one operator by slug, in any status', async () => {
    const { prisma } = prismaWith([ALPHA, LEGACY]);
    await expect(resolveTenantTargets(prisma, { tenant: 'default' })).resolves.toEqual([LEGACY]);
  });

  it('refuses an unknown slug and tenant zero', async () => {
    const platform: TenantTarget = {
      ...LEGACY,
      id: TENANT_ZERO_ID,
      slug: 'platform',
      status: 'ACTIVE',
    };
    const { prisma } = prismaWith([platform]);
    await expect(resolveTenantTargets(prisma, { tenant: 'nope' })).rejects.toThrow(/no operator/);
    await expect(resolveTenantTargets(prisma, { tenant: 'platform' })).rejects.toThrow(
      /tenant zero/,
    );
  });

  it('lists ACTIVE operators, never tenant zero', async () => {
    const { prisma, findMany } = prismaWith([ALPHA, BETA, LEGACY]);
    await expect(resolveTenantTargets(prisma, { allActive: true })).resolves.toEqual([ALPHA, BETA]);
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { status: 'ACTIVE', id: { not: TENANT_ZERO_ID } },
      orderBy: { slug: 'asc' },
    });
  });
});

describe('webhook:set', () => {
  function build(
    rows: TenantTarget[],
    baseUrl = 'https://api.example.com',
  ): {
    command: SetWebhookCommand;
    setWebhook: jest.Mock;
    getWebhookInfo: jest.Mock;
  } {
    const setWebhook = jest.fn().mockResolvedValue(true);
    const getWebhookInfo = jest.fn().mockResolvedValue({ url: '', pending_update_count: 0 });
    const command = new SetWebhookCommand(
      { app: { baseUrl } } as unknown as AppConfigService,
      prismaWith(rows).prisma,
      secrets,
      { setWebhook, getWebhookInfo } as unknown as BotService,
    );
    return { command, setWebhook, getWebhookInfo };
  }

  it('registers an operator’s own URL and secret through its own bot', async () => {
    const { command, setWebhook } = build([ALPHA]);

    await command.run([], { tenant: 'alpha', dropPending: true });

    expect(setWebhook).toHaveBeenCalledWith(
      ALPHA.id,
      'https://api.example.com/telegram/webhook/alpha_path_token_0123456789',
      'alpha_secret_0123456789abcdef',
      TELEGRAM_ALLOWED_UPDATES,
      true,
    );
  });

  it('re-registers every ACTIVE operator, each with its own credentials', async () => {
    const { command, setWebhook } = build([ALPHA, BETA, LEGACY]);

    await command.run([], { allActive: true });

    expect(
      (setWebhook.mock.calls as unknown[][]).map((call) => [call[0], call[1], call[2]]),
    ).toEqual([
      [
        ALPHA.id,
        'https://api.example.com/telegram/webhook/alpha_path_token_0123456789',
        'alpha_secret_0123456789abcdef',
      ],
      [
        BETA.id,
        'https://api.example.com/telegram/webhook/beta_path_token_0123456789ab',
        'beta_secret_0123456789abcdefgh',
      ],
    ]);
  });

  it('carries on past an operator that cannot be registered, then fails naming it', async () => {
    const { command, setWebhook } = build([ALPHA, BETA]);
    setWebhook.mockImplementation((tenantId: string) =>
      tenantId === ALPHA.id
        ? Promise.reject(new Error('bot token revoked'))
        : Promise.resolve(true),
    );

    await expect(command.run([], { allActive: true })).rejects.toThrow(
      /1 of 2 operator\(s\): alpha/,
    );
    expect(setWebhook).toHaveBeenCalledWith(
      BETA.id,
      expect.any(String),
      expect.any(String),
      expect.any(Array),
      false,
    );
  });

  it('refuses an operator that was never given a webhook path token, and generates nothing', async () => {
    const { command, setWebhook } = build([LEGACY]);

    await expect(command.run([], { tenant: 'default' })).rejects.toThrow(/default/);
    expect(setWebhook).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('no webhook path token'));
  });

  it('refuses a non-https public URL, which Telegram would never deliver to', async () => {
    const { command, setWebhook } = build([ALPHA], 'http://localhost:3000');

    await expect(command.run([], { tenant: 'alpha' })).rejects.toThrow(/alpha/);
    expect(setWebhook).not.toHaveBeenCalled();
  });

  it('--info reads the registration and changes nothing', async () => {
    const { command, setWebhook, getWebhookInfo } = build([ALPHA]);

    await command.run([], { tenant: 'alpha', info: true });

    expect(getWebhookInfo).toHaveBeenCalledWith(ALPHA.id);
    expect(setWebhook).not.toHaveBeenCalled();
  });

  it('never prints a path token or a secret', async () => {
    const { command } = build([ALPHA]);

    await command.run([], { tenant: 'alpha' });

    const printed = printedLines();
    expect(printed).not.toContain('alpha_path_token_0123456789');
    expect(printed).not.toContain('alpha_secret_0123456789abcdef');
  });

  it('succeeds doing nothing when no operator is ACTIVE', async () => {
    const { command, setWebhook } = build([LEGACY]);

    await expect(command.run([], { allActive: true })).resolves.toBeUndefined();
    expect(setWebhook).not.toHaveBeenCalled();
  });
});

describe('bot:setup', () => {
  function build(
    rows: TenantTarget[],
    admins: unknown[] = [],
  ): {
    command: SetupBotCommand;
    api: {
      setMyCommands: jest.Mock;
      setMyDescription: jest.Mock;
      setMyShortDescription: jest.Mock;
      setChatMenuButton: jest.Mock;
    };
    forTenant: jest.Mock;
    adminFindMany: jest.Mock;
    contexts: Array<string | undefined>;
  } {
    const api = {
      setMyCommands: jest.fn().mockResolvedValue(true),
      setMyDescription: jest.fn().mockResolvedValue(true),
      setMyShortDescription: jest.fn().mockResolvedValue(true),
      setChatMenuButton: jest.fn().mockResolvedValue(true),
    };
    const forTenant = jest.fn().mockResolvedValue({ api });
    const { prisma, adminFindMany } = prismaWith(rows, admins);
    const contexts: Array<string | undefined> = [];
    adminFindMany.mockImplementation(() => {
      contexts.push(getEffectiveTenantId());
      return Promise.resolve(admins);
    });
    const command = new SetupBotCommand(prisma, { forTenant } as unknown as BotService);
    return { command, api, forTenant, adminFindMany, contexts };
  }

  it('pushes menus through the operator’s own bot, scoped to its own admin group and staff', async () => {
    const h = build([ALPHA], [{ telegramUserId: 777n, displayName: 'Rana' }]);

    await h.command.run([], { tenant: 'alpha' });

    expect(h.forTenant).toHaveBeenCalledWith(ALPHA.id);
    expect(h.adminFindMany.mock.calls[0]?.[0]).toMatchObject({
      where: { tenantId: ALPHA.id, isActive: true },
    });
    expect(h.contexts).toEqual([ALPHA.id]);
    const scopes = h.api.setMyCommands.mock.calls.map(
      (call) => (call[1] as { scope: unknown }).scope,
    );
    expect(scopes).toEqual([
      { type: 'default' },
      { type: 'chat', chat_id: ALPHA.adminChatId.toString() },
      { type: 'chat', chat_id: '777' },
    ]);
    expect(h.api.setChatMenuButton).toHaveBeenCalledTimes(1);
  });

  it('skips the admin group menu for an operator with no admin chat set', async () => {
    const h = build([BETA]);

    await h.command.run([], { tenant: 'beta' });

    const scopes = h.api.setMyCommands.mock.calls.map(
      (call) => (call[1] as { scope: unknown }).scope,
    );
    expect(scopes).toEqual([{ type: 'default' }]);
  });

  it('fails naming the operator whose bot cannot be used, after trying the others', async () => {
    const h = build([ALPHA, BETA]);
    h.forTenant.mockImplementation((tenantId: string) =>
      tenantId === ALPHA.id
        ? Promise.reject(new Error('Telegram rejected the bot token of tenant alpha'))
        : Promise.resolve({ api: h.api }),
    );

    await expect(h.command.run([], { allActive: true })).rejects.toThrow(
      /1 of 2 operator\(s\): alpha/,
    );
    expect(h.api.setMyDescription).toHaveBeenCalledTimes(1);
  });
});
