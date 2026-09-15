/**
 * Defense in depth against cross-tenant reads and writes. This is the SECOND line, not the first.
 *
 * The first line is every call site naming its operator: `findByIdInTenant(tenantId, id)`,
 * `{ id, tenantId }` in a unique selector, a composite key such as `tenantId_code`. The guard spec
 * next to this file (tenant-pinning.guard.spec.ts) fails the unit suite when a literal unique
 * selector on a scoped model names no tenant, so the compiler-invisible hole below is closed at
 * review time. This file is what still stands when a selector is built dynamically.
 *
 * ══ UNIQUE SELECTORS: WHY THEY ARE COVERED NOW ══════════════════════════════════════════════
 * Every scoped model's PRIMARY KEY is a bare uuid `id`, and `findUnique({ where: { id } })` /
 * `update({ where: { id } })` compile without a tenant and reach every operator's rows. Leaving them
 * out let one operator's SUPER_ADMIN reset another operator's passwords, and later put their own
 * wallet into another operator's live deposit rotation (POST .../payment-methods/:id/destinations
 * looked the method up by id alone). So `findUnique`, `findUniqueOrThrow`, `update`, `delete` and
 * `upsert` are handled here too. Prisma accepts non-unique fields next to the unique one in a
 * WhereUniqueInput, and 006_tenant_isolation.sql backs `(tenant_id, id)` with unique indexes, so
 * `{ id, tenantId }` is still a single-row index lookup: a row of another operator answers exactly
 * like a missing one, and ids cannot be probed.
 *
 * ══ LIST OPERATIONS ═════════════════════════════════════════════════════════════════════════
 * `prisma.player.findMany({ where: { status }})` compiles perfectly and returns every operator's
 * players. There is no type that catches it, it looks correct in development (one tenant), and it is
 * a data breach in production. The tenant filter is injected into those, as before.
 *
 * ══ WHAT HAPPENS TO AN UNPINNED UNIQUE SELECTOR ═════════════════════════════════════════════
 * Mode `throw` (tests): a unique selector on a scoped model that names no tenant, run inside a tenant
 * context, raises UnpinnedTenantAccessError. That is what makes a missed call site fail loudly in the
 * integration suite instead of silently working because the fixtures only had one operator.
 * Mode `inject` (every other environment): the effective tenant is added to the selector, and the
 * first occurrence per model and operation is logged. A crashed money job is the failure mode a
 * throw would buy in production, and the explicit call sites plus the guard spec are what make the
 * throw unnecessary there.
 *
 * With NO tenant context (a worker that has not yet read the row naming its operator, a CLI before
 * runWithTenant, a seed) nothing is injected: a wrong tenant would be worse than none. Those call
 * sites say what they mean with `acrossTenants(...)`, which the guard spec requires.
 *
 * ══ CREATES ═════════════════════════════════════════════════════════════════════════════════
 * A create whose `tenantId` differs from the effective tenant is the other half of the destination
 * defect: the tenant was copied off a row fetched by bare id, so both sides of the composite foreign
 * key landed in the victim's operator and the database had nothing to object to. Mode `throw` raises
 * CrossTenantWriteError; mode `inject` logs it once per model, because refusing a create in
 * production would abort whatever money transaction it belongs to.
 *
 * An explicit `tenantId` already in a `where` is NEVER overwritten — that is how a PLATFORM_ADMIN
 * reading another operator and `runWithTenant()` in a worker both keep working.
 */
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { getEffectiveTenantId } from '@core/tenant/tenant.storage';

/**
 * Models carrying a `tenant_id`. Kept as a literal set rather than derived from the DMMF so that
 * adding a scoped model without adding it here is a visible omission in review, not a silent one.
 *
 * MUST be kept in sync with the SCOPED list in prisma/schema.prisma. Exported for the guard spec,
 * which checks call sites against exactly this list.
 */
