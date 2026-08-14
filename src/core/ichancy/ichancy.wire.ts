/**
 * WHY: the Ichancy envelope is the same for every endpoint but the `result` slot is a union of
 * "object", "array", "number", "boolean" and "empty array meaning nothing". Parsing it inline at
 * each call site is how you end up reading `result.records[0].playerId` off an empty ARRAY and
 * crashing a money worker. Everything here is total: it never throws, it narrows or returns null.
 *
 * Documented shape surprises encoded below:
 *   - registerPlayer answers `result: 1` (a NUMBER, not the id).
 *   - getChildren answers `result: []` when empty but `result: { records: [...] }` when not.
 *   - getPlayersForCurrentAgent answers `result: { records: [], totalRecordsCount: null }` when empty.
 *   - depositToPlayer/withdrawFromPlayer answer either `result: { balance, ... }` or `result: []`.
 */

/** Every endpoint lives under this prefix and is a POST. */
export const ICHANCY_API_PREFIX = '/global/api/UserApi';

export const IchancyEndpoint = {
  SIGNIN: 'signin',
  REFRESH_TOKEN: 'refreshToken',
  GET_AGENT_ALL_WALLETS: 'getAgentAllWallets',
  DEPOSIT_TO_AGENT: 'depositToAgent',
  WITHDRAW_FROM_AGENT: 'withdrawFromAgent',
  GET_CHILDREN: 'getChildren',
  REGISTER_PLAYER: 'registerPlayer',
  GET_PLAYERS_FOR_CURRENT_AGENT: 'getPlayersForCurrentAgent',
  DEPOSIT_TO_PLAYER: 'depositToPlayer',
  WITHDRAW_FROM_PLAYER: 'withdrawFromPlayer',
  GET_PLAYER_BALANCE_BY_ID: 'getPlayerBalanceById',
} as const;

export type IchancyEndpointName = (typeof IchancyEndpoint)[keyof typeof IchancyEndpoint];

/** `moneyStatus` is an opaque Ichancy discriminator: 3 for agent moves, 5 for player moves. */
export const MoneyStatus = { AGENT: 3, PLAYER: 5 } as const;

export interface IchancyNotification {
  readonly code?: number;
  readonly content?: string;
  readonly title?: string;
  readonly autoHideAfter?: number;
  readonly list?: unknown[];
  /** Only the literal string 'error' means failure; other values are informational. */
  readonly status?: string;
}

export interface IchancyEnvelope {
  readonly status?: boolean;
  readonly html?: string;
  readonly result?: unknown;
  readonly notification?: readonly IchancyNotification[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Turn a parsed JSON body into an envelope. Returns null when the body is not even an object, which
 * the adapter treats as `ambiguous` (an HTML error page from a proxy looks exactly like this).
 */
export function toEnvelope(raw: unknown): IchancyEnvelope | null {
  if (!isRecord(raw)) return null;
  const notification = Array.isArray(raw['notification'])
    ? raw['notification'].filter(isRecord).map((item): IchancyNotification => ({
        code: typeof item['code'] === 'number' ? item['code'] : undefined,
        content: typeof item['content'] === 'string' ? item['content'] : undefined,
        title: typeof item['title'] === 'string' ? item['title'] : undefined,
        status: typeof item['status'] === 'string' ? item['status'] : undefined,
      }))
    : undefined;

  return {
    status: typeof raw['status'] === 'boolean' ? raw['status'] : undefined,
    html: typeof raw['html'] === 'string' ? raw['html'] : undefined,
    result: raw['result'],
    notification,
  };
}

/** The first notification the API flagged as an error, if any. */
export function firstErrorNotification(
  envelope: IchancyEnvelope | null,
): IchancyNotification | null {
  if (!envelope?.notification) return null;
  return envelope.notification.find((n) => n.status === 'error') ?? null;
}

/**
 * Paged endpoints answer `{ records: [...] }` OR a bare `[]` OR `[{...}]`.
 * Returns a plain array of records in every case, so callers only handle "empty" vs "not empty".
 */
export function readRecords(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result.filter(isRecord);
  if (isRecord(result)) {
    const records = result['records'];
    if (Array.isArray(records)) return records.filter(isRecord);
  }
  return [];
}

/** `result` as a single object, or null when it is `[]` / a scalar / missing. */
export function readObjectResult(result: unknown): Record<string, unknown> | null {
  if (isRecord(result)) return result;
  if (Array.isArray(result)) {
    const first: unknown = (result as unknown[])[0];
    return isRecord(first) ? first : null;
  }
  return null;
}

/** Read a string field, tolerating the API sending an id as a number. */
export function readStringField(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Case-insensitive lookup: the API is not consistent about `userName` vs `username`. */
export function readStringFieldAny(
  source: Record<string, unknown>,
  fields: readonly string[],
): string | null {
  for (const field of fields) {
    const direct = readStringField(source, field);
    if (direct !== null) return direct;
  }
  const lowered = new Map<string, unknown>();
  for (const [key, value] of Object.entries(source)) lowered.set(key.toLowerCase(), value);
  for (const field of fields) {
    const value = lowered.get(field.toLowerCase());
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** Field aliases we have seen for the same concept, most specific first. */
export const PLAYER_ID_FIELDS = ['playerId', 'id'] as const;
export const LOGIN_FIELDS = ['username', 'userName', 'login'] as const;
export const AFFILIATE_ID_FIELDS = ['affiliateId', 'id'] as const;

/** Token pair returned by signin/refreshToken. */
export interface IchancyTokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export function readTokenPair(result: unknown): IchancyTokenPair | null {
  const record = readObjectResult(result);
  if (!record) return null;
  const accessToken = record['accessToken'];
  const refreshToken = record['refreshToken'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) return null;
  return { accessToken, refreshToken };
}
