/**
 * The platform surface's own constants: audit verbs and the bounds the dashboard's tenant form
 * enforces.
 *
 * WHY THE BOUNDS ARE RESTATED HERE: the console validates before it sends, but a console is one
 * client among several and a PATCH from anything else must meet the same rules. The numbers are
 * copied from manager-account-dashboard src/features/tenants/tenant-form-dialog.tsx
 * (MIN_EXPIRY_MINUTES, MAX_EXPIRY_MINUTES, MAX_DISPLAY_NAME) so that a value the form accepts is
 * never refused here and a value refused here was never offered there.
 */

/** Stable `<entity>.<action>` verbs, the same shape every other audit row in this codebase uses. */
export const TenantAuditActions = {
  /** A PATCH /v1/admin/tenants/:id that changed at least one field. Lands in that operator's log. */
  TENANT_UPDATED: 'tenant.updated',
  /**
   * ACTIVE -> SUSPENDED. Lands in that operator's log, carrying the Ichancy fingerprint the operator
   * was serving with (see utils/resume.ts).
   */
  TENANT_SUSPENDED: 'tenant.suspended',
  /**
   * SUSPENDED -> ACTIVE. Lands in that operator's log. Its `$meta.verification` says how it was
   * allowed; today only RESUME_VERIFICATION exists, recorded with `signIn: false`.
   */
  TENANT_ACTIVATED: 'tenant.activated',
  /** POST /v1/admin/tenants inserted the row. Lands in the NEW operator's log. */
  TENANT_CREATED: 'tenant.created',
  /** What provisioning managed on create: booleans only, never a URL. The new operator's log. */
  TENANT_PROVISIONED: 'tenant.provisioned',
  /** The default payment rails were written for an operator. That operator's log. */
  TENANT_PAYMENT_METHODS_PROVISIONED: 'tenant.paymentMethods.provisioned',
  /** A webhook path token and/or secret was generated for an operator that had none usable. */
  TENANT_WEBHOOK_CREDENTIALS_GENERATED: 'tenant.webhook.credentialsGenerated',
  /** Telegram accepted setWebhook for the operator's bot. The URL is recorded with its token masked. */
  TENANT_WEBHOOK_REGISTERED: 'tenant.webhook.registered',
  /** Telegram accepted deleteWebhook for the operator's bot. Status is untouched. */
  TENANT_WEBHOOK_REMOVED: 'tenant.webhook.removed',
  /** The command menus were pushed through the operator's bot. */
  TENANT_BOT_MENUS_PUSHED: 'tenant.bot.menusPushed',
  /** PATCH /bot stored a new, verified bot token. Neither token is ever in the row. */
  TENANT_BOT_REPLACED: 'tenant.bot.replaced',
  /** The first read copied this deployment's env over the migration literals. Tenant zero's log. */
  PLATFORM_DEFAULTS_SEEDED: 'platform.defaults.seeded',
  /** A PATCH /v1/admin/platform-defaults that changed at least one field. Tenant zero's log. */
  PLATFORM_DEFAULTS_UPDATED: 'platform.defaults.updated',
} as const;

export const MIN_DEPOSIT_EXPIRY_MINUTES = 5;
export const MAX_DEPOSIT_EXPIRY_MINUTES = 1440;
export const MAX_DISPLAY_NAME_LENGTH = 120;
/** Generous for an https URL, and short enough that nobody stores a document in the column. */
export const MAX_URL_LENGTH = 2048;

/**
 * CSPRNG sizes of an operator's webhook credentials (dashboard docs/TENANT-OPERATIONS.md §1: "a
 * webhook path token (32 CSPRNG bytes) and a webhook secret (24)"). Both are base64url, so the path
 * token is a single URL-safe segment of 43 characters, which the webhook route's shape check and the
 * log redaction both match, and the secret fits Telegram's 1–256 [A-Za-z0-9_-] rule for secret_token.
 */
export const WEBHOOK_PATH_TOKEN_BYTES = 32;
export const WEBHOOK_SECRET_BYTES = 24;

/** How many derived slugs creation tries when concurrent creates keep taking the one it picked. */
export const SLUG_INSERT_ATTEMPTS = 5;

/**
 * provisioning.activationError until per-operator Ichancy sign-in exists. Activation was not
 * attempted, and the sentence says so rather than implying a sign-in failed.
 */
export const ACTIVATION_NOT_ATTEMPTED_MESSAGE =
  'Not activated: activating an operator signs in to Ichancy with its own stored credentials, and ' +
  'this deployment cannot make that sign-in yet. The operator stays suspended.';

/** provisioning.playersImportError: the import runs only after activation, which did not happen. */
export const PLAYERS_NOT_IMPORTED_MESSAGE =
  'Players were not imported: the operator was not activated. Import them from the operator once it is.';

/** health.ichancy.error until per-operator Ichancy sign-in exists. No sign-in was made. */
export const ICHANCY_HEALTH_UNAVAILABLE_MESSAGE =
  'Not checked: checking an Ichancy agent signs in with the operator’s own stored credentials, ' +
  'and this deployment cannot make that sign-in yet.';

/** PlatformDefaults is a singleton; prisma/sql/006 pins the id with a CHECK constraint. */
export const PLATFORM_DEFAULTS_ID = 1;

/**
 * How a resume is recorded: the operator was serving before its suspension and its Ichancy details
 * are unchanged since, so no sign-in was made. Never recorded as a verification.
 */
export const RESUME_VERIFICATION = 'resumed-previously-serving';

/**
 * What /activate answers, until per-operator Ichancy sign-in exists, for an operator that cannot be
 * resumed. Worded for the admin reading it in the activate dialog, which shows the API's message
 * verbatim.
 */
export const ACTIVATION_UNAVAILABLE_MESSAGE =
  'Activating an operator signs in to Ichancy with its own stored credentials, and this ' +
  'deployment cannot make that sign-in yet. Only an operator that was serving before it was ' +
  'suspended, with its Ichancy details unchanged since, can be resumed now. The operator stays ' +
  'suspended and nothing was changed.';
