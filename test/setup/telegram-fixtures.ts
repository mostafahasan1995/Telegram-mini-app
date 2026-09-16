/**
 * An offline Telegram Bot API for specs.
 *
 * WHY A FAKE `fetch` AND NOT A MOCKED BOT: the code under test builds real grammY Bots per operator
 * (TenantBotRegistry), installs real transformers on them (autoRetry, the token-rejection observer)
 * and dispatches real updates through them. Mocking the Bot would skip exactly that. grammY accepts a
 * `fetch` in its client options, so the only thing replaced is the network: every call still goes
 * through grammY's own request building, transformers and response handling.
 *
 * It answers per TOKEN, the way Telegram does: an accepted token gets real-shaped results, any other
 * token gets 401 Unauthorized, and a token marked unreachable gets a network error. Every call is
 * recorded with the token it was made with, which is how a spec proves which operator's bot spoke.
 *
 * Imports nothing from the Nest graph, so unit specs can use it without booting anything.
 */
import { type ApiClientOptions } from 'grammy';
import { type UserFromGetMe } from 'grammy/types';

/**
 * Offline stand-in for a getMe() answer. ONE literal for every suite: grammY's `UserFromGetMe` gains
 * required fields between versions, and a second copy of this literal is a compile error waiting to
 * happen in whichever file gets forgotten.
 */
