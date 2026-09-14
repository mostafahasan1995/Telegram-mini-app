/**
 * Shared identifiers for the Telegram edge. Queue and job names are a CONTRACT between the webhook
 * controller (producer, api role) and the update processor (consumer, worker role) — those live in
 * different modules and different processes, so a typo would simply mean updates are accepted and
 * never handled, with no error anywhere.
 */

/** DI token for the singleton grammY Bot. */
export const TELEGRAM_BOT = 'TELEGRAM_BOT';

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
 * Cached getMe result. Presetting `botInfo` is what lets a Bot be constructed without a network
 * call at boot; caching it means we pay for getMe once a week instead of on every container start.
 */
export const BOT_INFO_CACHE_KEY = 'telegram:botinfo';
export const BOT_INFO_TTL_SECONDS = 7 * 24 * 3_600;

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
