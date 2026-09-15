/**
 * Domain codes and fixed constants for staff administration. Same rules as every other code map:
 * SCREAMING_SNAKE, never renamed, never reused, no values encoded into the code itself.
 *
 * The scheduling constants at the bottom live here rather than beside the cron for the same reason
 * reconciliation.constants.ts holds AGENT_FLOAT_SYNC_INTERVAL_MS: an `@Interval` name has to be
 * unique across the whole SchedulerRegistry, and a name that is a literal buried in a class body is
 * a collision nobody can grep for.
 */
import type { AdminRole } from '@prisma/client';

export const AdminErrorCodes = {
  ADMIN_NOT_FOUND: 'ADMIN_NOT_FOUND',
  ADMIN_ALREADY_EXISTS: 'ADMIN_ALREADY_EXISTS',
  /** You cannot deactivate or demote yourself — see the guard in AdminUserService. */
  ADMIN_SELF_MODIFICATION: 'ADMIN_SELF_MODIFICATION',
  /** Refusing to remove the last way back into the system. */
  ADMIN_LAST_SUPER_ADMIN: 'ADMIN_LAST_SUPER_ADMIN',

  APPROVAL_LIMIT_NOT_FOUND: 'APPROVAL_LIMIT_NOT_FOUND',
  APPROVAL_LIMIT_INVALID: 'APPROVAL_LIMIT_INVALID',

  // ── Console sign-in (API-CONTRACT.md §2a). The console's login page switches on these. ──────
  //
  // BOT_CODE_INVALID and BOT_CODE_EXPIRED were this surface's codes for the bot-code door removed
  // on 2026-09-05. They are RETIRED here and must never be reused for anything else. (The player
  // app's own BOT_CODE_INVALID, in player.constants.ts, is a different, still-live route.)

  /** 401. No usable account holds this username and password. One sentence for every cause. */
  ADMIN_CREDENTIALS_INVALID: 'ADMIN_CREDENTIALS_INVALID',
  /** 409. Right password, several active operators. `details.operators`; retry with operatorSlug. */
  ADMIN_OPERATOR_AMBIGUOUS: 'ADMIN_OPERATOR_AMBIGUOUS',
  /** 403. Right password, but every operator it opens is SUSPENDED. `details.operators`. */
  ADMIN_OPERATOR_NOT_ACTIVE: 'ADMIN_OPERATOR_NOT_ACTIVE',
} as const;

export type AdminErrorCode = (typeof AdminErrorCodes)[keyof typeof AdminErrorCodes];

/**
 * Roles that may approve money movements AT ALL. A role outside this set is denied before any
 * ceiling is consulted, so "SUPPORT has no limit row configured" and "SUPPORT may never approve"
 * cannot be confused with one another.
 *
 * SUPER_ADMIN is listed EXPLICITLY rather than being implicitly granted everywhere: an implicit
 * god-role among the TENANT roles is exactly the thing that silently survives a permissions
 * refactor.
 *
 * PLATFORM_ADMIN is deliberately absent from this and every other role list: it is the owner
 * superset by contract, and that single exemption is applied in one place
 * (`@core/auth/admin-authority` `holdsAnyRole`) so these lists keep describing the tenant roles.
 */
export const APPROVER_ROLES: readonly AdminRole[] = Object.freeze([
  'SUPER_ADMIN',
  'FINANCE_ADMIN',
  'REVIEWER',
]);

/** Roles allowed to administer other admins and their ceilings. */
export const ADMIN_MANAGER_ROLES: readonly AdminRole[] = Object.freeze(['SUPER_ADMIN']);

/** Roles allowed to READ the staff directory and the configured limits. */
export const ADMIN_READER_ROLES: readonly AdminRole[] = Object.freeze([
  'SUPER_ADMIN',
  'FINANCE_ADMIN',
]);

// -------------------------------------------------------------------------------------------------
// The scheduled activity report — see services/report-schedule.cron.ts for the whole design.
// -------------------------------------------------------------------------------------------------

/** Registered name, so this `@Interval` cannot collide with another in the SchedulerRegistry. */
export const REPORT_SCHEDULE_INTERVAL_NAME = 'report-schedule';

/**
 * How often the cron WAKES UP — NOT how often it posts. `@Interval` needs a compile-time constant
 * and the cadence is operator-configurable (REPORT_SCHEDULE_HOURS), so the tick is fixed and cheap
 * (one Redis SET) and the marker it claims decides which wake-up is the one that posts.
 *
 * Ten minutes is therefore the RESOLUTION of the schedule: a report lands within ten minutes of its
 * due time. On a cadence measured in hours nobody can tell, and a shorter tick would only buy
 * precision nobody asked for at the cost of more Redis round trips forever.
 */
export const REPORT_SCHEDULE_TICK_MS = 10 * 60_000;

/** Just under the tick, so a lock left behind by a dead replica cannot swallow the next tick too. */
export const REPORT_SCHEDULE_LOCK_TTL_MS = 9 * 60_000;

/**
 * The "already posted" marker. Its EXISTENCE is the answer to "has the interval elapsed?" and its
 * TTL is the interval, so the fact survives a restart (which is what stops a redeploy re-posting)
 * and is shared by every replica (which is what stops two of them posting the same report).
 *
 * Namespaced by OPERATOR and by nothing else: each operator gets one scheduled report of its own
 * numbers, so one operator's post must never count as another's. Not by period or by chat: a key
 * that quietly varies with a setting is a key that stops de-duplicating the moment it changes.
 */
export const reportLastPostedKey = (tenantId: string): string =>
  `admin:report:last-posted:${tenantId}`;
