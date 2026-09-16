/**
 * TenantBotRegistry.identifyToken against the offline Telegram: a token that is not stored anywhere
 * yet is checked through the registry's own client, and nothing is built or cached for it.
 */
import { createFakeTelegram, testBotInfo } from '../../../../test/setup/telegram-fixtures';
import type { CacheService } from '../../cache/cache.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { TenantSecretService } from '../../tenant/services/tenant-secret.service';
import type { TelegramHandlerRegistrar } from './handler-registrar.service';
import { TenantBotRegistry } from './tenant-bot-registry.service';

const ACCEPTED = '111222333:AAacceptedTokenForIdentifySpec0123456';
const UNKNOWN = '444555666:AAunknownTokenForIdentifySpec01234567';
const DOWN = '777888999:AAunreachableTokenForIdentifySpec0123';

describe('TenantBotRegistry.identifyToken', () => {
  const telegram = createFakeTelegram();
  telegram.accept(ACCEPTED, testBotInfo(111222333, 'accepted_bot'));
  telegram.makeUnreachable(DOWN);

  // No collaborator is touched: a rejected or accepted token leaves no trace in the database or Redis.
  const untouchable = new Proxy(
    {},
    {
      get: () => {
        throw new Error('identifyToken must not touch the database, Redis or the secret service');
      },
    },
  );
  const registry = new TenantBotRegistry(
    untouchable as PrismaService,
    untouchable as CacheService,
    untouchable as TenantSecretService,
    untouchable as TelegramHandlerRegistrar,
    telegram.clientOptions,
  );

  it('answers the bot identity for a token Telegram accepts', async () => {
    await expect(registry.identifyToken(ACCEPTED)).resolves.toEqual({
      ok: true,
      botInfo: expect.objectContaining({ id: 111222333, username: 'accepted_bot' }),
    });
  });

  it('separates a token Telegram rejects from a Telegram that cannot be asked, naming no token', async () => {
    const rejected = await registry.identifyToken(UNKNOWN);
    expect(rejected).toEqual({ ok: false, rejected: true, reason: 'Telegram answered 401: Unauthorized' });

    const unreachable = await registry.identifyToken(DOWN);
    expect(unreachable).toMatchObject({ ok: false, rejected: false });
    expect(JSON.stringify(unreachable)).not.toContain(DOWN.split(':')[1]);
  });

  it('refuses a value that is not token-shaped without calling Telegram', async () => {
    const before = telegram.calls.length;
    await expect(registry.identifyToken('not a token')).resolves.toMatchObject({
      ok: false,
      rejected: true,
    });
    expect(telegram.calls.length).toBe(before);
  });
});
