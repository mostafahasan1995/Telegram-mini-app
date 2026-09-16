/**
 * ChatBindingService.bindFromStartGroup without a database or Telegram: a one-time bind link belongs
 * to the first chat that presents it.
 *
 * WHY THIS IS PINNED HERE: `/start@<bot> <nonce>` is a visible message in the group the link added the
 * bot to, so every member of that group can read the nonce. A link refused on chat grounds, or opened
 * in the group that is already bound, is not used up. Without the pin, a member could type the same
 * command in a group they control within the link's 15 minutes and move the staff group, and the
 * review cards, there.
 *
 * The pin table here answers the conditional update the way PostgreSQL does (one row when the link is
 * unpinned or already this chat's, none otherwise), so the order of the steps and every refusal can be
 * asserted. The same rules against real rows, racing groups included, are in
 * src/modules/tenant/tenant-telegram-chats.int.spec.ts.
 *
 * A promoted group is NOT another chat: when the pinned group has become a supergroup, a command
 * still carrying the old id belongs to the same chat and binds the new one (currentChatId). The
 * migrated sighting is the only trail that says so, and the fake below answers it the way the
 * directory does.
 */
import {
  TelegramBotChatStatus,
  TelegramChatPurpose,
  TelegramChatType,
  TenantStatus,
} from '@prisma/client';
import type { Message } from 'grammy/types';

import type { AuditService } from '@core/audit/audit.service';
import type { PrismaService } from '@core/prisma/prisma.service';
import type { TypedQueueService } from '@core/queue/typed-queue.service';

import type { BotService } from '../services/bot.service';
import type { TelegramChatDiscoveryService } from '../services/telegram-chat-discovery.service';
import type { TenantBotSetupService } from '../services/tenant-bot-setup.service';
import { TelegramChatAuditActions } from '../telegram-chat.constants';
import type { ChatVerification } from '../utils/chat-verification.util';

import { ChatBindingService } from './chat-binding.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const LINK_ID = '33333333-3333-4333-8333-333333333333';
const NONCE_HASH = 'a'.repeat(64);
const STAFF_GROUP = -1_001_000_000_001n;
const OTHER_GROUP = -1_001_000_000_002n;
/** A basic group and the supergroup it became when the bot was promoted in it. */
const BASIC_GROUP = -1_001_000_000_003n;
const SUPERGROUP = -1_001_000_000_004n;

const OTHER_CHAT_REPLY_EN =
  'This link was opened in another group. Create a new one from the console.';

interface LinkRow {
  id: string;
  tenantId: string;
  purpose: TelegramChatPurpose;
  nonceHash: string;
  issuedByAdminId: string;
  expiresAt: Date;
  usedAt: Date | null;
  usedChatId: bigint | null;
  pinnedChatId: bigint | null;
  revokedAt: Date | null;
  createdAt: Date;
}

interface AuditInput {
  action: string;
  metadata?: Record<string, unknown>;
}

const startMessage = (chatId: bigint): Message =>
  ({
    message_id: 1,
    date: 1_700_000_000,
    chat: { id: Number(chatId), type: 'supergroup', title: 'Group' },
    from: { id: 42, is_bot: false, first_name: 'Owner' },
    text: `/start@cashier_bot sha256:${NONCE_HASH}`,
  }) as unknown as Message;

const verified = (chatId: bigint): ChatVerification => ({
  ok: true,
  chat: {
    chatId,
    chatType: TelegramChatType.SUPERGROUP,
    title: 'Group',
    username: null,
    facts: {
      status: TelegramBotChatStatus.ADMINISTRATOR,
      isAdministrator: true,
      isPresent: true,
      canPost: true,
    },
  },
  migratedFrom: null,
});

const notAdmin = (chatId: bigint): ChatVerification => ({
  ok: false,
  reason: 'BOT_NOT_ADMIN',
  detail: null,
  chatId,
  migratedFrom: null,
});

