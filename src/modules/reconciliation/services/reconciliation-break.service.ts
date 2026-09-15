/**
 * The write side of reconciliation: opening, re-observing and resolving breaks.
 *
 * WHY upsert-by-dedupeKey and not insert: every detector here runs on a schedule, so the SAME
 * finding is re-observed on every tick. Inserting each time would bury the one new problem under a
 * hundred copies of an old one. The dedupe key is UNIQUE PER TENANT, so the database — not the
 * application — is what makes "one row per finding" true under concurrency.
 *
 * WHY the key is scoped to an operator rather than global: two operators can hit the same finding
 * — the same invariant, on the same day, for the same currency — and a global key would let the
 * first one's break swallow the second's. Each operator has to see its own money problem, so every
 * read and write here names a tenant.
 *
 * WHY a re-observation never re-opens a RESOLVED row: a human decided that finding was dealt with.
 * If the underlying condition is genuinely still there, the next tick's numbers will differ and the
 * detector's key will differ with them (see reconciliation.constants). Silently flipping a resolved
 * break back to OPEN would make "resolved" mean nothing.
 */
import { Injectable, Logger } from '@nestjs/common';
import { BreakCategory, BreakStatus, Prisma, type ReconciliationBreak } from '@prisma/client';

import type { AuthenticatedAdmin } from '@common/decorators/auth.types';
import { BusinessRuleError, NotFoundError } from '@common/exceptions/app.exception';
import { adminActor } from '@common/types/actor.type';
import { AuditService } from '@core/audit/audit.service';
import { toNullableJson } from '@core/queue/json.util';
import { PrismaService } from '@core/prisma/prisma.service';
import type { Tx } from '@core/prisma/tx.type';
import { requireEffectiveTenantId } from '@core/tenant';

import { ReconciliationErrorCodes } from '../enums/reconciliation-error-code.enum';

export interface OpenBreakInput {
  /**
   * The operator whose books the finding is about. A detector that already knows — because it was
   * handed a destination, a player or a ledger account — MUST pass it, since the row it examined is
   * more authoritative than whatever context the sweep happens to be standing in. Omitting it falls
   * back to the ambient tenant, which is correct for a detector running inside `runWithTenant()`
   * for one operator and a loud error for one that forgot to enter a context at all.
   */
  tenantId?: string;
  category: BreakCategory;
  severity: number;
  currencyCode: string;
  dedupeKey: string;
  expectedMinor?: bigint | null;
  actualMinor?: bigint | null;
  depositRequestId?: string | null;
  playerId?: string | null;
  ledgerAccountId?: string | null;
  ichancyCallId?: string | null;
  detail?: Record<string, unknown>;
}

export interface ResolveBreakInput {
  breakId: string;
  admin: AuthenticatedAdmin;
  status: Extract<BreakStatus, 'RESOLVED' | 'WRITTEN_OFF' | 'FALSE_POSITIVE'>;
  note: string;
  /** The compensating ledger transaction that closed it, when there was one. */
  resolutionTxId?: string;
}

