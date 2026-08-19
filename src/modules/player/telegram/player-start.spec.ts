/**
 * THE PRODUCT REQUIREMENT, AS A TEST.
 *
 * "A player presses Start in the bot. That registers them as a player under OUR agent (the one in
 *  env). The agent then sees one new player in the Ichancy panel."
 *
 * Every clause of that sentence is asserted below, because each is served by a different piece of
 * the system and any one of them can be broken without the others noticing:
 *
 *   "a player"                -> a Player row is upserted from the Telegram identity
 *   "registers them"          -> ensureLinked runs on /start, not lazily at the first credit
 *   "under OUR agent"         -> registerPlayer carries parentId = ICHANCY_AGENT_ID. Proven one
 *                                layer down, in http-ichancy.adapter.spec.ts ("registers, then
 *                                resolves the id"), because that is where the wire body is built.
 *   "the agent sees one"      -> the call happens EXACTLY once per player: a second /start finds the
 *                                account already linked and registers nothing new.
 *
 * The bot is a PLAYER surface: nothing here requires an admin, and none of it is reachable from the
 * admin command set.
 */
import type { Context } from 'grammy';

import { PlayerTelegramHandlers } from './player.handlers';

const TELEGRAM_USER_ID = 912911246;
const PLAYER_ID = '9f3c1e58-0000-4000-8000-00000000aaaa';
const AGENT_ID = '2372020';

interface Harness {
  handlers: PlayerTelegramHandlers;
  ensureLinked: jest.Mock;
  upsertFromTelegram: jest.Mock;
  replies: string[];
  adminMessages: { chatId: string; text: string }[];
}

/**
 * Builds the handler with stubs. Deliberately hand-rolled rather than a Nest testing module: this
 * asserts what /start DOES, and a DI container would only add a way for the test to fail for
 * reasons that have nothing to do with the requirement.
 */
