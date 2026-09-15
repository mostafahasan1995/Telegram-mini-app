/**
 * Defense in depth against cross-tenant reads. This is the SECOND line, not the first.
 *
 * ══ WHAT THIS FILE DOES NOT COVER: UNIQUE SELECTORS ═════════════════════════════════════════
 * `findUnique`, `update` and `delete` are NOT rewritten here. The business unique keys are
 * composite — `@@unique([tenantId, code])`, `@@unique([tenantId, telegramUserId])` — so a lookup
 * through one of those has to name a tenant to compile. But every scoped model's PRIMARY KEY is a
 * bare uuid `id`, and `findUnique({ where: { id } })` / `update({ where: { id } })` compile
 * without one and reach every operator's rows. The compiler does not save you there. A lookup by
 * id must name the tenant itself — `findFirst({ where: { tenantId, id } })`, or `{ id, tenantId }`
 * in the unique selector — or compare `row.tenantId` before trusting the row
 * (AdminIdentityService.resolveById). A bare by-id lookup in the admin directory let one
 * operator's SUPER_ADMIN reset another operator's passwords; treat each one as a security bug.
 *
 * ══ WHAT IS LEFT, AND WHY IT NEEDS A RUNTIME GUARD ══════════════════════════════════════════
 * List and aggregate operations take a plain filter. `prisma.player.findMany({ where: { status }})`
 * compiles perfectly and returns every operator's players. There is no type that catches it, the
 * result looks correct in development (where there is one tenant), and it is a data breach in
 * production. So the LIST operations get the tenant filter injected here.
 *
 * ══ WHY IT INJECTS RATHER THAN THROWS ═══════════════════════════════════════════════════════
 * A throw would be louder, but it would also mean every worker, cron and seed had to be audited
 * before this could ship, and the failure mode of missing one is a crashed money job. Injecting is
 * the safe default; the explicit escape hatch below is for the rare query that genuinely spans
 * operators (platform stats, the reconciliation sweep).
 *
 * An explicit `tenantId` already in the `where` is NEVER overwritten — that is how a PLATFORM_ADMIN
 * reading another operator, and `runWithTenant()` in a worker, both keep working.
 */
import { Prisma } from '@prisma/client';

import { getEffectiveTenantId } from '@core/tenant/tenant.storage';

/**
 * Models carrying a `tenant_id`. Kept as a literal set rather than derived from the DMMF so that
 * adding a scoped model without adding it here is a visible omission in review, not a silent one.
 *
 * MUST be kept in sync with the SCOPED list in prisma/schema.prisma.
 */
const SCOPED_MODELS: ReadonlySet<string> = new Set([
  'PaymentMethod',
  'PaymentDestination',
  'Player',
  'PlayerSession',
  'AdminUser',
  'AdminApprovalLimit',
  'DepositRequest',
  'DepositProof',
  'DepositTransition',
  'LedgerAccount',
  'LedgerTransaction',
  'LedgerEntry',
  'OutboxMessage',
  'IdempotencyKey',
  'TelegramUpdate',
  'IchancyCall',
  'AuditLog',
  'ReconciliationBreak',
  'PlayerLimit',
  'SelfExclusion',
]);

/**
 * Operations whose `where` is a plain filter rather than a unique selector. Only these are
 * rewritten; the unique-selector operations are already covered by the composite keys.
 */
const FILTERED_OPERATIONS: ReadonlySet<string> = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'deleteMany',
]);

/**
 * The escape hatch for a query that genuinely spans operators — platform stats, the cross-tenant
 * reconciliation sweep, the outbox relay draining every tenant's messages.
 *
 * It is a symbol on the `where` object rather than a flag on the service so that it appears at the
 * exact call site it applies to, and so that grepping for it lists every cross-tenant read in the
 * codebase. Reviewers should treat each one as a security-relevant line.
 */
export const ALL_TENANTS = Symbol.for('prisma.allTenants')

/**
 * The way to spell that marker at a call site:
 *
 *   prisma.outboxMessage.findMany({ where: acrossTenants({ status: 'PENDING' }) })
 *
 * WHY A HELPER AND NOT THE SYMBOL INLINE: Prisma's generated `*WhereInput` types are closed, so
 * `{ status, [ALL_TENANTS]: true }` fails the excess-property check and every call site would have
 * to annotate its way around it — which is how three different idioms for one idea appear in one
 * codebase. The cast lives here, once, with this comment next to it.
 *
 * The return type is the caller's own `T`, so nothing downstream loses type safety; the extension
 * strips the marker before Prisma ever sees the object.
 *
 * Grepping `acrossTenants` lists every deliberately cross-operator read in the codebase. Treat each
 * one as a security-relevant line in review.
 */
export function acrossTenants<T extends object>(where?: T): T {
  return { ...(where ?? ({} as T)), [ALL_TENANTS]: true };
}

interface MaybeScopedWhere {
  tenantId?: unknown;
  [ALL_TENANTS]?: boolean;
}

export const tenantScopeExtension = Prisma.defineExtension({
  name: 'tenantScope',
  query: {
    $allModels: {
      $allOperations({ model, operation, args, query }) {
        if (!SCOPED_MODELS.has(model) || !FILTERED_OPERATIONS.has(operation)) {
          return query(args);
        }

        const typed = args as { where?: MaybeScopedWhere } | undefined;
        const where = typed?.where;

        // Deliberate cross-tenant read. Strip the marker so Prisma never sees it.
        if (where?.[ALL_TENANTS] === true) {
          const { [ALL_TENANTS]: _marker, ...rest } = where;
          return query({ ...typed, where: rest } as typeof args);
        }

        // An explicit tenantId wins, always. This is what lets a platform admin read another
        // operator and what lets a worker scope a query by hand.
        if (where !== undefined && where.tenantId !== undefined) {
          return query(args);
        }

        const tenantId = getEffectiveTenantId();
        // No context at all: a cron tick or a CLI command that never entered runWithTenant().
        // Injecting a wrong tenant would be worse than injecting none, and the ALL_TENANTS marker
        // exists for the queries that mean it, so this passes through untouched.
        if (tenantId === undefined) {
          return query(args);
        }

        return query({ ...typed, where: { ...where, tenantId } });
      },
    },
  },
});