export const TEST_BOT_INFO: UserFromGetMe = {
  id: 123_456_789,
  is_bot: true,
  first_name: 'Ichancy Cashier Test',
  username: 'ichancy_cashier_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

/** A distinct bot identity built from the shared literal. */
export const testBotInfo = (id: number, username: string): UserFromGetMe => ({
  ...TEST_BOT_INFO,
  id,
  username,
  first_name: username,
});

export interface FakeTelegramCall {
  token: string;
  method: string;
  payload: Record<string, unknown>;
}

/**
 * What the fake Telegram holds as a bot's webhook. Keyed by BOT, not by token, as Telegram keeps it:
 * a token regenerated at BotFather still addresses the same bot and the same registration.
 */
export interface FakeWebhookState {
  url: string;
  secretToken: string | null;
  allowedUpdates: string[] | null;
  pendingUpdateCount: number;
  lastErrorMessage: string | null;
  /** Unix seconds, as Telegram reports it. */
  lastErrorDate: number | null;
}

export interface FakeTelegram {
  /** Pass to TenantBotRegistry (or a Bot) as its client options. */
  readonly clientOptions: ApiClientOptions;
  readonly calls: FakeTelegramCall[];
  /** Telegram accepts this token and getMe answers with this identity. */
  accept(token: string, botInfo: UserFromGetMe): void;
  /** Telegram answers 401 for this token from now on, as after a revoke at BotFather. */
  revoke(token: string): void;
  /** Calls with this token fail at the network level until `restore()`. */
  makeUnreachable(token: string): void;
  restore(token: string): void;
  callsFor(token: string, method?: string): FakeTelegramCall[];
  /**
   * setWebhook with this token answers 400 with `description` until `allowWebhook`, the way Telegram
   * refuses a URL it cannot deliver to (a laptop's https://api.localhost, a plain http URL).
   */
  refuseWebhook(token: string, description: string): void;
  allowWebhook(token: string): void;
  /** The webhook Telegram holds for this token's bot, or null when none is set. */
  webhookFor(token: string): FakeWebhookState | null;
  /** Puts a webhook in place without a setWebhook call: another deployment's, or a failing one. */
  setWebhookState(token: string, state: Partial<FakeWebhookState> & { url: string }): void;
  /** What getChat answers for this chat id. An unknown chat is "Bad Request: chat not found". */
  setChat(chatId: bigint | number, state: FakeChatState): void;
  /**
   * The bot's own membership in a chat, as getChatMember answers it for this token's bot:
   * `{ status: 'administrator' }`, `{ status: 'member' }`, `{ status: 'left' }`, …. Unset reads as left.
   */
  setBotMember(token: string, chatId: bigint | number, member: Record<string, unknown>): void;
  /**
   * The group became a supergroup: from now on getChat and sendMessage on the old id answer 400 with
   * `parameters.migrate_to_chat_id`, as Telegram does, and the new id answers as a supergroup.
   */
  migrateChat(fromChatId: bigint | number, toChatId: bigint | number): void;
}

export interface FakeChatState {
  type: 'group' | 'supergroup' | 'channel' | 'private';
  title?: string;
  username?: string;
}

const BOT_API_URL = /\/bot([^/]+)\/([A-Za-z]+)$/;

interface FakeResponse {
  json: () => Promise<unknown>;
}

export function createFakeTelegram(): FakeTelegram {
  const accepted = new Map<string, UserFromGetMe>();
  const unreachable = new Set<string>();
  const calls: FakeTelegramCall[] = [];
  /** bot id -> its webhook. */
  const webhooks = new Map<number, FakeWebhookState>();
  /** token -> the description setWebhook is refused with. */
  const webhookRefusals = new Map<string, string>();
  /** chat id (decimal string) -> what getChat answers. */
  const chats = new Map<string, FakeChatState>();
  /** chat id -> the supergroup it became. */
  const migrations = new Map<string, string>();
  /** `<bot id>:<chat id>` -> the bot's ChatMember fields in that chat. */
  const botMembers = new Map<string, Record<string, unknown>>();
  let nextMessageId = 1;

  const chatKey = (value: unknown): string =>
    typeof value === 'number' || typeof value === 'bigint' ? value.toString() : String(value);

  const migratedResponse = (chatId: string): Promise<FakeResponse> | null => {
    const movedTo = migrations.get(chatId);
    return movedTo === undefined
      ? null
      : respond({
          ok: false,
          error_code: 400,
          description: 'Bad Request: group chat was upgraded to a supergroup chat',
          parameters: { migrate_to_chat_id: Number(movedTo) },
        });
  };

  const botIdOf = (token: string): number | null => accepted.get(token)?.id ?? null;

  const stringArray = (value: unknown): string[] | null =>
    Array.isArray(value) && value.every((item): item is string => typeof item === 'string')
      ? value
      : null;

  const respond = (body: unknown): Promise<FakeResponse> =>
    Promise.resolve({ json: () => Promise.resolve(body) });

  const fakeFetch = (input: unknown, init?: { body?: unknown }): Promise<FakeResponse> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : '';
    const match = BOT_API_URL.exec(url);
    if (match === null) return Promise.reject(new Error('Unexpected Bot API URL shape'));
    const token = match[1] ?? '';
    const method = match[2] ?? '';
    const payload =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ token, method, payload });

    if (unreachable.has(token)) return Promise.reject(new TypeError('fetch failed'));

    const botInfo = accepted.get(token);
    if (botInfo === undefined) {
      return respond({ ok: false, error_code: 401, description: 'Unauthorized' });
    }

    switch (method) {
      case 'getMe':
        return respond({ ok: true, result: botInfo });
      case 'setWebhook': {
        const refusal = webhookRefusals.get(token);
        if (refusal !== undefined) {
          return respond({ ok: false, error_code: 400, description: refusal });
        }
        webhooks.set(botInfo.id, {
          url: typeof payload['url'] === 'string' ? payload['url'] : '',
          secretToken: typeof payload['secret_token'] === 'string' ? payload['secret_token'] : null,
          allowedUpdates: stringArray(payload['allowed_updates']),
          pendingUpdateCount: 0,
          lastErrorMessage: null,
          lastErrorDate: null,
        });
        return respond({ ok: true, result: true });
      }
      case 'deleteWebhook':
        webhooks.delete(botInfo.id);
        return respond({ ok: true, result: true });
      case 'getWebhookInfo': {
        const state = webhooks.get(botInfo.id);
        return respond({
          ok: true,
          result: {
            url: state?.url ?? '',
            has_custom_certificate: false,
            pending_update_count: state?.pendingUpdateCount ?? 0,
            ...(state?.allowedUpdates ? { allowed_updates: state.allowedUpdates } : {}),
            ...(state?.lastErrorMessage
              ? {
                  last_error_message: state.lastErrorMessage,
                  last_error_date: state.lastErrorDate ?? Math.floor(Date.now() / 1000),
                }
              : {}),
          },
        });
      }
      case 'sendMessage': {
        const chatId = chatKey(payload['chat_id']);
        const moved = migratedResponse(chatId);
        if (moved !== null) return moved;
        const known = chats.get(chatId);
        return respond({
          ok: true,
          result: {
            message_id: nextMessageId++,
            date: Math.floor(Date.now() / 1000),
            chat:
              known === undefined || known.type === 'private'
                ? { id: Number(chatId), type: 'private', first_name: 'Chat' }
                : { id: Number(chatId), type: known.type, title: known.title ?? 'Chat' },
            from: botInfo,
            text: typeof payload['text'] === 'string' ? payload['text'] : '',
          },
        });
      }
      case 'getChat': {
        const chatId = chatKey(payload['chat_id']);
        const moved = migratedResponse(chatId);
        if (moved !== null) return moved;
        const known = chats.get(chatId);
        if (known === undefined) {
          return respond({ ok: false, error_code: 400, description: 'Bad Request: chat not found' });
        }
        return respond({
          ok: true,
          result:
            known.type === 'private'
              ? { id: Number(chatId), type: 'private', first_name: known.title ?? 'Person' }
              : {
                  id: Number(chatId),
                  type: known.type,
                  title: known.title ?? 'Chat',
                  ...(known.username === undefined ? {} : { username: known.username }),
                },
        });
      }
      case 'getChatMember': {
        const chatId = chatKey(payload['chat_id']);
        const moved = migratedResponse(chatId);
        if (moved !== null) return moved;
        if (!chats.has(chatId)) {
          return respond({ ok: false, error_code: 400, description: 'Bad Request: chat not found' });
        }
        const fields =
          Number(payload['user_id']) === botInfo.id
            ? (botMembers.get(`${botInfo.id}:${chatId}`) ?? { status: 'left' })
            : { status: 'left' };
        return respond({ ok: true, result: { user: botInfo, ...fields } });
      }
      default:
        return respond({ ok: true, result: true });
    }
  };

  return {
    clientOptions: { fetch: fakeFetch },
    calls,
    accept: (token, botInfo) => {
      accepted.set(token, botInfo);
    },
    revoke: (token) => {
      accepted.delete(token);
    },
    makeUnreachable: (token) => {
      unreachable.add(token);
    },
    restore: (token) => {
      unreachable.delete(token);
    },
    callsFor: (token, method) =>
      calls.filter(
        (call) => call.token === token && (method === undefined || call.method === method),
      ),
    refuseWebhook: (token, description) => {
      webhookRefusals.set(token, description);
    },
    allowWebhook: (token) => {
      webhookRefusals.delete(token);
    },
    webhookFor: (token) => {
      const botId = botIdOf(token);
      return botId === null ? null : (webhooks.get(botId) ?? null);
    },
    setChat: (chatId, state) => {
      chats.set(chatKey(chatId), state);
    },
    setBotMember: (token, chatId, member) => {
      const botId = botIdOf(token);
      if (botId === null) throw new Error('setBotMember needs a token accepted first');
      botMembers.set(`${botId}:${chatKey(chatId)}`, member);
    },
    migrateChat: (fromChatId, toChatId) => {
      const from = chatKey(fromChatId);
      const to = chatKey(toChatId);
      const previous = chats.get(from);
      migrations.set(from, to);
      chats.set(to, { ...(previous ?? { title: 'Chat' }), type: 'supergroup' });
      for (const [key, member] of [...botMembers.entries()]) {
        const [botId, chatId] = key.split(':');
        if (chatId === from) botMembers.set(`${botId ?? ''}:${to}`, member);
      }
    },
    setWebhookState: (token, state) => {
      const botId = botIdOf(token);
      if (botId === null) throw new Error('setWebhookState needs a token accepted first');
      webhooks.set(botId, {
        secretToken: null,
        allowedUpdates: null,
        pendingUpdateCount: 0,
        lastErrorMessage: null,
        lastErrorDate: null,
        ...state,
      });
    },
  };
}