function harness(options: { isNew?: boolean; alreadyLinked?: boolean } = {}): Harness {
  const isNew = options.isNew ?? true;
  const created = !(options.alreadyLinked ?? false);

  const replies: string[] = [];
  const adminMessages: { chatId: string; text: string }[] = [];

  const upsertFromTelegram = jest.fn().mockResolvedValue({
    player: {},
    playerId: PLAYER_ID,
    isNew,
  });

  const ensureLinked = jest.fn().mockResolvedValue({
    playerId: PLAYER_ID,
    ichancyPlayerId: '414402262',
    ichancyLogin: 'p7k3mq9x2vn4bcd',
    created,
  });

  const prisma = {
    runInTransaction: (callback: (tx: unknown) => unknown) => callback({}),
    player: { count: jest.fn().mockResolvedValue(91) },
  };

  const credentialsFor = jest.fn().mockReturnValue({
    login: 'p912911246_7fszgwgh',
    email: 'p912911246_7fszgwgh@players.example.com',
    password: 'Qk3mZ9xLp2vAa1!',
  });

  const handlers = new PlayerTelegramHandlers(
    prisma as never,
    { upsertFromTelegram } as never,
    { findById: jest.fn().mockResolvedValue({ id: PLAYER_ID }) } as never,
    { ensureLinked, credentialsFor } as never,
    {
      bindFromStartPayload: jest.fn().mockResolvedValue({ outcome: 'IGNORED_NO_PAYLOAD' }),
    } as never,
    {
      ichancy: { currency: 'NSP', agentId: AGENT_ID, playerSiteUrl: 'https://ichancy.com' },
      telegram: { adminChatId: -1004382350658n },
      app: { baseUrl: 'https://app.example.com' },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const ctx = {
    from: { id: TELEGRAM_USER_ID, is_bot: false, first_name: 'Mustafa', username: 'mustafa' },
    chat: { id: TELEGRAM_USER_ID, type: 'private' },
    match: '',
    update: { update_id: 1 },
    me: { username: 'cashier_bot' },
    reply: jest.fn((text: string) => {
      replies.push(text);
      return Promise.resolve();
    }),
    api: {
      sendMessage: jest.fn((chatId: string, text: string) => {
        adminMessages.push({ chatId, text });
        return Promise.resolve();
      }),
    },
  } as unknown as Context;

  // The ctx travels with the harness through the single call each test makes.
  (handlers as unknown as { __ctx: Context }).__ctx = ctx;

  return { handlers, ensureLinked, upsertFromTelegram, replies, adminMessages };
}

const ctxOf = (handlers: PlayerTelegramHandlers): Context =>
  (handlers as unknown as { __ctx: Context }).__ctx;

describe('/start registers the player under our agent', () => {
  it('creates the player row from the Telegram identity', async () => {
    const h = harness();
    await h.handlers.onStart(ctxOf(h.handlers));

    expect(h.upsertFromTelegram).toHaveBeenCalledTimes(1);
    const profile = h.upsertFromTelegram.mock.calls[0]?.[1] as { telegramUserId: bigint };
    expect(profile.telegramUserId).toBe(BigInt(TELEGRAM_USER_ID));
    // The currency the agent actually operates in, not a per-player choice.
    expect(h.upsertFromTelegram.mock.calls[0]?.[2]).toBe('NSP');
  });

  it('registers the Ichancy account ON /start, not at the first credit', async () => {
    const h = harness();
    await h.handlers.onStart(ctxOf(h.handlers));

    expect(h.ensureLinked).toHaveBeenCalledTimes(1);
    expect(h.ensureLinked).toHaveBeenCalledWith(PLAYER_ID, 'telegram:/start');
  });

  it('tells the player their gaming account is ready', async () => {
    const h = harness();
    await h.handlers.onStart(ctxOf(h.handlers));

    expect(h.replies.some((text) => text.includes('تم إنشاء حساب اللعب'))).toBe(true);
  });

  it('posts one arrivals card to the admin group, naming the agent-side identifiers', async () => {
    const h = harness();
    await h.handlers.onStart(ctxOf(h.handlers));

    expect(h.adminMessages).toHaveLength(1);
    const card = h.adminMessages[0];
    expect(card?.chatId).toBe('-1004382350658');
    expect(card?.text).toContain('New player');
    expect(card?.text).toContain(String(TELEGRAM_USER_ID));
    // The two ids that let an operator find this person in the Ichancy panel.
    expect(card?.text).toContain('p7k3mq9x2vn4bcd');
    expect(card?.text).toContain('414402262');
  });

  it('registers nothing new when the same player presses Start again', async () => {
    // A returning player: the row is not new and the account already exists. The agent must NOT see
    // a second player appear, and the group must not get a second arrivals card.
    const h = harness({ isNew: false, alreadyLinked: true });
    await h.handlers.onStart(ctxOf(h.handlers));

    // ensureLinked is still CALLED — it is the idempotent probe — but it reports created:false,
    // which is what keeps both the confirmation and the admin card from being sent again.
    expect(h.ensureLinked).toHaveBeenCalledTimes(1);
    expect(h.adminMessages).toHaveLength(0);
    expect(h.replies.some((text) => text.includes('تم إنشاء حساب اللعب'))).toBe(false);
  });

  it('still greets the player when registration fails, and stays silent about it', async () => {
    // The far side is down (Cloudflare, a timeout). The player must not be met with an error on
    // their first ever message; the credit path will register them later.
    const h = harness();
    h.ensureLinked.mockRejectedValueOnce(new Error('CLOUDFLARE_CHALLENGE'));

    await expect(h.handlers.onStart(ctxOf(h.handlers))).resolves.toBeUndefined();

    expect(h.replies.some((text) => text.includes('أهلاً وسهلاً'))).toBe(true);
    expect(h.replies.some((text) => text.toLowerCase().includes('cloudflare'))).toBe(false);
  });
});

describe('the player is told how to sign in', () => {
  /**
   * An account the player cannot log into is a wallet, not a gaming account. Registering one and
   * never handing over the credentials would leave every player able to deposit and unable to play.
   */
  it('sends the login and password when the account is created', async () => {
    const h = harness();
    await h.handlers.onStart(ctxOf(h.handlers));

    const card = h.replies.find((text) => text.includes('اسم المستخدم'));
    expect(card).toBeDefined();
    expect(card).toContain('p912911246_7fszgwgh');
    expect(card).toContain('Qk3mZ9xLp2vAa1!');
    expect(card).toContain('https://ichancy.com');
  });

  it('never sends credentials to a returning player unprompted', async () => {
    // They already have them; re-posting a password into a chat on every /start is a leak waiting
    // to be screenshotted. /account is how a player asks for them again.
    const h = harness({ isNew: false, alreadyLinked: true });
    await h.handlers.onStart(ctxOf(h.handlers));

    expect(h.replies.some((text) => text.includes('كلمة السر'))).toBe(false);
  });

  it('refuses to print credentials in a group, and says where to get them', async () => {
    // ctx.reply answers wherever the command was sent — in a group that is a working casino login
    // published to everyone who can read the chat.
    const h = harness();
    const ctx = ctxOf(h.handlers) as unknown as { chat: { type: string } };
    ctx.chat.type = 'supergroup';

    await h.handlers.onStart(ctxOf(h.handlers));

    // Assert on the SECRET ITSELF, not on the word "password": the group reply deliberately mentions
    // the word while telling the player where to get them, and an assertion on the label would fail
    // for good wording while passing for an actual leak that phrased itself differently.
    expect(h.replies.some((text) => text.includes('Qk3mZ9xLp2vAa1!'))).toBe(false);
    expect(h.replies.some((text) => text.includes('p912911246_7fszgwgh'))).toBe(false);
    expect(h.replies.some((text) => text.includes('حسابي'))).toBe(true);
  });
});

describe('👤 حسابي shows an existing account its sign-in details', () => {
  /** The returning-player path: nothing is created, the profile just answers "what is my account?". */
  function profileHarness(chatType: 'private' | 'supergroup') {
    const replies: string[] = [];
    const player = {
      id: PLAYER_ID,
      telegramUserId: BigInt(TELEGRAM_USER_ID),
      telegramUsername: 'mustafa',
      firstName: 'Mustafa',
      lastName: null,
      status: 'ACTIVE',
      currencyCode: 'NSP',
      ichancyPlayerId: '459424640',
      ichancyLogin: 'p912911246_7fszgwgh',
      languageCode: 'ar',
      createdAt: new Date('2026-08-13T13:38:54Z'),
      lastSeenAt: null,
    };

    const handlers = new PlayerTelegramHandlers(
      {} as never,
      {
        checkEligibility: jest
          .fn()
          .mockResolvedValue({ eligible: true, reason: null, excludedUntil: null }),
      } as never,
      {
        findByTelegramUserId: jest.fn().mockResolvedValue(player),
        findById: jest.fn().mockResolvedValue(player),
      } as never,
      {
        credentialsFor: jest.fn().mockReturnValue({
          login: 'p912911246_7fszgwgh',
          email: 'p912911246_7fszgwgh@players.example.com',
          password: 'Qk3mZ9xLp2vAa1!',
        }),
      } as never,
      {} as never,
      {
        ichancy: { currency: 'NSP', agentId: AGENT_ID, playerSiteUrl: 'https://ichancy.com' },
        telegram: { adminChatId: -1004382350658n },
        app: { baseUrl: 'https://app.example.com' },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const ctx = {
      from: { id: TELEGRAM_USER_ID, is_bot: false, first_name: 'Mustafa', username: 'mustafa' },
      chat: { id: TELEGRAM_USER_ID, type: chatType },
      update: { update_id: 2 },
      me: { username: 'cashier_bot' },
      reply: jest.fn((text: string) => {
        replies.push(text);
        return Promise.resolve();
      }),
    } as unknown as Context;

    return { handlers, ctx, replies };
  }

  it('prints the login and password in a private chat', async () => {
    const h = profileHarness('private');
    await h.handlers.onProfile(h.ctx);

    const profile = h.replies[0] ?? '';
    expect(profile).toContain('p912911246_7fszgwgh');
    expect(profile).toContain('Qk3mZ9xLp2vAa1!');
    expect(profile).toContain('https://ichancy.com');
  });

  it('withholds them in a group and points at a private chat instead', async () => {
    const h = profileHarness('supergroup');
    await h.handlers.onProfile(h.ctx);

    const profile = h.replies[0] ?? '';
    expect(profile).not.toContain('Qk3mZ9xLp2vAa1!');
    // The profile itself still renders — only the secret half is held back.
    expect(profile).toContain('Your profile');
    expect(profile).toContain('حسابي');
  });
});
