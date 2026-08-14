/**
 * The deliberate operator re-run, after a credit failed (almost always: the agent float was empty
 * and has since been topped up).
 *
 * WHY it bumps creditKeyEpoch instead of just re-enqueuing: the epoch is what distinguishes "the
 * same attempt being redelivered" from "a human decided to try again". It appears in the BullMQ job
 * id and in the outbox dedupeKey, so without bumping it the new job would collapse into the old
 * one — the retry would look like it worked and nothing would happen. It is also what the credit
 * worker checks to refuse a stale job from a previous epoch.
 *
 * WHY it does not re-post T1: the ledger already says we owe this player. The claim posting happened
 * at approval and is correct regardless of how many times we try to hand the money to Ichancy. Only
 * T2 is outstanding, and only a confirmed credit may post it.
 */
import { Injectable, Logger } from '@nestjs/common';
import { AdminRole, DepositStatus } from '@prisma/client';

import type { AuthenticatedAdmin } from '@common/decorators/auth.types';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '@common/exceptions/app.exception';
import { adminActor } from '@common/types/actor.type';
import { AuditService } from '@core/audit/audit.service';
import { OutboxService } from '@core/outbox/outbox.service';
import { PrismaService } from '@core/prisma/prisma.service';

import { DEPOSIT_AGGREGATE, DEPOSIT_TOPICS } from '../deposit.constants';
import { DepositStateMachine } from '../deposit-state.machine';
import { DepositErrorCodes } from '../enums/deposit-error-code.enum';
import { DepositRepository } from '../repositories/deposit.repository';

export interface RequeueInput {
  depositRequestId: string;
  admin: AuthenticatedAdmin;
  reason?: string;
}

const ALLOWED_ROLES: readonly AdminRole[] = Object.freeze([
  AdminRole.SUPER_ADMIN,
  AdminRole.FINANCE_ADMIN,
]);

@Injectable()
export class DepositRetryService {
  private readonly logger = new Logger(DepositRetryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deposits: DepositRepository,
    private readonly stateMachine: DepositStateMachine,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  async requeueCredit(input: RequeueInput): Promise<{ requeued: boolean; creditKeyEpoch: number }> {
    if (!ALLOWED_ROLES.includes(input.admin.role)) {
      throw new ForbiddenError(
        DepositErrorCodes.ADMIN_NO_APPROVAL_LIMIT,
        'Your role cannot re-run a credit.',
        { role: input.admin.role },
      );
    }

    return this.prisma.runInTransaction(async (tx) => {
      const deposit = await this.deposits.findById(tx, input.depositRequestId);
      if (deposit === null) {
        throw new NotFoundError(DepositErrorCodes.DEPOSIT_NOT_FOUND, 'Deposit not found.');
      }
      if (
        deposit.status !== DepositStatus.CREDIT_FAILED &&
        deposit.status !== DepositStatus.NEEDS_RECONCILIATION
      ) {
        throw new BusinessRuleError(
          DepositErrorCodes.DEPOSIT_INVALID_STATE,
          'Only a failed or unresolved credit can be re-run.',
          { status: deposit.status },
        );
      }
      if (deposit.creditedAmountMinor === null) {
        // Nothing was ever approved for credit, so there is no amount to hand to Ichancy.
        throw new BusinessRuleError(
          DepositErrorCodes.VERIFIED_AMOUNT_REQUIRED,
          'This deposit has no approved credit amount to re-run.',
        );
      }

      const nextEpoch = deposit.creditKeyEpoch + 1;

      const outcome = await this.stateMachine.transition(tx, {
        depositRequestId: deposit.id,
        from: [DepositStatus.CREDIT_FAILED, DepositStatus.NEEDS_RECONCILIATION],
        to: DepositStatus.APPROVED,
        actor: adminActor(input.admin.adminUserId),
        reason: input.reason ?? `Credit re-run by ${input.admin.displayName}`,
        metadata: { previousEpoch: deposit.creditKeyEpoch, creditKeyEpoch: nextEpoch },
        patch: {
          creditKeyEpoch: nextEpoch,
          // Stale readings from the previous attempt must not be mistaken for this one's baseline.
          balanceBeforeMinor: null,
          balanceAfterMinor: null,
          creditVerifiedBy: null,
        },
      });

      if (outcome.kind === 'alreadyHandled') {
        return { requeued: false, creditKeyEpoch: deposit.creditKeyEpoch };
      }

      await this.audit.write(tx, {
        action: 'deposit.credit.requeue',
        actor: adminActor(input.admin.adminUserId),
        subjectType: DEPOSIT_AGGREGATE,
        subjectId: deposit.id,
        before: { status: deposit.status, creditKeyEpoch: deposit.creditKeyEpoch },
        after: { status: DepositStatus.APPROVED, creditKeyEpoch: nextEpoch },
        amountMinor: deposit.creditedAmountMinor,
        metadata: { reason: input.reason ?? null },
      });

      await this.outbox.enqueue(tx, {
        aggregateType: DEPOSIT_AGGREGATE,
        aggregateId: deposit.id,
        topic: DEPOSIT_TOPICS.CREDIT_REQUESTED,
        payload: {
          depositRequestId: deposit.id,
          shortId: deposit.shortId,
          playerId: deposit.playerId,
          creditKeyEpoch: nextEpoch,
          amountMinor: deposit.creditedAmountMinor.toString(),
        },
        dedupeKey: `${DEPOSIT_TOPICS.CREDIT_REQUESTED}:${deposit.id}:${nextEpoch}`,
      });

      this.logger.log(
        `deposit ${deposit.shortId} re-queued for credit at epoch ${nextEpoch} by ${input.admin.displayName}`,
      );
      return { requeued: true, creditKeyEpoch: nextEpoch };
    });
  }
}
