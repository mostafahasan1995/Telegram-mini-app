/**
 * Why a tenant's bot cannot be used right now, as data rather than prose.
 *
 * WHY `retryable` IS PART OF THE ERROR: the update processor has to choose between "let BullMQ try
 * again" and "fail this job now". A getMe that timed out will probably work in a second. A token that
 * was never set, will not open, or that Telegram rejected will not, and retrying it five times only
 * repeats the same 401 against Telegram. The registry knows which case it hit, so it says so.
 *
 * NO MESSAGE CARRIES A TOKEN. Messages name the tenant id and the reason, which is what someone
 * fixing it from the dashboard needs.
 */
export const TenantBotErrorCodes = {
  /** No tenant row with this id. */
  TENANT_BOT_TENANT_NOT_FOUND: 'TENANT_BOT_TENANT_NOT_FOUND',
  /** `bot_token_enc` is NULL, empty or a migration/seed placeholder: nobody has pasted a token. */
  TENANT_BOT_UNCONFIGURED: 'TENANT_BOT_UNCONFIGURED',
  /** `bot_token_enc` does not open (tampered, or sealed under another JWT_SECRET). */
  TENANT_BOT_UNREADABLE: 'TENANT_BOT_UNREADABLE',
  /** Telegram answered 401/404 for this token, or it is not shaped like a token at all. */
  TENANT_BOT_TOKEN_REJECTED: 'TENANT_BOT_TOKEN_REJECTED',
  /** getMe failed for a reason that is not the token: network, timeout, Telegram 5xx or 429. */
  TENANT_BOT_UNREACHABLE: 'TENANT_BOT_UNREACHABLE',
} as const;

export type TenantBotErrorCode = (typeof TenantBotErrorCodes)[keyof typeof TenantBotErrorCodes];

export class TenantBotUnavailableError extends Error {
  constructor(
    readonly code: TenantBotErrorCode,
    readonly tenantId: string,
    /** True only when waiting and trying again can succeed without anyone changing anything. */
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'TenantBotUnavailableError';
    Error.captureStackTrace?.(this, TenantBotUnavailableError);
  }
}

export const isTenantBotUnavailableError = (value: unknown): value is TenantBotUnavailableError =>
  value instanceof TenantBotUnavailableError;
