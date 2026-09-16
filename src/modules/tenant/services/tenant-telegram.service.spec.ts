/**
 * TenantTelegramService with every collaborator faked except TenantSecretService, which is real so
 * the sealed values it writes are proven to open. What these cases pin down:
 *  - Telegram refusing the webhook URL (the laptop case) is a boolean and a sentence for provisioning
 *    and a 422 for the route, never a raw grammY error;
 *  - a non-https API_BASE_URL is refused before any Telegram call;
 *  - a legacy row gets BOTH a path token and a sealed secret, conditionally, audited, route cache evicted;
 *  - replacing the bot runs its steps in the order that keeps the old token from coming back.
 */
import { GrammyError } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';

import { AppException } from '@common/exceptions/app.exception';
import type { AuditWriteInput } from '@core/audit/audit.types';
import type { AuditService } from '@core/audit/audit.service';
import type { InitDataService } from '@core/auth/services/init-data.service';
import type { AppConfigService } from '@core/config/config.service';
import { UniqueConstraintError } from '@core/prisma/prisma-errors';
import type { PrismaService } from '@core/prisma/prisma.service';
import type {
  TenantBotRegistry,
  TokenIdentity,
} from '@core/telegram/services/tenant-bot-registry.service';
import type { TenantBotSetupService } from '@core/telegram/services/tenant-bot-setup.service';
import { TELEGRAM_ALLOWED_UPDATES } from '@core/telegram/telegram.constants';
import type { TenantRegistryService } from '@core/tenant/services/tenant-registry.service';
import { TenantSecretService } from '@core/tenant/services/tenant-secret.service';
import { TENANT_ZERO_ID } from '@core/tenant/tenant.constants';
import { getEffectiveTenantId } from '@core/tenant/tenant.storage';

import { TenantTelegramService } from './tenant-telegram.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000010';
const BASE_URL = 'https://api.example.app';
const NEW_TOKEN = '987654321:ZZyyxxwwvvuuttssrrqqppoonnmmllkkjj';

const secrets = new TenantSecretService('p10-unit-root-secret-0123456789abcdef');

const botInfo = (username: string): UserFromGetMe =>
  ({ id: 987654321, is_bot: true, first_name: username, username }) as UserFromGetMe;

interface Row {
  id: string;
  botUsername: string | null;
  webhookPathToken: string | null;
  webhookSecretEnc: string | null;
}

function harness(options: { row?: Row | null; baseUrl?: string } = {}) {
  const row: Row | null =
    options.row === undefined
      ? {
          id: TENANT_ID,
          botUsername: 'old_bot',
          webhookPathToken: 'existingPathToken0123456789abcdefghijklmnopq',
          webhookSecretEnc: secrets.sealWebhookSecret('existing-secret-0123456789abcdef'),
        }
      : options.row;

  /** Every step, in order, so the replace sequence can be asserted as a sequence. */
  const steps: string[] = [];

  const api = {
    setWebhook: jest.fn().mockResolvedValue(true),
    deleteWebhook: jest.fn(() => {
      steps.push('deleteWebhook');
      return Promise.resolve(true);
    }),
    getWebhookInfo: jest.fn().mockResolvedValue({
      url: '',
      has_custom_certificate: false,
      pending_update_count: 0,
    }),
  };
  const bots = {
    get: jest.fn(() => {
      steps.push('bots.get');
      return Promise.resolve({ api, botInfo: botInfo('old_bot') });
    }),
    identifyToken: jest.fn(
      (): Promise<TokenIdentity> => Promise.resolve({ ok: true, botInfo: botInfo('new_bot') }),
    ),
    invalidate: jest.fn(() => {
      steps.push('bots.invalidate');
      return Promise.resolve();
    }),
  };

  const tx = {
    tenant: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn(() => {
        steps.push('tenant.update');
        return Promise.resolve({ id: TENANT_ID });
      }),
    },
  };
  const prisma = {
    tenant: {
      findUnique: jest.fn().mockResolvedValue(row),
      // No other operator holds the bot unless a test says so.
      findFirst: jest.fn((): Promise<{ id: string } | null> => Promise.resolve(null)),
      findMany: jest.fn(
        (): Promise<{ id: string; botTokenEnc: string }[]> => Promise.resolve([]),
      ),
    },
    runInTransaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  const audits: { input: AuditWriteInput; tenantId: string | undefined }[] = [];
  const audit = {
    write: jest.fn((_tx: unknown, input: AuditWriteInput) => {
      audits.push({ input, tenantId: getEffectiveTenantId() });
      return Promise.resolve('audit-id');
    }),
  };
  const registry = {
    invalidate: jest.fn(() => {
      steps.push('registry.invalidate');
      return Promise.resolve();
    }),
    invalidateWebhookPathToken: jest.fn(() => {
      steps.push('registry.invalidateWebhookPathToken');
      return Promise.resolve();
    }),
  };
  const initData = {
    invalidate: jest.fn(() => {
      steps.push('initData.invalidate');
    }),
  };
  const setup = { pushMenus: jest.fn() };
  const config = { app: { baseUrl: options.baseUrl ?? BASE_URL } };

  const service = new TenantTelegramService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    config as unknown as AppConfigService,
    registry as unknown as TenantRegistryService,
    secrets,
    bots as unknown as TenantBotRegistry,
    setup as unknown as TenantBotSetupService,
    initData as unknown as InitDataService,
  );
  return { service, api, bots, tx, prisma, audits, registry, initData, setup, steps };
}