@Injectable()
export class ReconciliationBreakService {
  private readonly logger = new Logger(ReconciliationBreakService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Record a finding. Returns the row, whether it was created now or is being re-observed.
   *
   * The `where` on the update deliberately does NOT filter by status: an OPEN or INVESTIGATING break
   * gets its numbers refreshed (an operator wants the CURRENT delta, not the one from three hours
   * ago), while a terminal one is left exactly as the human left it.
   */
  async observe(tx: Tx, input: OpenBreakInput): Promise<ReconciliationBreak> {
    const delta =
      input.actualMinor === undefined ||
      input.actualMinor === null ||
      input.expectedMinor === undefined ||
      input.expectedMinor === null
        ? null
        : input.actualMinor - input.expectedMinor;

    const detail = toNullableJson(input.detail);
    const tenantId = input.tenantId ?? requireEffectiveTenantId();

    return tx.reconciliationBreak.upsert({
      // The dedupe key is only unique within an operator, so the tenant is half of the key that
      // decides "new finding" from "same finding again".
      where: { tenantId_dedupeKey: { tenantId, dedupeKey: input.dedupeKey } },
      create: {
        tenantId,
        category: input.category,
        status: BreakStatus.OPEN,
        severity: input.severity,
        currencyCode: input.currencyCode,
        dedupeKey: input.dedupeKey,
        expectedMinor: input.expectedMinor ?? null,
        actualMinor: input.actualMinor ?? null,
        deltaMinor: delta,
        depositRequestId: input.depositRequestId ?? null,
        playerId: input.playerId ?? null,
        ledgerAccountId: input.ledgerAccountId ?? null,
        ichancyCallId: input.ichancyCallId ?? null,
        detail,
      },
      update: this.refreshFor(input, delta, detail),
    });
  }

  /**
   * A re-observation refreshes the NUMBERS and nothing else. `status`, `resolvedAt`,
   * `resolvedByAdminId`, `resolutionNote` and `assignedToAdminId` are deliberately absent from this
   * object, so a break a human has already closed keeps every field that human wrote — an upsert
   * that touched `status` would silently re-open resolved work on the next tick.
   */
  private refreshFor(
    input: OpenBreakInput,
    delta: bigint | null,
    detail: Prisma.InputJsonValue | typeof Prisma.DbNull,
  ): Prisma.ReconciliationBreakUpdateInput {
    return {
      severity: input.severity,
      expectedMinor: input.expectedMinor ?? null,
      actualMinor: input.actualMinor ?? null,
      deltaMinor: delta,
      detail,
      // detectedAt is NOT touched: it is when the problem first appeared, which is the number an
      // operator uses to judge how long it has been ignored.
    };
  }

  /** Same, in its own transaction, for detectors that have nothing else to write. */
  async observeStandalone(input: OpenBreakInput): Promise<ReconciliationBreak> {
    return this.prisma.runInTransaction((tx) => this.observe(tx, input));
  }

  /**
   * One break, in the effective operator. Another operator's break id is BREAK_NOT_FOUND, exactly
   * like an id that never existed: its money figures and the deposit and player ids in it are the
   * reconnaissance for reading that operator's deposits.
   */
  async getInTenant(breakId: string): Promise<ReconciliationBreak> {
    const row = await this.prisma.reconciliationBreak.findUnique({
      where: { id: breakId, tenantId: requireEffectiveTenantId() },
    });
    if (row === null) {
      throw new NotFoundError(
        ReconciliationErrorCodes.BREAK_NOT_FOUND,
        'That reconciliation break does not exist.',
      );
    }
    return row;
  }

  async resolve(input: ResolveBreakInput): Promise<ReconciliationBreak> {
    return this.prisma.runInTransaction(async (tx) => {
      // EFFECTIVE, not `input.admin.tenantId`: the principal carries the admin's HOME tenant, which
      // for a PLATFORM_ADMIN is tenant zero and holds no breaks at all. Writing the filter out by
      // hand matters because `findUnique` is deliberately NOT covered by the tenant-scope
      // extension — without it, a break id from another operator would resolve and close here.
      const tenantId = requireEffectiveTenantId();
      const existing = await tx.reconciliationBreak.findUnique({
        where: { id: input.breakId, tenantId },
      });
      if (existing === null) {
        throw new NotFoundError(
          ReconciliationErrorCodes.BREAK_NOT_FOUND,
          'That reconciliation break does not exist.',
        );
      }
      if (
        existing.status === BreakStatus.RESOLVED ||
        existing.status === BreakStatus.WRITTEN_OFF ||
        existing.status === BreakStatus.FALSE_POSITIVE
      ) {
        throw new BusinessRuleError(
          ReconciliationErrorCodes.BREAK_ALREADY_RESOLVED,
          'That break has already been closed.',
          { status: existing.status },
        );
      }

      const updated = await tx.reconciliationBreak.update({
        where: { id: input.breakId, tenantId },
        data: {
          status: input.status,
          resolvedAt: new Date(),
          resolvedByAdminId: input.admin.adminUserId,
          resolutionNote: input.note,
          resolutionTxId: input.resolutionTxId ?? null,
        },
      });

      await this.audit.write(tx, {
        action: 'reconciliation.break.resolve',
        actor: adminActor(input.admin.adminUserId),
        subjectType: 'ReconciliationBreak',
        subjectId: input.breakId,
        before: { status: existing.status },
        after: { status: input.status, resolutionTxId: input.resolutionTxId ?? null },
        ...(existing.deltaMinor === null ? {} : { amountMinor: existing.deltaMinor }),
        metadata: { note: input.note, category: existing.category },
      });

      this.logger.log(
        `break ${input.breakId} (${existing.category}) closed as ${input.status} by ${input.admin.displayName}`,
      );
      return updated;
    });
  }

  async assign(breakId: string, admin: AuthenticatedAdmin): Promise<ReconciliationBreak> {
    return this.prisma.runInTransaction(async (tx) => {
      // Same reasoning as resolve(): the tenant is part of the selector, so an id belonging to
      // another operator misses and raises rather than quietly taking their break.
      const updated = await tx.reconciliationBreak.update({
        where: { id: breakId, tenantId: requireEffectiveTenantId() },
        data: { assignedToAdminId: admin.adminUserId, status: BreakStatus.INVESTIGATING },
      });
      await this.audit.write(tx, {
        action: 'reconciliation.break.assign',
        actor: adminActor(admin.adminUserId),
        subjectType: 'ReconciliationBreak',
        subjectId: breakId,
        after: { assignedToAdminId: admin.adminUserId, status: BreakStatus.INVESTIGATING },
      });
      return updated;
    });
  }
}
