/**
 * The platform surface's own constants: audit verbs, the bounds the dashboard's tenant form
 * enforces, and the few sentences the operator-operations routes answer with.
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
  /** ACTIVE -> SUSPENDED. Lands in that operator's log. */
  TENANT_SUSPENDED: 'tenant.suspended',
  /**
   * SUSPENDED -> ACTIVE after a real Ichancy sign-in with the operator's own credentials. Lands in
   * that operator's log, with `$meta.verification: 'signin'`, `signIn: true` and which adapter
   * answered (`real`, or `fake` under ICHANCY_FAKE).
   */
  TENANT_ACTIVATED: 'tenant.activated',
  /** An activation whose sign-in did not prove the credentials. The code only, never a credential. */
  TENANT_ACTIVATION_REFUSED: 'tenant.activation.refused',
  /** PATCH /:id/ichancy saved credentials a real sign-in had just accepted. The password is never in it. */
  TENANT_ICHANCY_UPDATED: 'tenant.ichancy.updated',
  /**
   * A PATCH /:id/ichancy that saved nothing: the refusal's code, the names of the fields it tried to
   * change and, when it tried to move the operator, the ORIGIN it named. Never a credential. It exists
   * because a refused edit still sent a sign-in somewhere, and the only other trace of that attempt
   * (the ichancy_calls row) records no host.
   */
  TENANT_ICHANCY_UPDATE_REFUSED: 'tenant.ichancy.update.refused',
  /** An import of the operator's existing Ichancy players ran. Counts only. That operator's log. */
  TENANT_PLAYERS_IMPORTED: 'tenant.players.imported',
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

/** How an activation or a credential edit was proven: a real sign-in, never a stored session. */
export const SIGNIN_VERIFICATION = 'signin';

/** provisioning.playersImportError: the import runs only after activation, which did not happen. */
export const PLAYERS_NOT_IMPORTED_MESSAGE =
  'Players were not imported: the operator was not activated. Import them from the operator once it is.';

/**
 * The refusal of an activation (and provisioning's `activationError`) while no staff group is bound.
 * Checked before any Ichancy sign-in: the answer does not depend on the credentials.
 */
export const STAFF_GROUP_REQUIRED_MESSAGE =
  "This operator has no staff group yet, so it cannot be activated: its deposit review cards and alerts would go nowhere. Add its bot to the staff group from the operator's page, then activate it. The operator stays suspended.";

/** provisioning.activationError when something other than Ichancy's answer stopped the attempt. */
export const ACTIVATION_FAILED_UNEXPECTEDLY_MESSAGE =
  'Activation failed: an unexpected error occurred on this server. Activate the operator from its page.';

/** provisioning.playersImportError when the import itself threw. */
export const IMPORT_FAILED_UNEXPECTEDLY_MESSAGE =
  "The import failed: an unexpected error occurred on this server. Import the players from the operator's page.";

/** The dashboard's own sentence for 409 IMPORT_ALREADY_RUNNING (src/features/tenants tests). */
export const IMPORT_ALREADY_RUNNING_MESSAGE = 'An import is already running for this operator.';

/**
 * health.ichancy.error under ICHANCY_FAKE. Health answers `ok: false` with this sentence and
 * `fake: true` instead of asking the fake adapter, because the fake answers every wallet read with a
 * made-up float: an `ok: true` beside a plausible number was read on a laptop as a working connection
 * to a real agent, which is the one conclusion a fixture must never support.
 */
export const ICHANCY_FAKE_MODE_MESSAGE =
  'Ichancy is in fake mode (ICHANCY_FAKE=true): no real connection was made.';

/** health.ichancy.error, and every credential refusal, for tenant zero. */
export const PLATFORM_HAS_NO_AGENT_MESSAGE =
  'Tenant zero is the platform, not an operator: it has no Ichancy agent.';

/**
 * One page of the agent's players per request. Paging keeps each round trip small (Cloudflare treats
 * a huge answer no better than a small one) and lets an outage part-way keep what it already wrote.
 */
export const IMPORT_PAGE_SIZE = 100;
/**
 * A SAFETY bound on the players one run reads, not the expected size of an agent: a run normally ends
 * at Ichancy's first short page. It exists so a listing that never ends (an API that ignores `start`
 * and answers the same full page forever) cannot hold the lock and the request for ever. A run that
 * reaches it says so in `error`, and the next run resumes where it stopped (see the cursor below), so
 * no agent is ever too big to import — it only takes more than one run.
 */
export const IMPORT_MAX_PLAYERS_PER_RUN = 50_000;

