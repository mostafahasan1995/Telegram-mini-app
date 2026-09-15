/**
 * Tenancy's own codes. Same rules as CommonErrorCodes: SCREAMING_SNAKE, never renamed, never
 * reused, and no values encoded into the code itself.
 *
 * WHAT IS DELIBERATELY NOT HERE: a bad bot token, a caller-chosen slug that is taken and a missing
 * agent id. The dashboard already answers those with the common codes (VALIDATION_FAILED 400 with
 * `details.fields`, DUPLICATE_RESOURCE 409 with `fields: ['slug']`, VALIDATION_FAILED naming
 * `ichancyAgentId`), and the console is built against them. TENANT_BOT_TOKEN_INVALID,
 * TENANT_SLUG_TAKEN, TENANT_AGENT_ID_REQUIRED and TENANT_ICHANCY_UNREACHABLE were defined for a
 * design that was lost, never thrown, and contradicted the dashboard, so they were removed before
 * anything could start throwing them.
 */
export const TenantErrorCodes = {
  /**
   * X-Tenant-Id named an operator that does not exist.
   *
   * A 400 and NOT a silent fallback to the caller's home tenant: swallowing it would show a
   * platform admin one operator's deposits while the screen said another's, with nothing anywhere
   * to reveal the mismatch. Loud is the only safe answer.
   *
   * Also the 404 of every `/v1/admin/tenants/:id` route whose id names no operator.
   */
  TENANT_NOT_FOUND: 'TENANT_NOT_FOUND',
  /** The operator exists but is SUSPENDED or CLOSED, so it is not serving requests. */
  TENANT_NOT_ACTIVE: 'TENANT_NOT_ACTIVE',
  /**
   * Refused a change of `ichancyAgentId` on an operator that already has players. Repointing an
   * agent under existing players orphans them from the tree their balances live in.
   */
  TENANT_AGENT_HAS_PLAYERS: 'TENANT_AGENT_HAS_PLAYERS',
  /** `slug` and `currencyCode` are immutable after creation: both rewrite the meaning of old rows. */
  TENANT_FIELD_IMMUTABLE: 'TENANT_FIELD_IMMUTABLE',
  /**
   * A CLOSED operator cannot be suspended or activated. Closing keeps its rows and stops it for
   * good; re-opening one is not a status flip anybody should be able to make from a dialog.
   */
  TENANT_CLOSED: 'TENANT_CLOSED',
  /**
   * Tenant zero is the platform, not an operator. Suspending it would lock every platform admin out
   * of sign-in (a suspended operator's staff are refused), leaving nobody able to undo it.
   */
  TENANT_PLATFORM_LOCKED: 'TENANT_PLATFORM_LOCKED',
  /**
   * Activation needs a real Ichancy sign-in with the operator's own credentials, and this deployment
   * cannot make one yet. A 503: the request was right, what is missing is the thing behind it.
   */
  TENANT_ACTIVATION_UNAVAILABLE: 'TENANT_ACTIVATION_UNAVAILABLE',
} as const;

export type TenantErrorCode = (typeof TenantErrorCodes)[keyof typeof TenantErrorCodes];