function build(
  options: {
    link?: Partial<LinkRow> | null;
    boundStaffChat?: bigint;
    verify?: (chatId: bigint) => ChatVerification;
    /** A group this operator has seen become a supergroup, as the migrated sighting records it. */
    migratedTo?: { from: bigint; to: bigint };
  } = {},
) {
  const link: LinkRow = {
    id: LINK_ID,
    tenantId: TENANT_ID,
    purpose: TelegramChatPurpose.STAFF,
    nonceHash: NONCE_HASH,
    issuedByAdminId: ADMIN_ID,
    expiresAt: new Date(Date.now() + 10 * 60_000),
    usedAt: null,
    usedChatId: null,
    pinnedChatId: null,
    revokedAt: null,
    createdAt: new Date(),
    ...(options.link ?? {}),
  };
  let adminChatId = options.boundStaffChat ?? 0n;

  const findFirst = jest.fn(() => Promise.resolve(options.link === null ? null : { ...link }));
  const pin = jest.fn(({ data }: { data: { pinnedChatId: bigint } }) => {
    const matches = link.pinnedChatId === null || link.pinnedChatId === data.pinnedChatId;
    if (matches) link.pinnedChatId = data.pinnedChatId;
    return Promise.resolve({ count: matches ? 1 : 0 });
  });
  const claim = jest.fn(({ data }: { data: { usedAt: Date; usedChatId: bigint } }) => {
    const matches = link.usedAt === null;
    if (matches) Object.assign(link, data);
    return Promise.resolve({ count: matches ? 1 : 0 });
  });
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    tenant: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          status: TenantStatus.SUSPENDED,
          displayName: 'Operator',
          adminChatId,
          feedChatId: null,
        }),
      ),
      update: jest.fn(({ data }: { data: { adminChatId?: bigint } }) => {
        if (data.adminChatId !== undefined) adminChatId = data.adminChatId;
        return Promise.resolve({ id: TENANT_ID });
      }),
    },
    telegramChatBindLink: { updateMany: claim },
    depositRequest: { findMany: jest.fn().mockResolvedValue([]) },
  };
  // The directory row the migration leaves behind: the old chat, marked with the id it moved to. It
  // is how a command delivered under that old id is recognised as the same chat.
  const migrated = options.migratedTo ?? null;
  const sighting = jest.fn(({ where }: { where: { chatId: bigint } }) =>
    Promise.resolve(
      migrated === null || where.chatId !== migrated.from
        ? null
        : { migratedToChatId: migrated.to },
    ),
  );
  const prisma = {
    telegramChatBindLink: { findFirst, updateMany: pin },
    telegramDiscoveredChat: { findFirst: sighting },
    runInTransaction: jest.fn((body: (client: typeof tx) => Promise<unknown>) => body(tx)),
  } as unknown as PrismaService;

  const auditWrite = jest.fn((_tx: unknown, _input: AuditInput) => Promise.resolve('audit-1'));
  const verifyChat = jest.fn((_tenantId: string, chatId: bigint) =>
    Promise.resolve((options.verify ?? verified)(chatId)),
  );
  const sendMessage = jest.fn(
    (_tenantId: string, _chatId: bigint, _text: string): Promise<null> => Promise.resolve(null),
  );

  const service = new ChatBindingService(
    prisma,
    { write: auditWrite } as unknown as AuditService,
    { verifyChat, sendMessage } as unknown as BotService,
    {
      pushMenus: jest.fn().mockResolvedValue({ fatalError: null, warnings: [] }),
    } as unknown as TenantBotSetupService,
    {
      recordVerified: jest.fn().mockResolvedValue(undefined),
    } as unknown as TelegramChatDiscoveryService,
    { add: jest.fn().mockResolvedValue(undefined) } as unknown as TypedQueueService,
  );

  return {
    link,
    pin,
    claim,
    verifyChat,
    staffChat: (): bigint => adminChatId,
    bind: (chatId: bigint) =>
      service.bindFromStartGroup(TENANT_ID, startMessage(chatId), NONCE_HASH),
    refusals: () =>
      auditWrite.mock.calls
        .map(([, input]) => input)
        .filter((input) => input.action === TelegramChatAuditActions.BIND_REFUSED)
        .map((input) => input.metadata),
    sentTo: (chatId: bigint): string[] =>
      sendMessage.mock.calls.filter(([, to]) => to === chatId).map(([, , text]) => text),
    verifiedChats: (): bigint[] => verifyChat.mock.calls.map(([, chatId]) => chatId),
  };
}

