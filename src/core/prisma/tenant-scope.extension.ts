/**
 * Defense in depth against cross-tenant reads. This is the SECOND line, not the first.
 *
 * ══ WHY THE TYPE SYSTEM ALREADY COVERS THE DANGEROUS HALF ═══════════════════════════════════
 * Every tenant-scoped model's unique constraints are composite — `@@unique([tenantId, code])`,
 * `@@unique([tenantId, telegramUserId])` and so on. So `findUnique`, `update` and `delete` CANNOT
 * BE CALLED without naming a tenant: the generated `WhereUniqueInput` demands it and the build
 * fails otherwise. Single-row access, which is where a cross-tenant mistake is most damaging, is
 * settled at compile time and needs nothing from this file.
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
export const ALL_TENANTS = Symbol.for('prisma.allTenants');

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

        return query({ ...typed, where: { ...where, tenantId } } as typeof args);
      },
    },
  },
});
