/**
 * Stable, client-facing error codes for the admin surface. The manager-bot Flutter console switches
 * on these strings, so they are a published contract: rename one and a released app stops
 * recognising the failure it was written to handle.
 */
export const AdminErrorCodes = {
  /** The presented bot code is unknown, already used, or malformed. Never says which. */
  BOT_CODE_INVALID: 'BOT_CODE_INVALID',
  /** The code was real but its TTL elapsed. Separate from INVALID so the UI can say "ask again". */
  BOT_CODE_EXPIRED: 'BOT_CODE_EXPIRED',
} as const;

export type AdminErrorCode = (typeof AdminErrorCodes)[keyof typeof AdminErrorCodes];
