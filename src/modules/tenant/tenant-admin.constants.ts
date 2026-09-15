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
