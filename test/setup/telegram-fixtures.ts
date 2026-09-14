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
}

const BOT_API_URL = /\/bot([^/]+)\/([A-Za-z]+)$/;

interface FakeResponse {
  json: () => Promise<unknown>;
}

export function createFakeTelegram(): FakeTelegram {
  const accepted = new Map<string, UserFromGetMe>();
  const unreachable = new Set<string>();
  const calls: FakeTelegramCall[] = [];
  let nextMessageId = 1;

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
      case 'sendMessage':
        return respond({
          ok: true,
          result: {
            message_id: nextMessageId++,
            date: Math.floor(Date.now() / 1000),
            chat: { id: Number(payload['chat_id']), type: 'private', first_name: 'Chat' },
            from: botInfo,
            text: typeof payload['text'] === 'string' ? payload['text'] : '',
          },
        });
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
  };
}
