/**
 * Decides whether an admin may release a given amount on their own.
 *
 * WHY `tx` is the FIRST argument even though this only READS: the answer must be computed against
 * the same snapshot as the write it authorizes. Evaluating outside the caller's transaction opens a
 * window where two approvals each see the same daily total, and both pass a ceiling that only one
 * of them should have — the classic double-spend of an authorization budget. Passing the tx makes
 * the check and the decision one atomic act.
 *
 * WHY it FAILS CLOSED when no limit row exists: an admin with no configured ceiling is an admin
 * nobody has decided how much to trust. Treating that as "unlimited" would mean the safest possible
 * configuration (an empty limits table on a fresh install) grants everyone infinite authority.
 *
 * WHY the daily total is summed in JS and not with Prisma's `_sum`: the amount that counts against
 * the budget is `verifiedAmountMinor ?? claimedAmountMinor`, and an aggregate cannot coalesce two
 * columns. The row count per admin per day is bounded by how fast a human can click, so reading the
 * rows is cheap and — unlike a clever SQL expression — obviously correct.
 */
import { Injectable } from '@nestjs/common';
import type { AdminApprovalLimit, AdminRole, DepositStatus } from '@prisma/client';

import { AppConfigService } from '@core/config/config.service';
import { PrismaService } from '@core/prisma/prisma.service';
import { AuditService } from '@core/audit/audit.service';
import { isUniqueConstraintError } from '@core/prisma/prisma-errors';
import type { Tx } from '@core/prisma/tx.type';
import { formatMinorToDecimal, sumMinor } from '@common/helpers/money.util';
import { adminActor } from '@common/types/actor.type';
import { ConflictError, NotFoundError, ValidationError } from '@common/exceptions/app.exception';

import { AdminErrorCodes, APPROVER_ROLES } from '../admin.constants';
import { AdminApprovalLimitRepository } from '../repositories/admin-approval-limit.repository';
import { AdminUserRepository } from '../repositories/admin-user.repository';
import type { ApprovalLimitView, SetApprovalLimitDto } from '../dtos/approval-limit.dto';
import { toMinorOrNull, toMinorOrThrow } from '../utils/money-input.util';

/** The contract every approval path switches on. */
export type ApprovalDecision = 'ALLOWED' | 'NEEDS_SECOND' | 'DENIED';

export type ApprovalReason =
  | 'WITHIN_LIMITS'
  | 'ABOVE_DUAL_THRESHOLD'
  | 'ROLE_MAY_NOT_APPROVE'
  | 'NO_ACTIVE_LIMIT'
  | 'ABOVE_SINGLE_CEILING'
  | 'ABOVE_DAILY_CEILING'
  | 'INVALID_AMOUNT';

/** Enough to explain the decision on an admin card and in an audit row. */
export interface ApprovalEvaluation {
  decision: ApprovalDecision;
  reason: ApprovalReason;
  amountMinor: bigint;
  /** Null when no limit row applies. */
  maxSingleApprovalMinor: bigint | null;
  maxDailyApprovalMinor: bigint | null;
  /** Already approved by this admin today, in the same currency. */
  dailyUsedMinor: bigint;
  /** The threshold actually applied — the per-admin override, or the global default. */
  secondApprovalAboveMinor: bigint;
}

/** Structural, so both `AuthenticatedAdmin` and a raw `AdminUser` row satisfy it. */
export interface ApprovingAdmin {
  readonly adminUserId: string;
  readonly role: AdminRole;
}

/**
 * Statuses in which an earlier approval still STANDS, and therefore still consumes today's budget.
 *
 * CREDIT_FAILED and REVERSED are excluded on purpose: in both, the authority was exercised but no
 * money ended up with the player, and holding a failed credit against an admin's daily ceiling
 * would punish them for an upstream outage. REJECTED/EXPIRED never authorized anything.
 */
const APPROVAL_CONSUMING_STATUSES: readonly DepositStatus[] = Object.freeze([
  'PENDING_SECOND_APPROVAL',
  'APPROVED',
  'CREDITING',
  'CREDITED',
  'NEEDS_RECONCILIATION',
]);

export function toApprovalLimitView(limit: AdminApprovalLimit): ApprovalLimitView {
  return {
    id: limit.id,
    adminUserId: limit.adminUserId,
    currencyCode: limit.currencyCode,
    maxSingleApproval: formatMinorToDecimal(limit.maxSingleApprovalMinor),
    maxDailyApproval: formatMinorToDecimal(limit.maxDailyApprovalMinor),
    secondApprovalAbove:
      limit.secondApprovalAboveMinor === null
        ? null
        : formatMinorToDecimal(limit.secondApprovalAboveMinor),
    effectiveFrom: limit.effectiveFrom.toISOString(),
    effectiveTo: limit.effectiveTo?.toISOString() ?? null,
    createdAt: limit.createdAt.toISOString(),
  };
}

