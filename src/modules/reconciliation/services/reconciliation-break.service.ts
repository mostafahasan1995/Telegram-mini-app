/**
 * The write side of reconciliation: opening, re-observing and resolving breaks.
 *
 * WHY upsert-by-dedupeKey and not insert: every detector here runs on a schedule, so the SAME
 * finding is re-observed on every tick. Inserting each time would bury the one new problem under a
 * hundred copies of an old one. The dedupe key is a UNIQUE column, so the database — not the
 * application — is what makes "one row per finding" true under concurrency.
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

import { ReconciliationErrorCodes } from '../enums/reconciliation-error-code.enum';

export interface OpenBreakInput {
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

    return tx.reconciliationBreak.upsert({
      where: { dedupeKey: input.dedupeKey },
      create: {
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

  async resolve(input: ResolveBreakInput): Promise<ReconciliationBreak> {
    return this.prisma.runInTransaction(async (tx) => {
      const existing = await tx.reconciliationBreak.findUnique({ where: { id: input.breakId } });
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
        where: { id: input.breakId },
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
      const updated = await tx.reconciliationBreak.update({
        where: { id: breakId },
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
