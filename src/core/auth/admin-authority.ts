/**
 * The one answer to "does this admin hold one of these roles?", shared by RolesGuard, the
 * approval-limit evaluator and the few services that re-check a role list inside a transaction.
 *
 * ══ WHY PLATFORM_ADMIN SATISFIES EVERY ROLE LIST ═════════════════════════════════════════════
 * The dashboard contract makes it the owner superset, by the operator's explicit decision:
 *
 *   "`PLATFORM_ADMIN` runs the _platform_ (tenants) **and is the owner superset**: by the
 *    operator's explicit decision it holds every capability every other role holds, plus the
 *    platform-level ones. [...] Its money decisions are unbounded by an approval limit (the
 *    backend `RolesGuard` and the approval-limit evaluator both exempt it) and still land in the
 *    ledger and the audit trail like anybody else's."
 *                          — manager-account-dashboard/docs/API-CONTRACT.md §3 Roles
 *
 * and the console mirrors it as `PLATFORM_ADMIN: withCapabilities(...CAPABILITIES)` in
 * src/lib/auth/permissions.ts ("PLATFORM_ADMIN now satisfies every role list").
 *
 * Keeping the rule here, rather than adding PLATFORM_ADMIN to every `*_ROLES` constant, is what
 * stops a new role list from quietly leaving the owner out — and what keeps the lists themselves
 * readable as the TENANT role model they always were.
 *
 * ══ WHY THE ROLE ALONE IS NOT ENOUGH ═════════════════════════════════════════════════════════
 * The superset belongs to platform STAFF, and platform staff is PLATFORM_ADMIN *homed in tenant
 * zero* — the same two-part test TenantOverrideInterceptor applies before honouring X-Tenant-Id.
 * prisma/sql/006 refuses to write a PLATFORM_ADMIN row anywhere else; this makes such a row worth
 * nothing if one ever exists (it is then matched exactly, like any other role, and no route lists
 * PLATFORM_ADMIN outside the tenant-zero surfaces).
 */
import type { AdminRole } from '@prisma/client';

import { TENANT_ZERO_ID } from '../tenant/tenant.constants';

/** Structural, so the request principal, a raw `AdminUser` row and a test fake all satisfy it. */
export interface AdminAuthoritySubject {
  readonly role: AdminRole;
  /** The HOME tenant — the one the admin row lives in, never an X-Tenant-Id override. */
  readonly tenantId: string;
}

/** PLATFORM_ADMIN whose row lives in tenant zero: the owner superset. */
export function isPlatformStaff(admin: AdminAuthoritySubject): boolean {
  return admin.role === 'PLATFORM_ADMIN' && admin.tenantId === TENANT_ZERO_ID;
}

/**
 * True when the admin's role is listed, or when the admin is platform staff.
 *
 * An EMPTY list is not a wildcard here: "no roles may do this" stays "no roles", and only the
 * owner superset passes it. Callers that mean "any admin" do not call this at all.
 */
export function holdsAnyRole(admin: AdminAuthoritySubject, roles: readonly AdminRole[]): boolean {
  return roles.includes(admin.role) || isPlatformStaff(admin);
}