describe('ChatBindingService.bindFromStartGroup — the link belongs to the first chat', () => {
  it('pins the link to the chat that presents it first, with one conditional update, before asking Telegram', async () => {
    const h = build();

    await expect(h.bind(STAFF_GROUP)).resolves.toBe('bound');

    expect(h.pin).toHaveBeenCalledTimes(1);
    expect(h.pin).toHaveBeenCalledWith({
      where: {
        id: LINK_ID,
        tenantId: TENANT_ID,
        OR: [{ pinnedChatId: null }, { pinnedChatId: STAFF_GROUP }],
      },
      data: { pinnedChatId: STAFF_GROUP },
    });
    expect(h.pin.mock.invocationCallOrder[0]!).toBeLessThan(
      h.verifyChat.mock.invocationCallOrder[0]!,
    );
    expect(h.link).toMatchObject({ pinnedChatId: STAFF_GROUP, usedChatId: STAFF_GROUP });
    expect(h.staffChat()).toBe(STAFF_GROUP);
  });

  it('refuses the link from another chat after a refusal on chat grounds, and the first chat still binds once fixed', async () => {
    let promoted = false;
    const h = build({ verify: (chatId) => (promoted ? verified(chatId) : notAdmin(chatId)) });

    await expect(h.bind(STAFF_GROUP)).resolves.toBe('refused');
    expect(h.link.usedAt).toBeNull();

    // A member of the first group replays the command where they control the bot.
    promoted = true;
    await expect(h.bind(OTHER_GROUP)).resolves.toBe('refused');

    expect(h.staffChat()).toBe(0n);
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.verifiedChats()).toEqual([STAFF_GROUP]);
    expect(h.refusals()).toEqual([
      expect.objectContaining({ reason: 'BOT_NOT_ADMIN', chatId: STAFF_GROUP.toString() }),
      {
        purpose: TelegramChatPurpose.STAFF,
        reason: 'LINK_OTHER_CHAT',
        chatId: OTHER_GROUP.toString(),
        via: 'startgroup',
        linkId: LINK_ID,
        telegramUserId: '42',
        detail: null,
      },
    ]);
    const [reply] = h.sentTo(OTHER_GROUP);
    const [arabic, english] = (reply ?? '').split('\n');
    expect(arabic).toMatch(/[؀-ۿ]/);
    expect(english).toBe(OTHER_CHAT_REPLY_EN);
    expect(h.link.pinnedChatId).toBe(STAFF_GROUP);

    // The owner fixes the bot's rights and opens the link again in the first group.
    await expect(h.bind(STAFF_GROUP)).resolves.toBe('bound');
    expect(h.staffChat()).toBe(STAFF_GROUP);
    expect(h.link.usedChatId).toBe(STAFF_GROUP);
  });

  it('refuses the link from another chat after it was opened in the group already bound, which still hears it is bound', async () => {
    const h = build({ boundStaffChat: STAFF_GROUP });

    await expect(h.bind(STAFF_GROUP)).resolves.toBe('bound');
    expect(h.sentTo(STAFF_GROUP)).toEqual([expect.stringContaining('already the staff group')]);
    expect(h.claim).not.toHaveBeenCalled();

    await expect(h.bind(OTHER_GROUP)).resolves.toBe('refused');
    expect(h.staffChat()).toBe(STAFF_GROUP);
    expect(h.refusals()).toEqual([expect.objectContaining({ reason: 'LINK_OTHER_CHAT' })]);
    expect(h.sentTo(OTHER_GROUP)[0]).toContain(OTHER_CHAT_REPLY_EN);

    // The bound group can still open it, and is still told so.
    await expect(h.bind(STAFF_GROUP)).resolves.toBe('bound');
    expect(h.sentTo(STAFF_GROUP)).toHaveLength(2);
    expect(h.verifiedChats()).toEqual([STAFF_GROUP, STAFF_GROUP]);
  });

  it('lets only one of two chats racing for an unpinned link have it, by the answer of the update and not a read', async () => {
    const h = build();

    // Both read the link unpinned before either pins it.
    const outcomes = await Promise.all([h.bind(STAFF_GROUP), h.bind(OTHER_GROUP)]);

    expect(outcomes).toEqual(['bound', 'refused']);
    expect(h.refusals()).toEqual([expect.objectContaining({ reason: 'LINK_OTHER_CHAT' })]);
    expect(h.verifiedChats()).toEqual([STAFF_GROUP]);
    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(h.staffChat()).toBe(STAFF_GROUP);
  });

  it.each([
    ['LINK_USED', { usedAt: new Date(), usedChatId: STAFF_GROUP, pinnedChatId: STAFF_GROUP }],
    ['LINK_REVOKED', { revokedAt: new Date(), pinnedChatId: STAFF_GROUP }],
    ['LINK_EXPIRED', { expiresAt: new Date(Date.now() - 1_000), pinnedChatId: STAFF_GROUP }],
  ] as const)('still answers %s from any chat, before the pin is looked at', async (reason, link) => {
    const h = build({ link });

    await expect(h.bind(OTHER_GROUP)).resolves.toBe('refused');

    expect(h.refusals()).toEqual([expect.objectContaining({ reason })]);
    expect(h.pin).not.toHaveBeenCalled();
    expect(h.verifyChat).not.toHaveBeenCalled();
  });

  it('binds the supergroup a pinned group became, when the command still carries the old id', async () => {
    // The first attempt pinned the basic group and then died on a 429 from Telegram, so the update
    // job retries with the id Telegram delivered the command in. In between, the owner promoted the
    // bot, the group became a supergroup, and TelegramChatMigrationService moved the pin with it.
    const h = build({
      link: { pinnedChatId: SUPERGROUP },
      migratedTo: { from: BASIC_GROUP, to: SUPERGROUP },
    });

    await expect(h.bind(BASIC_GROUP)).resolves.toBe('bound');

    // Pinned, verified, bound and answered as the supergroup — never as the id that is now dead.
    expect(h.pin).toHaveBeenCalledWith({
      where: {
        id: LINK_ID,
        tenantId: TENANT_ID,
        OR: [{ pinnedChatId: null }, { pinnedChatId: SUPERGROUP }],
      },
      data: { pinnedChatId: SUPERGROUP },
    });
    expect(h.verifiedChats()).toEqual([SUPERGROUP]);
    expect(h.staffChat()).toBe(SUPERGROUP);
    expect(h.link).toMatchObject({ pinnedChatId: SUPERGROUP, usedChatId: SUPERGROUP });
    expect(h.refusals()).toEqual([]);
    expect(h.sentTo(BASIC_GROUP)).toEqual([]);
  });

  it('still refuses another chat while the pinned group is one that was promoted', async () => {
    const h = build({
      link: { pinnedChatId: SUPERGROUP },
      migratedTo: { from: BASIC_GROUP, to: SUPERGROUP },
    });

    // OTHER_GROUP migrated into nothing, so it is still simply another chat.
    await expect(h.bind(OTHER_GROUP)).resolves.toBe('refused');

    expect(h.refusals()).toEqual([
      expect.objectContaining({ reason: 'LINK_OTHER_CHAT', chatId: OTHER_GROUP.toString() }),
    ]);
    expect(h.verifyChat).not.toHaveBeenCalled();
    expect(h.staffChat()).toBe(0n);
  });

  it('pins nothing for a nonce that matches no link of this operator', async () => {
    const h = build({ link: null });

    await expect(h.bind(OTHER_GROUP)).resolves.toBe('ignored');

    expect(h.pin).not.toHaveBeenCalled();
    expect(h.refusals()).toEqual([]);
    expect(h.sentTo(OTHER_GROUP)).toEqual([]);
  });
});