/** The import's paging, injectable so a test can page an agent of five players. */
export interface PlayerImportLimits {
  readonly pageSize: number;
  readonly maxPlayersPerRun: number;
}
export const TENANT_IMPORT_LIMITS = 'TENANT_IMPORT_LIMITS';
export const DEFAULT_PLAYER_IMPORT_LIMITS: PlayerImportLimits = {
  pageSize: IMPORT_PAGE_SIZE,
  maxPlayersPerRun: IMPORT_MAX_PLAYERS_PER_RUN,
};

/**
 * The lock's lease, renewed after every page. So it bounds how long ONE page may take, not the whole
 * run: a large agent keeps its lock for as long as pages keep arriving, and a crashed holder releases
 * within this. A run that loses its lease stops and says so rather than race a second run.
 */
export const IMPORT_LOCK_TTL_MS = 15 * 60_000;
/** LockService.key('tenant', 'import-players', id): one import per operator, cluster-wide. */
export const importPlayersLockKey = (tenantId: string): string =>
  `lock:tenant:import-players:${tenantId}`;

/**
 * Where a run that stopped early (the safety bound, an Ichancy failure, a lost lease) records the
 * offset it had reached, so the next run continues there instead of re-reading the same first pages
 * for ever. Cleared by a run that reaches the end. It resumes one page EARLY: if players were removed
 * at Ichancy in between and the listing shifted back, the overlap re-reads rows (counted `existing`)
 * rather than skipping one. A week, because a cursor older than that describes a listing that has
 * moved on; starting again from 0 is always correct, only slower.
 */
export const IMPORT_CURSOR_TTL_SECONDS = 7 * 24 * 60 * 60;
export const importPlayersCursorKey = (tenantId: string): string =>
  `tenant:import-players:cursor:v1:${tenantId}`;

/** `error` of a run that reached the safety bound. */
export const importStoppedAtBoundMessage = (scanned: number): string =>
  `The import stopped after reading ${String(scanned)} players, the most one run reads. ` +
  'Run it again to continue from where it stopped.';

/** `error` of a run whose lock lease was lost between pages. */
export const importLeaseLostMessage = (scanned: number): string =>
  `The import stopped after reading ${String(scanned)} players because its lock expired. ` +
  'Run it again to continue from where it stopped.';

/**
 * `error` when players were left out because another operator shares this login under another
 * agent id and Ichancy did not say which agent id they hang off. Importing them would hand one
 * operator's players (logins and emails) to another.
 */
export const importUnattributedMessage = (skipped: number, sharedWith: readonly string[]): string =>
  `${String(skipped)} ${skipped === 1 ? 'player was' : 'players were'} not imported: this Ichancy login is shared with ` +
  `${sharedWith.join(', ')} under another agent id, and Ichancy did not say which agent id they ` +
  'belong to.';

/**
 * `error` when players were left out because another operator on the same login AND agent id already
 * holds them. Both rows would be ACTIVE and point at one Ichancy wallet, so once a Telegram account is
 * attached to each, one wallet could be credited from two operators' books. Which operator owns such a
 * player is a decision for a person, not for an import.
 */
export const importHeldElsewhereMessage = (skipped: number, heldBy: readonly string[]): string =>
  `${String(skipped)} ${skipped === 1 ? 'player was' : 'players were'} not imported: ` +
  `${heldBy.join(', ')} already ${heldBy.length === 1 ? 'holds' : 'hold'} ${skipped === 1 ? 'it' : 'them'} ` +
  'under the same Ichancy login and agent id. Decide which operator owns them before importing them here.';

/**
 * The refusal of a PATCH /:id/ichancy that moves the operator to another Ichancy host without sending
 * the password. Signing in there with the STORED password would hand the sealed agent password, which
 * controls a real-money float, to whatever host the request named.
 */
export const HOST_MOVE_NEEDS_PASSWORD_FIELD =
  'ichancyPassword is required when ichancyBaseUrl moves the operator to another host; the stored password is only ever sent to the stored host';

/**
 * How long one operator's Ichancy health answer is reused. The console does not poll (it asks when
 * someone looks, `refetchInterval: false`), but a detail panel re-rendered, or two admins looking at
 * once, must not each cost a wallet read — and, for an operator with no stored session, a sign-in
 * that rotates the agent's tokens. Thirty seconds bounds that to two per minute per operator while
 * still showing a credential fix almost at once; a PATCH or an activation drops the entry anyway.
 */
export const ICHANCY_HEALTH_CACHE_SECONDS = 30;
export const ichancyHealthCacheKey = (tenantId: string): string =>
  `tenant:ichancy-health:v1:${tenantId}`;

/** PlatformDefaults is a singleton; prisma/sql/006 pins the id with a CHECK constraint. */
export const PLATFORM_DEFAULTS_ID = 1;
