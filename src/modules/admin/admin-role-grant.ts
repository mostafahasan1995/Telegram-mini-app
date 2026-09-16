/**
 * Who may hand out which role in the staff directory (API-CONTRACT.md §3, the `mayGrantRole` rule;
 * mirrored by the console's `mayGrantRole` in src/lib/auth/permissions.ts).
 *
 * ══ WHAT THIS DOES NOT DECIDE ════════════════════════════════════════════════════════════════
 * Whether the actor may write staff AT ALL. That is `admins.write` (SUPER_ADMIN, and PLATFORM_ADMIN as
 * the owner superset), enforced by RolesGuard before any service code runs. This answers only the
 * question the capability table cannot: given that you may write staff, may you grant THIS role?
 *
 * ══ WHY PLATFORM_ADMIN IS THE ONE ROLE WITH A RULE ═══════════════════════════════════════════
 * Every other role is scoped to one operator, so a SUPER_ADMIN handing out SUPER_ADMIN inside their own
 * operator grants nothing they do not already hold. PLATFORM_ADMIN reaches ACROSS operators. The
 * contract restricts it twice: the actor must already be platform staff, AND must be working in tenant
 * zero with no X-Tenant-Id. A platform admin who has switched into an operator is refused, because the
 * row would land inside that operator as a tenant-scoped login holding platform authority
 * (prisma/sql/006 would also refuse the insert, but as a 500 with no explanation).
 *
 * Framework-free, so the rule is unit-tested as a table and read the same way the console reads it.
 */
import type { AdminRole } from '@prisma/client';

import { isPlatformStaff, type AdminAuthoritySubject } from '@core/auth/admin-authority';

/**
 * `effectiveTenantId` is whose staff the request writes. It equals the actor's HOME tenant exactly
 * when no X-Tenant-Id override moved it, which is the contract's "operating with no tenant override".
 */
export function mayGrantRole(
  actor: AdminAuthoritySubject,
  role: AdminRole,
  effectiveTenantId: string,
): boolean {
  if (role !== 'PLATFORM_ADMIN') return true;
  return isPlatformStaff(actor) && effectiveTenantId === actor.tenantId;
}
