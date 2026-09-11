/**
 * Tenancy's own codes. Same rules as CommonErrorCodes: SCREAMING_SNAKE, never renamed, never
 * reused, and no values encoded into the code itself.
 */
export const TenantErrorCodes = {
  /**
   * X-Tenant-Id named an operator that does not exist.
   *
   * A 400 and NOT a silent fallback to the caller's home tenant: swallowing it would show a
   * platform admin one operator's deposits while the screen said another's, with nothing anywhere
   * to reveal the mismatch. Loud is the only safe answer.
   */
  TENANT_NOT_FOUND: 'TENANT_NOT_FOUND',
  /** The operator exists but is SUSPENDED or CLOSED, so it is not serving requests. */
  TENANT_NOT_ACTIVE: 'TENANT_NOT_ACTIVE',
  /** The slug is already taken. Creation de-duplicates automatically; this is for explicit slugs. */
  TENANT_SLUG_TAKEN: 'TENANT_SLUG_TAKEN',
  /**
   * Refused a change of `ichancyAgentId` on an operator that already has players. Repointing an
   * agent under existing players orphans them from the tree their balances live in.
   */
  TENANT_AGENT_HAS_PLAYERS: 'TENANT_AGENT_HAS_PLAYERS',
  /** Telegram refused the bot token — getMe did not answer. */
  TENANT_BOT_TOKEN_INVALID: 'TENANT_BOT_TOKEN_INVALID',
  /** A real Ichancy signin with this operator's credentials failed, so it must not be activated. */
  TENANT_ICHANCY_UNREACHABLE: 'TENANT_ICHANCY_UNREACHABLE',
  /**
   * No `ichancyAgentId` was supplied, PlatformDefaults has none, and tenant zero has none either.
   * Ichancy's signin() returns only a token pair, so it can never be derived — somebody has to
   * name it.
   */
  TENANT_AGENT_ID_REQUIRED: 'TENANT_AGENT_ID_REQUIRED',
  /** `slug` and `currencyCode` are immutable after creation: both rewrite the meaning of old rows. */
  TENANT_FIELD_IMMUTABLE: 'TENANT_FIELD_IMMUTABLE',
} as const;

export type TenantErrorCode = (typeof TenantErrorCodes)[keyof typeof TenantErrorCodes];