export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set([
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

/** Operations whose `where` is a plain filter rather than a unique selector. */
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

/** Operations addressed by a unique selector. See the header for why they are covered. */
export const UNIQUE_OPERATIONS: ReadonlySet<string> = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'update',
  'delete',
  'upsert',
]);

/**
 * The escape hatch for a query that genuinely spans operators — platform stats, the cross-tenant
 * reconciliation sweep, the outbox relay draining every tenant's messages, a worker loading the row
 * that will tell it which operator it works for.
 *
 * It is a symbol on the `where` object rather than a flag on the service so that it appears at the
 * exact call site it applies to, and so that grepping for it lists every cross-tenant access in the
 * codebase. Reviewers should treat each one as a security-relevant line.
 */
export const ALL_TENANTS = Symbol.for('prisma.allTenants');

/**
 * The way to spell that marker at a call site, in a filter or in a unique selector:
 *
 *   prisma.outboxMessage.findMany({ where: acrossTenants({ status: 'PENDING' }) })
 *   prisma.depositRequest.findUnique({ where: acrossTenants({ id: task.depositRequestId }) })
 *
 * WHY A HELPER AND NOT THE SYMBOL INLINE: Prisma's generated `*WhereInput` types are closed, so
 * `{ status, [ALL_TENANTS]: true }` fails the excess-property check and every call site would have
 * to annotate its way around it — which is how three different idioms for one idea appear in one
 * codebase. The cast lives here, once, with this comment next to it.
 *
 * The return type is the caller's own `T`, so nothing downstream loses type safety; the extension
 * strips the marker before Prisma ever sees the object.
 */
export function acrossTenants<T extends object>(where?: T): T {
  return { ...(where ?? ({} as T)), [ALL_TENANTS]: true };
}

export type UnpinnedAccessMode = 'throw' | 'inject';

export interface TenantScopeOptions {
  /** `throw` under NODE_ENV=test, `inject` everywhere else. See the header. */
  readonly onUnpinned: UnpinnedAccessMode;
}

/** A unique selector on a scoped model named no tenant while a tenant context was open. */
export class UnpinnedTenantAccessError extends Error {
  readonly code = 'TENANT_UNPINNED_ACCESS';

  constructor(
    readonly model: string,
    readonly operation: string,
  ) {
    super(
      `${model}.${operation} addressed a row by a unique key without naming its tenant. Put ` +
        '`tenantId` in the selector (the effective tenant, or the tenant of the row that led here), ' +
        'or wrap it in acrossTenants() when crossing operators is the point.',
    );
    this.name = 'UnpinnedTenantAccessError';
  }
}

/** A create named a tenant other than the effective one while a tenant context was open. */
export class CrossTenantWriteError extends Error {
  readonly code = 'TENANT_CROSS_WRITE';

  constructor(
    readonly model: string,
    readonly operation: string,
    readonly effectiveTenantId: string,
    readonly writtenTenantId: string,
  ) {
    super(
      `${model}.${operation} wrote tenant ${writtenTenantId} while running as tenant ` +
        `${effectiveTenantId}. Take the tenant from the context, or enter the target tenant with ` +
        'runWithTenant() when writing for another operator is the point.',
    );
    this.name = 'CrossTenantWriteError';
  }
}

interface MaybeScopedWhere {
  tenantId?: unknown;
  [ALL_TENANTS]?: boolean;
  [key: string]: unknown;
}

interface ScopableArgs {
  where?: MaybeScopedWhere;
  data?: unknown;
  create?: unknown;
  [key: string]: unknown;
}

/** What the extension decided, returned rather than executed so it can be unit-tested. */
export type ScopeDecision =
  | { kind: 'pass'; args: ScopableArgs | undefined }
  | { kind: 'rewrite'; args: ScopableArgs; notice?: string };

/** A selector naming the tenant directly, or through a composite key such as `tenantId_code`. */
function namesTenant(where: MaybeScopedWhere): boolean {
  if (where.tenantId !== undefined) return true;
  return Object.keys(where).some((key) => key.startsWith('tenantId_'));
}

