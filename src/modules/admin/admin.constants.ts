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
} as const;

export type AdminErrorCode = (typeof AdminErrorCodes)[keyof typeof AdminErrorCodes];

/**
 * Roles that may approve money movements AT ALL. A role outside this set is denied before any
 * ceiling is consulted, so "SUPPORT has no limit row configured" and "SUPPORT may never approve"
 * cannot be confused with one another.
 *
 * SUPER_ADMIN is listed EXPLICITLY rather than being implicitly granted everywhere: an implicit
 * god-role is exactly the thing that silently survives a permissions refactor.
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
 * Not namespaced by period or by chat: there is exactly ONE scheduled report in this system, and a
 * key that quietly varies is a key that stops de-duplicating the moment a setting changes.
 */
export const REPORT_LAST_POSTED_KEY = 'admin:report:last-posted';