@Injectable()
export class AdminApprovalLimitService {
  constructor(
    private readonly limits: AdminApprovalLimitRepository,
    private readonly admins: AdminUserRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  /** The documented contract. Use `evaluateDetailed` when the reason matters. */
  async evaluate(
    tx: Tx,
    admin: ApprovingAdmin,
    amountMinor: bigint,
    currencyCode: string,
  ): Promise<ApprovalDecision> {
    return (await this.evaluateDetailed(tx, admin, amountMinor, currencyCode)).decision;
  }

  async evaluateDetailed(
    tx: Tx,
    admin: ApprovingAdmin,
    amountMinor: bigint,
    currencyCode: string,
    at: Date = new Date(),
  ): Promise<ApprovalEvaluation> {
    const globalThreshold = this.config.limits.dualApprovalThresholdMinor;

    const base: ApprovalEvaluation = {
      decision: 'DENIED',
      reason: 'INVALID_AMOUNT',
      amountMinor,
      maxSingleApprovalMinor: null,
      maxDailyApprovalMinor: null,
      dailyUsedMinor: 0n,
      secondApprovalAboveMinor: globalThreshold,
    };

    // A zero or negative approval is not a small approval, it is a malformed one.
    if (amountMinor <= 0n) return base;

    if (!APPROVER_ROLES.includes(admin.role)) {
      return { ...base, reason: 'ROLE_MAY_NOT_APPROVE' };
    }

    const limit = await this.limits.findEffective(admin.adminUserId, currencyCode, at, tx);
    if (limit === null) {
      return { ...base, reason: 'NO_ACTIVE_LIMIT' };
    }

    const threshold = limit.secondApprovalAboveMinor ?? globalThreshold;
    const withLimits: ApprovalEvaluation = {
      ...base,
      maxSingleApprovalMinor: limit.maxSingleApprovalMinor,
      maxDailyApprovalMinor: limit.maxDailyApprovalMinor,
      secondApprovalAboveMinor: threshold,
    };

    // The personal ceiling is absolute: above it, a second approver does not help, because this
    // admin may not authorize this amount at all.
    if (amountMinor > limit.maxSingleApprovalMinor) {
      return { ...withLimits, reason: 'ABOVE_SINGLE_CEILING' };
    }

    const dailyUsedMinor = await this.dailyApprovedMinor(tx, admin.adminUserId, currencyCode, at);
    if (dailyUsedMinor + amountMinor > limit.maxDailyApprovalMinor) {
      return { ...withLimits, dailyUsedMinor, reason: 'ABOVE_DAILY_CEILING' };
    }

    if (amountMinor > threshold) {
      return {
        ...withLimits,
        dailyUsedMinor,
        decision: 'NEEDS_SECOND',
        reason: 'ABOVE_DUAL_THRESHOLD',
      };
    }

    return { ...withLimits, dailyUsedMinor, decision: 'ALLOWED', reason: 'WITHIN_LIMITS' };
  }

  /**
   * What this admin has already approved today, in this currency.
   *
   * Counts deposits where they were EITHER the first decider OR the second approver: both are acts
   * of authority, and an admin who only ever second-approves would otherwise have no budget at all.
   * The four-eyes CHECK guarantees the two ids differ, so no row is counted twice.
   *
   * The day boundary is UTC. Staff spanning time zones would otherwise get a budget that resets at
   * a different moment for each of them, and reconciling "who approved what today" across a report
   * and a ceiling would be impossible.
   */
  async dailyApprovedMinor(
    tx: Tx,
    adminUserId: string,
    currencyCode: string,
    at: Date = new Date(),
  ): Promise<bigint> {
    const dayStart = new Date(
      Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), 0, 0, 0, 0),
    );

    const rows = await tx.depositRequest.findMany({
      where: {
        currencyCode,
        decidedAt: { gte: dayStart, lte: at },
        status: { in: [...APPROVAL_CONSUMING_STATUSES] },
        OR: [{ decidedByAdminId: adminUserId }, { secondApproverAdminId: adminUserId }],
      },
      select: { claimedAmountMinor: true, verifiedAmountMinor: true },
    });

