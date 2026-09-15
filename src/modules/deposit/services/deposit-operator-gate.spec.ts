/**
 * DepositService.create refuses to open a deposit for an operator that is not ACTIVE, and checks it
 * before anything else is resolved. The whole flow is covered by the tenant admin integration suite;
 * this pins the gate itself: which tenant it reads, what it answers, and that a serving operator
 * passes straight through.
 */
import { TenantStatus } from '@prisma/client';

import type { AuditService } from '@core/audit/audit.service';
import type { AppConfigService } from '@core/config/config.service';
import type { FileStorage } from '@core/file';
import type { OutboxService } from '@core/outbox/outbox.service';
import type { PrismaService } from '@core/prisma/prisma.service';
import { runWithTenant } from '@core/tenant/tenant.storage';

import type { DepositStateMachine } from '../deposit-state.machine';
import type { PaymentMethodPort } from '../ports';
import type { DepositRepository } from '../repositories/deposit.repository';
import type { DepositPolicyService } from './deposit-policy.service';
import { DepositService } from './deposit.service';
import type { ProofDuplicateService } from './proof-duplicate.service';

const OPERATOR_ID = '22222222-2222-4222-8222-222222222222';
const PLAYER_ID = '33333333-3333-4333-8333-333333333333';

/** Thrown by the payment port, so reaching it proves the gate let the request through. */
class ReachedPaymentPort extends Error {}

function harness(status: TenantStatus | null) {
  const prisma = {
    tenant: { findUnique: jest.fn().mockResolvedValue(status === null ? null : { status }) },
    runInTransaction: jest.fn(),
  };
  const payments = {
    getActiveById: jest.fn().mockRejectedValue(new ReachedPaymentPort('reached the payment port')),
  };
  const service = new DepositService(
    prisma as unknown as PrismaService,
    {} as DepositRepository,
    {} as DepositStateMachine,
    {} as ProofDuplicateService,
    {} as DepositPolicyService,
    {} as OutboxService,
    {} as AuditService,
    {} as AppConfigService,
    {} as FileStorage,
    payments as unknown as PaymentMethodPort,
  );
  const create = () =>
    runWithTenant(OPERATOR_ID, () =>
      service.create(
        { type: 'PLAYER', id: PLAYER_ID },
        { playerId: PLAYER_ID, paymentMethodId: 'method', amountMinor: 600_000n },
      ),
    );
  return { prisma, payments, create };
}

describe('DepositService.create, operator gate', () => {
  it.each([TenantStatus.SUSPENDED, TenantStatus.CLOSED])(
    'refuses a %s operator with 422 TENANT_NOT_ACTIVE before resolving anything',
    async (status) => {
      const h = harness(status);

      await expect(h.create()).rejects.toMatchObject({
        httpStatus: 422,
        errorCode: 'TENANT_NOT_ACTIVE',
        details: { status },
      });
      expect(h.prisma.tenant.findUnique).toHaveBeenCalledWith({
        where: { id: OPERATOR_ID },
        select: { status: true },
      });
      expect(h.payments.getActiveById).not.toHaveBeenCalled();
      expect(h.prisma.runInTransaction).not.toHaveBeenCalled();
    },
  );

  it('refuses when the operator row cannot be found, rather than assuming it serves', async () => {
    await expect(harness(null).create()).rejects.toMatchObject({ errorCode: 'TENANT_NOT_ACTIVE' });
  });

  it('lets an ACTIVE operator through to the payment method lookup', async () => {
    const h = harness(TenantStatus.ACTIVE);

    await expect(h.create()).rejects.toBeInstanceOf(ReachedPaymentPort);
    expect(h.payments.getActiveById).toHaveBeenCalledWith('method');
  });
});
