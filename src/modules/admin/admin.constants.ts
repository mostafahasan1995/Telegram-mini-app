/**
 * Domain codes for staff administration. Same rules as every other code map: SCREAMING_SNAKE,
 * never renamed, never reused, no values encoded into the code itself.
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
