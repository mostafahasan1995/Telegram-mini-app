/**
 * What a supergroup migration moves for a one-time bind link, without a database.
 *
 * A link is pinned to the first chat that presents it (ChatBindingService). Promoting the bot with
 * custom rights in a basic group is one of the ordinary ways that group becomes a supergroup with a new
 * id, and it is exactly what an owner does between a link refused with BOT_NOT_ADMIN and opening it
 * again. So the pin of a live link moves with the chat, and a used or revoked link keeps the id it had
 * as evidence. The whole move against real rows is in src/modules/tenant/tenant-telegram-chats.int.spec.ts.
 */
import type { AuditService } from '@core/audit/audit.service';
import type { PrismaService } from '@core/prisma/prisma.service';

import { TelegramChatMigrationService } from './telegram-chat-migration.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BASIC_GROUP = -55n;
const SUPERGROUP = -1_009n;

describe('TelegramChatMigrationService.migrate', () => {
  it('moves the pin of every live bind link of the operator with the chat', async () => {
    const pins = jest.fn().mockResolvedValue({ count: 1 });
    const tx = {
      tenant: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      depositRequest: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      telegramDiscoveredChat: {
        findFirst: jest.fn().mockResolvedValue(null),
        createMany: jest.fn(),
        updateMany: jest.fn(),
      },
      telegramChatBindLink: { updateMany: pins },
    };
    const prisma = {
      runInTransaction: jest.fn((body: (client: typeof tx) => Promise<unknown>) => body(tx)),
    } as unknown as PrismaService;
    const service = new TelegramChatMigrationService(prisma, {
      write: jest.fn(),
    } as unknown as AuditService);

    await service.migrate(TENANT_ID, BASIC_GROUP, SUPERGROUP, 'service_message');

    expect(pins).toHaveBeenCalledTimes(1);
    expect(pins).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID, pinnedChatId: BASIC_GROUP, usedAt: null, revokedAt: null },
      data: { pinnedChatId: SUPERGROUP },
    });
  });
});
