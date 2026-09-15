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
 * anything could start throwing them. TENANT_ACTIVATION_UNAVAILABLE (the 503 answered while
 * per-operator Ichancy sign-in did not exist) was retired when activation became a real sign-in; it
 * must not be reused.
 *
 * THE ACTIVATION REFUSALS: the contract and the MSW handlers name no code for a failed activation
 * sign-in, but the dashboard's console test (src/features/tenants/tenant-status-actions.test.tsx,
 * "surfaces the API message when that sign-in fails") answers `ICHANCY_SIGNIN_FAILED`. Ichancy's
 * definite refusal therefore uses that name. It is NOT that fixture's 502: the console's ApiError
 * treats every 5xx as retryable (src/lib/api/errors.ts `isRetryable`), and credentials Ichancy refused
 * fail identically on every retry, so it is a 422. The console branches on neither code nor status
 * here; it shows the message verbatim. The two cases that are not Ichancy's verdict keep their own
 * codes (TENANT_ICHANCY_UNAVAILABLE, TENANT_ICHANCY_UNCONFIGURED), and the credential edit (PATCH
 * /:id/ichancy) answers with the same three.
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
   * agent under existing players orphans them from the tree their balances live in. A 422 with
   * `details: { players }` (dashboard TENANT-OPERATIONS.md §6, detail 4).
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
   * of sign-in (a suspended operator's staff are refused), leaving nobody able to undo it. It also
   * has no Ichancy agent, so its credentials cannot be edited and it has no players to import.
   */
  TENANT_PLATFORM_LOCKED: 'TENANT_PLATFORM_LOCKED',
  /**
   * Ichancy definitively refused a real sign-in with the operator's credentials (a wrong username or
   * password, or a host this deployment's transport cannot reach). A 422: retrying the same
   * credentials gets the same answer; the fix is correcting them. Nothing was activated or saved.
   */
  ICHANCY_SIGNIN_FAILED: 'ICHANCY_SIGNIN_FAILED',
  /**
   * The sign-in could not complete: a timeout, a Cloudflare challenge, another process holding the
   * agent's session lock. A 503: nothing is known about the credentials, and the same request can
   * succeed later. Nothing was activated or saved.
   */
  TENANT_ICHANCY_UNAVAILABLE: 'TENANT_ICHANCY_UNAVAILABLE',
  /**
   * The operator's stored Ichancy details cannot be used at all: a placeholder username or agent id,
   * or a sealed password that does not open. A 422 whose fix is entering them from the dashboard.
   */
  TENANT_ICHANCY_UNCONFIGURED: 'TENANT_ICHANCY_UNCONFIGURED',
  /**
   * POST /:id/import-players while another import for the same operator holds its lock. A 409; the
   * dashboard's console test answers exactly this code and sentence.
   */
  IMPORT_ALREADY_RUNNING: 'IMPORT_ALREADY_RUNNING',
  /**
   * The operator's bot cannot be used for a reason waiting will not fix: no token set, a stored token
   * that does not open, or one Telegram rejects. A 422: the fix is a new token from the dashboard.
   * (A bad token SUBMITTED in a request is VALIDATION_FAILED instead, naming `botToken`.)
   */
  TENANT_BOT_UNAVAILABLE: 'TENANT_BOT_UNAVAILABLE',
  /**
   * Telegram answered a webhook or menu call with an error, for example a webhook URL it refuses. A
   * 422 whose message carries Telegram's own description, with any path token masked.
   */
  TENANT_TELEGRAM_REJECTED: 'TENANT_TELEGRAM_REJECTED',
  /** Telegram could not be reached, or timed out. A 503: the same request can succeed later. */
  TENANT_TELEGRAM_UNREACHABLE: 'TENANT_TELEGRAM_UNREACHABLE',
  /**
   * This deployment's API_BASE_URL is not https. Telegram delivers webhooks only over TLS, so
   * registering it could never deliver anything. A 422 that names the setting, not the operator.
   */
  TENANT_WEBHOOK_URL_NOT_HTTPS: 'TENANT_WEBHOOK_URL_NOT_HTTPS',
} as const;

export type TenantErrorCode = (typeof TenantErrorCodes)[keyof typeof TenantErrorCodes];
