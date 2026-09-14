/**
 * Shared identifiers for the Telegram edge. Queue and job names are a CONTRACT between the webhook
 * controller (producer, api role) and the update processor (consumer, worker role) — those live in
 * different modules and different processes, so a typo would simply mean updates are accepted and
 * never handled, with no error anywhere.
 */

/**
 * DI token for OPTIONAL grammY client options (`ApiClientOptions`) applied to every tenant's Bot and
 * to the getMe that identifies it. Nothing binds it in production, so the Bot API is reached the
 * normal way. Tests bind a `fetch` stub, so no suite can reach api.telegram.org by accident.
 */
export const TELEGRAM_API_CLIENT_OPTIONS = 'TELEGRAM_API_CLIENT_OPTIONS';

/** BullMQ queue carrying inbound updates from the api role to the worker. */
export const TELEGRAM_UPDATE_QUEUE = 'telegram-updates';

/** Job name within that queue. */
export const TELEGRAM_UPDATE_JOB = 'process-update';

/**
 * Telegram sends this header on every webhook call when `secret_token` was set. Node lowercases
 * incoming header names, so this constant must stay lowercase for direct `req.headers[...]` reads.
 */
export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/**
 * Redis dedupe window for update ids. Telegram retries an unacknowledged update for a while and
 * then gives up; an hour comfortably covers that. Postgres' UNIQUE(tenant_id, update_id) is the
 * real guarantee — this only spares it the duplicate traffic.
 */
export const TELEGRAM_UPDATE_DEDUPE_TTL_SECONDS = 3_600;

/**
 * WHY BOTH IDENTIFIERS BELOW CARRY THE TENANT: `update_id` is a counter Telegram keeps PER BOT, and
 * every operator has its own bot. Sooner or later two operators' bots both deliver an update 1000.
 * Keyed on the update id alone, the second one is a "duplicate" and a player's tap or an admin's
 * approval is silently dropped for whichever operator happened to be second.
 */
export const telegramUpdateDedupeKey = (
  tenantId: string,
  updateId: number | bigint | string,
): string => `tg:upd:${tenantId}:${updateId}`;

/** BullMQ job id. Hyphens rather than colons, because colons separate BullMQ's own Redis keys. */
export const telegramUpdateJobId = (tenantId: string, updateId: number | bigint | string): string =>
  `tg-${tenantId}-${updateId}`;

/**
 * A tenant's cached getMe result. Presetting `botInfo` is what lets a tenant's Bot dispatch an update
 * without a network round trip; caching it means getMe runs once a week per bot, not on every
 * container start.
 *
 * WHY THE KEY CARRIES THE TENANT AND THE BOT ID: one global key let whichever bot answered first
 * describe every bot, and survived a token change for its whole TTL. Keyed per tenant and per bot,
 * a different bot can never read another's identity. The cached VALUE also carries a fingerprint of
 * the exact token it was fetched with, and a token that does not match is treated as a miss, so a
 * rotated or retyped token for the same bot is identified afresh instead of inheriting "known good".
 */
export const telegramBotInfoCacheKey = (tenantId: string, botId: string): string =>
  `telegram:botinfo:${tenantId}:${botId}`;
export const BOT_INFO_TTL_SECONDS = 7 * 24 * 3_600;

/**
 * How long a process trusts the Bot it already built before re-reading the tenant's sealed token.
 * A token changed from the dashboard lands in another process, whose `invalidate()` cannot reach this
 * one's memory, so this bounds how long an old token keeps serving here. Short for the same reason
 * TENANT_REGISTRY_TTL_SECONDS is, and the re-read is one primary-key lookup.
 */
export const TENANT_BOT_RECHECK_SECONDS = 30;

/**
 * How long a token that cannot work (unset, unreadable, or rejected by Telegram) is remembered
 * before Telegram or the database is asked again. Without it, every queued update for a broken
 * operator would call getMe and get the same 401. A changed token skips the wait.
 */
export const TENANT_BOT_FAILURE_MEMO_SECONDS = 60;

/**
 * Update types we actually handle. Narrowing this at setWebhook time means Telegram never sends us
 * the rest, which keeps `telegram_updates` free of rows nothing will ever process.
 */
export const TELEGRAM_ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'callback_query',
  'my_chat_member',
] as const;
