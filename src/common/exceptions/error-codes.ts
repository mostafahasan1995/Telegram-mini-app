/**
 * WHY: error codes are part of our API contract — the mini-app switches on them and support staff
 * quote them. Messages are for humans and may be reworded at any time; codes may not. There is no
 * i18n on the backend: the client owns translation, keyed by these strings.
 *
 * Rules for anyone adding a code:
 *  - SCREAMING_SNAKE, no spaces, no punctuation.
 *  - Never rename or reuse a code. Retire it and add a new one.
 *  - Never encode a value into the code (amounts, ids); those belong in `details`.
 *
 * This map holds the codes the *edges* own (auth, transport, persistence, validation). Feature
 * modules declare their own domain codes next to the service that throws them.
 */
export const CommonErrorCodes = {
  // ---- authentication / authorization -------------------------------------
  /** No credential presented at all, or the header was malformed. */
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  /** Credential present but not usable (bad signature, wrong shape). */
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  /** The session behind an otherwise-valid access token was revoked. */
  SESSION_REVOKED: 'SESSION_REVOKED',
  /** Refresh token unknown, already rotated, revoked or expired. */
  REFRESH_TOKEN_INVALID: 'REFRESH_TOKEN_INVALID',
  /** A rotated refresh token was presented again — treated as theft, whole chain is killed. */
  REFRESH_TOKEN_REUSED: 'REFRESH_TOKEN_REUSED',
  /** Authenticated, but as the wrong kind of principal (player token on an admin route). */
  WRONG_PRINCIPAL: 'WRONG_PRINCIPAL',
  FORBIDDEN: 'FORBIDDEN',
  INSUFFICIENT_ROLE: 'INSUFFICIENT_ROLE',
  ADMIN_NOT_FOUND: 'ADMIN_NOT_FOUND',
  ADMIN_INACTIVE: 'ADMIN_INACTIVE',

  // ---- Telegram initData ---------------------------------------------------
  INIT_DATA_MALFORMED: 'INIT_DATA_MALFORMED',
  INIT_DATA_HASH_MISSING: 'INIT_DATA_HASH_MISSING',
  INIT_DATA_HASH_INVALID: 'INIT_DATA_HASH_INVALID',
  INIT_DATA_EXPIRED: 'INIT_DATA_EXPIRED',
  INIT_DATA_AUTH_DATE_MISSING: 'INIT_DATA_AUTH_DATE_MISSING',
  INIT_DATA_USER_MISSING: 'INIT_DATA_USER_MISSING',
  /** The same initData hash was presented twice — a replay. */
  INIT_DATA_REPLAYED: 'INIT_DATA_REPLAYED',

  // ---- Telegram webhook ----------------------------------------------------
  TELEGRAM_WEBHOOK_SECRET_INVALID: 'TELEGRAM_WEBHOOK_SECRET_INVALID',
  CALLBACK_DATA_TOO_LONG: 'CALLBACK_DATA_TOO_LONG',
  CALLBACK_DATA_MALFORMED: 'CALLBACK_DATA_MALFORMED',

  // ---- validation ----------------------------------------------------------
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  INVALID_CURRENCY: 'INVALID_CURRENCY',

  // ---- persistence ---------------------------------------------------------
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  DUPLICATE_RESOURCE: 'DUPLICATE_RESOURCE',
  /** Foreign key violated: the thing we point at does not exist (or is still referenced). */
  REFERENCE_CONSTRAINT: 'REFERENCE_CONSTRAINT',
  /** Serialization failure / deadlock. Safe to retry the whole request. */
  WRITE_CONFLICT: 'WRITE_CONFLICT',

  // ---- concurrency ---------------------------------------------------------
  /** Someone else holds the mutex for this resource (per-player credit lock, session lock). */
  LOCK_UNAVAILABLE: 'LOCK_UNAVAILABLE',

  // ---- generic -------------------------------------------------------------
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  BAD_REQUEST: 'BAD_REQUEST',
  BUSINESS_RULE_VIOLATION: 'BUSINESS_RULE_VIOLATION',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  /** The catch-all for anything we did not anticipate. Always paired with a correlation id. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type CommonErrorCode = (typeof CommonErrorCodes)[keyof typeof CommonErrorCodes];

/**
 * Feature modules add their own codes, so the contract is "any stable string", not this union.
 * The alias exists to document intent at call sites and in signatures.
 */
export type ErrorCode = string;