const refusal = (description: string): GrammyError =>
  new GrammyError(
    `Call to 'setWebhook' failed! (400: ${description})`,
    { ok: false, error_code: 400, description },
    'setWebhook',
    {},
  );

async function caught(promise: Promise<unknown>): Promise<AppException> {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(outcome instanceof AppException)) throw new Error(`expected a contract error, got ${String(outcome)}`);
  return outcome;
}

describe('TenantTelegramService', () => {
  describe('registering the webhook', () => {
    it('sends this deployment’s URL, the operator’s own secret and the update types the ingress handles', async () => {
      const h = harness();

      const outcome = await h.service.registerWebhookForProvisioning(ACTOR_ID, TENANT_ID);

      expect(outcome).toEqual({
        ok: true,
        url: `${BASE_URL}/telegram/webhook/[REDACTED]`,
        error: null,
      });
      expect(h.api.setWebhook).toHaveBeenCalledWith(
        `${BASE_URL}/telegram/webhook/existingPathToken0123456789abcdefghijklmnopq`,
        { secret_token: 'existing-secret-0123456789abcdef', allowed_updates: [...TELEGRAM_ALLOWED_UPDATES] },
      );
      // Credentials already usable: nothing generated, nothing written but the audit.
      expect(h.tx.tenant.updateMany).not.toHaveBeenCalled();
      expect(h.audits.map((entry) => [entry.input.action, entry.tenantId])).toEqual([
        ['tenant.webhook.registered', TENANT_ID],
      ]);
      expect(JSON.stringify(h.audits)).not.toContain('existingPathToken');
    });

    it('reports a URL Telegram refuses as a boolean and Telegram’s sentence, and as a 422 on the route', async () => {
      const h = harness();
      h.api.setWebhook.mockRejectedValue(
        refusal('Bad Request: bad webhook: Failed to resolve host: Name or service not known'),
      );

      const outcome = await h.service.registerWebhookForProvisioning(ACTOR_ID, TENANT_ID);
      expect(outcome).toEqual({
        ok: false,
        url: null,
        error:
          'Telegram refused to register the webhook: Bad Request: bad webhook: Failed to resolve ' +
          'host: Name or service not known',
      });

      const error = await caught(h.service.registerWebhook(ACTOR_ID, TENANT_ID));
      expect([error.httpStatus, error.errorCode]).toEqual([422, 'TENANT_TELEGRAM_REJECTED']);
      expect(h.audits).toHaveLength(0);
    });

    it('refuses a non-https API_BASE_URL before asking Telegram anything', async () => {
      const h = harness({ baseUrl: 'http://localhost:3000' });

      const error = await caught(h.service.registerWebhook(ACTOR_ID, TENANT_ID));

      expect([error.httpStatus, error.errorCode]).toEqual([422, 'TENANT_WEBHOOK_URL_NOT_HTTPS']);
      expect(h.bots.get).not.toHaveBeenCalled();
      expect(h.api.setWebhook).not.toHaveBeenCalled();
    });

    it('generates BOTH a path token and a sealed secret for a legacy row, conditionally, and evicts the route cache', async () => {
      const h = harness({
        row: { id: TENANT_ID, botUsername: null, webhookPathToken: null, webhookSecretEnc: null },
      });

      await h.service.registerWebhook(ACTOR_ID, TENANT_ID);

      const call = h.tx.tenant.updateMany.mock.calls[0] as [
        { where: Record<string, unknown>; data: { webhookPathToken: string; webhookSecretEnc: string } },
      ];
      const { where, data } = call[0];
      expect(where).toEqual({ id: TENANT_ID, webhookPathToken: null, webhookSecretEnc: null });
      expect(data.webhookPathToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const secret = secrets.openWebhookSecret({ id: TENANT_ID, webhookSecretEnc: data.webhookSecretEnc });
      expect(secret).toMatch(/^[A-Za-z0-9_-]{32}$/);

      expect(h.api.setWebhook).toHaveBeenCalledWith(
        `${BASE_URL}/telegram/webhook/${data.webhookPathToken}`,
        expect.objectContaining({ secret_token: secret }),
      );
      expect(h.registry.invalidateWebhookPathToken).toHaveBeenCalledWith(data.webhookPathToken);
      expect(h.audits.map((entry) => entry.input.action)).toEqual([
        'tenant.webhook.credentialsGenerated',
        'tenant.webhook.registered',
      ]);
      expect(JSON.stringify(h.audits)).not.toContain(data.webhookPathToken);
      expect(JSON.stringify(h.audits)).not.toContain(secret);
    });

    it('refuses with 409 when the row changed under a credential generation, and registers nothing', async () => {
      const h = harness({
        row: { id: TENANT_ID, botUsername: null, webhookPathToken: null, webhookSecretEnc: null },
      });
      h.tx.tenant.updateMany.mockResolvedValue({ count: 0 });

      const error = await caught(h.service.registerWebhook(ACTOR_ID, TENANT_ID));

      expect([error.httpStatus, error.errorCode]).toEqual([409, 'WRITE_CONFLICT']);
      expect(h.api.setWebhook).not.toHaveBeenCalled();
    });
  });

  describe('replacing the bot', () => {
    it('refuses a token Telegram does not accept as a 400 naming botToken, and changes nothing', async () => {
      const h = harness();
      h.bots.identifyToken.mockResolvedValue({
        ok: false,
        rejected: true,
        reason: 'Telegram answered 401: Unauthorized',
      });

      const error = await caught(h.service.replaceBot(ACTOR_ID, TENANT_ID, NEW_TOKEN));

      expect(error.errorCode).toBe('VALIDATION_FAILED');
      expect(error.details).toEqual({
        fields: [expect.stringMatching(/^botToken was not accepted by Telegram \(Telegram answered 401/)],
      });
      expect(JSON.stringify(error.details)).not.toContain(NEW_TOKEN);
      expect(h.steps).toEqual([]);
    });

    it('clears the old webhook, stores the sealed token, rotates the secret, evicts every cache, then clears the new bot’s', async () => {
      const h = harness();

      await h.service.replaceBot(ACTOR_ID, TENANT_ID, NEW_TOKEN);

      expect(h.steps).toEqual([
        'bots.get',
        'deleteWebhook',
        'tenant.update',
        'bots.invalidate',
        'initData.invalidate',
        'registry.invalidate',
        'registry.invalidateWebhookPathToken',
        'bots.get',
        'deleteWebhook',
      ]);

      const update = h.tx.tenant.update.mock.calls[0] as unknown as [
        { data: { botTokenEnc: string; botUsername: string; webhookSecretEnc: string } },
      ];
      const { data } = update[0];
      expect(secrets.openBotToken({ id: TENANT_ID, botTokenEnc: data.botTokenEnc })).toBe(NEW_TOKEN);
      expect(data.botUsername).toBe('new_bot');
      expect(secrets.openWebhookSecret({ id: TENANT_ID, webhookSecretEnc: data.webhookSecretEnc })).not.toBe(
        'existing-secret-0123456789abcdef',
      );
      expect(h.registry.invalidateWebhookPathToken).toHaveBeenCalledWith(
        'existingPathToken0123456789abcdefghijklmnopq',
      );

      expect(h.audits).toHaveLength(1);
      expect(h.audits[0]).toMatchObject({
        tenantId: TENANT_ID,
        input: {
          action: 'tenant.bot.replaced',
          before: { botUsername: 'old_bot' },
          after: { botUsername: 'new_bot', botId: '987654321' },
          metadata: { previousWebhookCleared: true, webhookSecretRotated: true },
        },
      });
      expect(JSON.stringify(h.audits)).not.toContain(NEW_TOKEN);
    });

    it('still replaces a bot whose old token no longer works', async () => {
      const h = harness();
      h.bots.get.mockRejectedValueOnce(
        new GrammyError("Call to 'deleteWebhook' failed! (401: Unauthorized)", {
          ok: false,
          error_code: 401,
          description: 'Unauthorized',
        }, 'deleteWebhook', {}),
      );

      await h.service.replaceBot(ACTOR_ID, TENANT_ID, NEW_TOKEN);

      expect(h.tx.tenant.update).toHaveBeenCalledTimes(1);
      expect(h.audits[0]?.input.metadata).toMatchObject({ previousWebhookCleared: false });
    });

    it('refuses a bot another operator holds with 409 naming botToken, before touching any webhook', async () => {
      const h = harness();
      h.prisma.tenant.findFirst.mockResolvedValueOnce({ id: 'other-operator' });

      const error = await caught(h.service.replaceBot(ACTOR_ID, TENANT_ID, NEW_TOKEN));

      expect(error.errorCode).toBe('DUPLICATE_RESOURCE');
      expect(error.details).toEqual({ fields: ['botToken'] });
      expect(JSON.stringify(error)).not.toContain(NEW_TOKEN);
      expect(h.steps).toEqual([]);
      expect(h.api.deleteWebhook).not.toHaveBeenCalled();
      // The operator being edited is excluded: its own regenerated token is not a duplicate.
      expect(h.prisma.tenant.findFirst).toHaveBeenCalledWith({
        where: { botId: 987654321n, NOT: { id: TENANT_ID } },
        select: { id: true },
      });
    });

    it('finds the bot on a row written before bot_id existed by opening its token, skipping placeholders', async () => {
      const h = harness();
      h.prisma.tenant.findMany.mockResolvedValueOnce([
        { id: 'platform', botTokenEnc: 'UNUSED-PLATFORM-TENANT' },
        { id: 'unreadable', botTokenEnc: 'v1.not-a-sealed-value' },
        { id: 'legacy', botTokenEnc: secrets.sealBotToken(NEW_TOKEN) },
      ]);

      const error = await caught(h.service.replaceBot(ACTOR_ID, TENANT_ID, NEW_TOKEN));

      expect(error.errorCode).toBe('DUPLICATE_RESOURCE');
      expect(h.steps).toEqual([]);
    });

    it('turns a lost race on the bot_id index into the same 409', async () => {
      const h = harness();
      h.tx.tenant.update.mockImplementationOnce(() =>
        Promise.reject(
          new UniqueConstraintError(
            { fields: ['bot_id'], constraint: 'tenants_bot_id_key' },
            { model: 'Tenant' },
          ),
        ),
      );

      const error = await caught(h.service.replaceBot(ACTOR_ID, TENANT_ID, NEW_TOKEN));

      expect(error.errorCode).toBe('DUPLICATE_RESOURCE');
      expect(error.details).toEqual({ fields: ['botToken'] });
      expect(h.bots.invalidate).not.toHaveBeenCalled();
    });

    it('stores the bot id from getMe alongside the token', async () => {
      const h = harness();
      await h.service.replaceBot(ACTOR_ID, TENANT_ID, NEW_TOKEN);
      const update = h.tx.tenant.update.mock.calls[0] as unknown as [{ data: { botId: bigint } }];
      expect(update[0].data.botId).toBe(987654321n);
    });

    it('refuses tenant zero, which has no bot', async () => {
      const h = harness();
      const error = await caught(h.service.replaceBot(ACTOR_ID, TENANT_ZERO_ID, NEW_TOKEN));
      expect(error.errorCode).toBe('TENANT_PLATFORM_LOCKED');
      expect(h.bots.identifyToken).not.toHaveBeenCalled();
    });
  });

  describe('bot health', () => {
    it('matches only this deployment’s URL, and turns an unusable bot into ok false with the reason', async () => {
      const h = harness();
      const row = { id: TENANT_ID, botUsername: 'old_bot', webhookPathToken: 'healthPathToken0123456789' };
      h.api.getWebhookInfo.mockResolvedValue({
        url: `${BASE_URL}/telegram/webhook/healthPathToken0123456789`,
        has_custom_certificate: false,
        pending_update_count: 0,
      });

      expect(await h.service.botHealth(row)).toMatchObject({ ok: true, webhookMatches: true });

      h.bots.get.mockRejectedValue(
        new GrammyError('x', { ok: false, error_code: 401, description: 'Unauthorized' }, 'getMe', {}),
      );
      expect(await h.service.botHealth(row)).toMatchObject({
        ok: false,
        username: 'old_bot',
        webhookMatches: false,
        lastErrorMessage: expect.stringContaining('no longer accepts'),
      });
    });
  });
});