    return sumMinor(rows.map((row) => row.verifiedAmountMinor ?? row.claimedAmountMinor));
  }

  // ---------------------------------------------------------------------------
  // Administration of the limits themselves
  // ---------------------------------------------------------------------------

  async listForAdmin(adminUserId: string): Promise<ApprovalLimitView[]> {
    const rows = await this.limits.listForAdmin(adminUserId);
    return rows.map(toApprovalLimitView);
  }

  /**
   * Sets the ceiling for (admin, currency) by SUPERSEDING whatever is in force: the open version is
   * closed at the same instant the new one starts, so there is never a gap in which an admin has no
   * limit (which would read as NO_ACTIVE_LIMIT and deny everything) and never an overlap in which
   * two versions both apply.
   */
  async setLimit(
    actorAdminId: string,
    adminUserId: string,
    dto: SetApprovalLimitDto,
  ): Promise<ApprovalLimitView> {
    const maxSingleApprovalMinor = toMinorOrThrow(dto.maxSingleApproval, 'maxSingleApproval');
    const maxDailyApprovalMinor = toMinorOrThrow(dto.maxDailyApproval, 'maxDailyApproval');
    const secondApprovalAboveMinor = toMinorOrNull(dto.secondApprovalAbove, 'secondApprovalAbove');

    this.assertCoherent(maxSingleApprovalMinor, maxDailyApprovalMinor, secondApprovalAboveMinor);

    const admin = await this.admins.findById(adminUserId);
    if (admin === null) {
      throw new NotFoundError(AdminErrorCodes.ADMIN_NOT_FOUND, 'Administrator not found.');
    }

    const at = new Date();

    return this.prisma
      .runInTransaction(async (tx) => {
        const previous = await this.limits.findEffective(adminUserId, dto.currencyCode, at, tx);
        await this.limits.closeOpen(adminUserId, dto.currencyCode, at, tx);

        const created = await this.limits.create(
          {
            adminUserId,
            currencyCode: dto.currencyCode,
            maxSingleApprovalMinor,
            maxDailyApprovalMinor,
            secondApprovalAboveMinor,
            effectiveFrom: at,
          },
          tx,
        );

        await this.audit.write(tx, {
          action: 'admin.limit.set',
          actor: adminActor(actorAdminId),
          subjectType: 'AdminApprovalLimit',
          subjectId: created.id,
          before:
            previous === null
              ? null
              : {
                  maxSingleApprovalMinor: previous.maxSingleApprovalMinor.toString(),
                  maxDailyApprovalMinor: previous.maxDailyApprovalMinor.toString(),
                  secondApprovalAboveMinor: previous.secondApprovalAboveMinor?.toString() ?? null,
                },
          after: {
            adminUserId,
            currencyCode: created.currencyCode,
            maxSingleApprovalMinor: created.maxSingleApprovalMinor.toString(),
            maxDailyApprovalMinor: created.maxDailyApprovalMinor.toString(),
            secondApprovalAboveMinor: created.secondApprovalAboveMinor?.toString() ?? null,
          },
        });

        return toApprovalLimitView(created);
      })
      .catch((error: unknown) => {
        // UNIQUE(adminUserId, currencyCode, effectiveFrom): two operators setting the same admin's
        // ceiling within the same millisecond. Rare, and a retry is the right answer.
        if (isUniqueConstraintError(error)) {
          throw new ConflictError(
            AdminErrorCodes.APPROVAL_LIMIT_INVALID,
            'This limit was being changed at the same moment. Please retry.',
          );
        }
        throw error;
      });
  }

  /**
   * Ends a limit without replacing it. The admin then has NO active limit, which `evaluate` reads
   * as DENIED — removing someone's authority, not granting them unlimited authority.
   */
  async endLimit(actorAdminId: string, limitId: string): Promise<ApprovalLimitView> {
    const at = new Date();

    return this.prisma.runInTransaction(async (tx) => {
      const existing = await this.limits.findById(limitId, tx);
      if (existing === null) {
        throw new NotFoundError(
          AdminErrorCodes.APPROVAL_LIMIT_NOT_FOUND,
          'Approval limit not found.',
        );
      }
      if (existing.effectiveTo !== null) {
        throw new ConflictError(
          AdminErrorCodes.APPROVAL_LIMIT_INVALID,
          'This approval limit has already ended.',
        );
      }

      const closed = await this.limits.close(limitId, at, tx);

      await this.audit.write(tx, {
        action: 'admin.limit.ended',
        actor: adminActor(actorAdminId),
        subjectType: 'AdminApprovalLimit',
        subjectId: limitId,
        before: { effectiveTo: null },
        after: { effectiveTo: at.toISOString(), adminUserId: existing.adminUserId },
      });

      return toApprovalLimitView(closed);
    });
  }

  /**
   * Rejects configurations that cannot mean what the operator intended.
   * A single-approval ceiling above the daily ceiling is the common typo, and it silently makes the
   * daily limit unreachable-but-binding: the first approval of the day would always be denied.
   */
  private assertCoherent(
    maxSingleApprovalMinor: bigint,
    maxDailyApprovalMinor: bigint,
    secondApprovalAboveMinor: bigint | null,
  ): void {
    if (maxSingleApprovalMinor <= 0n || maxDailyApprovalMinor <= 0n) {
      throw new ValidationError(
        'Approval ceilings must be greater than zero.',
        { field: 'maxSingleApproval' },
        AdminErrorCodes.APPROVAL_LIMIT_INVALID,
      );
    }
    if (maxSingleApprovalMinor > maxDailyApprovalMinor) {
      throw new ValidationError(
        'maxSingleApproval cannot exceed maxDailyApproval.',
        { field: 'maxSingleApproval' },
        AdminErrorCodes.APPROVAL_LIMIT_INVALID,
      );
    }
    if (secondApprovalAboveMinor !== null && secondApprovalAboveMinor < 0n) {
      throw new ValidationError(
        'secondApprovalAbove cannot be negative.',
        { field: 'secondApprovalAbove' },
        AdminErrorCodes.APPROVAL_LIMIT_INVALID,
      );
    }
  }
}