/** The `tenantId` values a create writes, from `data` (object or array) or an upsert's `create`. */
function writtenTenantIds(operation: string, args: ScopableArgs): string[] {
  const payload = operation === 'upsert' ? args.create : args.data;
  const rows: unknown[] = Array.isArray(payload) ? payload : [payload];
  const ids: string[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const value = (row as { tenantId?: unknown }).tenantId;
    if (typeof value === 'string') ids.push(value);
  }
  return ids;
}

const CREATE_OPERATIONS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'upsert',
]);

/**
 * The whole policy, as a pure function of (model, operation, args, effective tenant, mode). The
 * extension below only executes what this returns.
 */
export function scopeQueryArgs(
  model: string,
  operation: string,
  rawArgs: unknown,
  tenantId: string | undefined,
  mode: UnpinnedAccessMode,
): ScopeDecision {
  const args = rawArgs as ScopableArgs | undefined;
  if (!TENANT_SCOPED_MODELS.has(model)) return { kind: 'pass', args };

  const isFiltered = FILTERED_OPERATIONS.has(operation);
  const isUnique = UNIQUE_OPERATIONS.has(operation);
  const where = args?.where;

  // Deliberate cross-tenant access, in a filter or a unique selector. Strip the marker so Prisma
  // never sees it. Nothing else is checked: saying so at the call site is the whole point.
  if ((isFiltered || isUnique) && where?.[ALL_TENANTS] === true) {
    const { [ALL_TENANTS]: _marker, ...rest } = where;
    return { kind: 'rewrite', args: { ...args, where: rest } };
  }

  // No context: a cron tick, a worker before it has read its row, a CLI or a seed. Injecting a wrong
  // tenant would be worse than injecting none.
  if (tenantId === undefined) return { kind: 'pass', args };

  if (CREATE_OPERATIONS.has(operation) && args !== undefined) {
    const foreign = writtenTenantIds(operation, args).find((written) => written !== tenantId);
    if (foreign !== undefined) {
      if (mode === 'throw') throw new CrossTenantWriteError(model, operation, tenantId, foreign);
      return {
        kind: 'rewrite',
        args,
        notice: `${model}.${operation} wrote tenant ${foreign} while running as tenant ${tenantId}`,
      };
    }
  }

  if (isFiltered) {
    // An explicit tenantId wins, always: a platform admin reading another operator, a worker
    // scoping a query by hand.
    if (where !== undefined && where.tenantId !== undefined) return { kind: 'pass', args };
    return { kind: 'rewrite', args: { ...args, where: { ...where, tenantId } } };
  }

  if (isUnique && where !== undefined) {
    if (namesTenant(where)) return { kind: 'pass', args };
    if (mode === 'throw') throw new UnpinnedTenantAccessError(model, operation);
    return {
      kind: 'rewrite',
      args: { ...args, where: { ...where, tenantId } },
      notice: `${model}.${operation} named no tenant; the effective tenant was added`,
    };
  }

  return { kind: 'pass', args };
}

export function createTenantScopeExtension(options: TenantScopeOptions) {
  const logger = new Logger('TenantScope');
  // One line per distinct notice: a hot path that misses its tenant would otherwise log per query.
  const noticed = new Set<string>();

  return Prisma.defineExtension({
    name: 'tenantScope',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          const decision = scopeQueryArgs(
            model,
            operation,
            args,
            getEffectiveTenantId(),
            options.onUnpinned,
          );
          if (decision.kind === 'pass') return query(args);

          if (decision.notice !== undefined) {
            const key = `${model}.${operation}:${decision.notice}`;
            if (!noticed.has(key)) {
              noticed.add(key);
              logger.warn(decision.notice);
            }
          }
          return query(decision.args as typeof args);
        },
      },
    },
  });
}
