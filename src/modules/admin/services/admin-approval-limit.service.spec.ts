import type { AdminApprovalLimit } from '@prisma/client';

import type { Tx } from '@core/prisma/tx.type';
import { AdminApprovalLimitService, type ApprovingAdmin } from './admin-approval-limit.service';
import type { AdminApprovalLimitRepository } from '../repositories/admin-approval-limit.repository';
import type { AdminUserRepository } from '../repositories/admin-user.repository';

/** 1000.00 NSP in minor units. */
const GLOBAL_THRESHOLD = 100_000n;

const FINANCE: ApprovingAdmin = { adminUserId: 'admin-1', role: 'FINANCE_ADMIN' };
const SUPPORT: ApprovingAdmin = { adminUserId: 'admin-2', role: 'SUPPORT' };
const VIEWER: ApprovingAdmin = { adminUserId: 'admin-3', role: 'VIEWER' };
const SUPER: ApprovingAdmin = { adminUserId: 'admin-4', role: 'SUPER_ADMIN' };

function limitRow(overrides: Partial<AdminApprovalLimit> = {}): AdminApprovalLimit {
  return {
    id: 'limit-1',
    adminUserId: 'admin-1',
    currencyCode: 'NSP',
    maxSingleApprovalMinor: 500_000n,
    maxDailyApprovalMinor: 2_000_000n,
    secondApprovalAboveMinor: null,
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    effectiveTo: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

interface Harness {
  service: AdminApprovalLimitService;
  findEffective: jest.Mock;
  findMany: jest.Mock;
  tx: Tx;
}

function harness(): Harness {
  const findEffective = jest.fn().mockResolvedValue(limitRow());
  const findMany = jest.fn().mockResolvedValue([]);

  const limits = { findEffective } as unknown as AdminApprovalLimitRepository;
  const admins = {} as unknown as AdminUserRepository;
  const config = {
    limits: { dualApprovalThresholdMinor: GLOBAL_THRESHOLD },
  } as never;

  const service = new AdminApprovalLimitService(limits, admins, {} as never, {} as never, config);

  const tx = { depositRequest: { findMany } } as unknown as Tx;
  return { service, findEffective, findMany, tx };
}

describe('AdminApprovalLimitService.evaluate', () => {
  it('ALLOWS an amount inside every ceiling and below the dual threshold', async () => {
    const { service, tx } = harness();
    await expect(service.evaluate(tx, FINANCE, 50_000n, 'NSP')).resolves.toBe('ALLOWED');
  });

  it('requires a SECOND approver above the dual threshold', async () => {
    const { service, tx } = harness();
    const result = await service.evaluateDetailed(tx, FINANCE, 150_000n, 'NSP');
    expect(result.decision).toBe('NEEDS_SECOND');
    expect(result.reason).toBe('ABOVE_DUAL_THRESHOLD');
  });

  it('treats the threshold as exclusive — exactly at it is still a single approval', async () => {
    const { service, tx } = harness();
    await expect(service.evaluate(tx, FINANCE, GLOBAL_THRESHOLD, 'NSP')).resolves.toBe('ALLOWED');
    await expect(service.evaluate(tx, FINANCE, GLOBAL_THRESHOLD + 1n, 'NSP')).resolves.toBe(
      'NEEDS_SECOND',
    );
  });

  it('prefers the per-admin override over the global threshold', async () => {
    const { service, findEffective, tx } = harness();
    findEffective.mockResolvedValue(limitRow({ secondApprovalAboveMinor: 300_000n }));

    // Above the GLOBAL threshold but below this admin's own — a single approval is enough.
    const result = await service.evaluateDetailed(tx, FINANCE, 200_000n, 'NSP');
    expect(result.decision).toBe('ALLOWED');
    expect(result.secondApprovalAboveMinor).toBe(300_000n);
  });

  it('DENIES above the personal single-approval ceiling, even though a second approver exists', async () => {
    // A second pair of eyes does not extend an individual's authority.
    const { service, tx } = harness();
    const result = await service.evaluateDetailed(tx, FINANCE, 500_001n, 'NSP');
    expect(result.decision).toBe('DENIED');
    expect(result.reason).toBe('ABOVE_SINGLE_CEILING');
  });

  it('allows exactly the single ceiling', async () => {
    const { service, tx } = harness();
    const result = await service.evaluateDetailed(tx, FINANCE, 500_000n, 'NSP');
    expect(result.reason).not.toBe('ABOVE_SINGLE_CEILING');
  });

  it('DENIES when today already used the daily budget', async () => {
    const { service, findMany, tx } = harness();
    findMany.mockResolvedValue([
      { claimedAmountMinor: 900_000n, verifiedAmountMinor: null },
      { claimedAmountMinor: 900_000n, verifiedAmountMinor: null },
    ]);

    const result = await service.evaluateDetailed(tx, FINANCE, 300_000n, 'NSP');
    expect(result.decision).toBe('DENIED');
    expect(result.reason).toBe('ABOVE_DAILY_CEILING');
    expect(result.dailyUsedMinor).toBe(1_800_000n);
  });

  it('allows an amount that exactly fills the remaining daily budget', async () => {
    const { service, findMany, tx } = harness();
    findMany.mockResolvedValue([{ claimedAmountMinor: 1_800_000n, verifiedAmountMinor: null }]);

    // 1_800_000 + 200_000 === 2_000_000, the ceiling. Off-by-one here would deny a legitimate
    // approval every single day.
    const result = await service.evaluateDetailed(tx, FINANCE, 200_000n, 'NSP');
    expect(result.reason).not.toBe('ABOVE_DAILY_CEILING');
  });

  it('counts the VERIFIED amount when it differs from the claim', async () => {
    const { service, findMany, tx } = harness();
    findMany.mockResolvedValue([
      // The player claimed 9000.00 but only 100.00 was confirmed; only the confirmed sum is
      // authority actually exercised.
      { claimedAmountMinor: 900_000n, verifiedAmountMinor: 10_000n },
    ]);

    const result = await service.evaluateDetailed(tx, FINANCE, 50_000n, 'NSP');
    expect(result.dailyUsedMinor).toBe(10_000n);
    expect(result.decision).toBe('ALLOWED');
  });

  it('FAILS CLOSED when the admin has no configured limit', async () => {
    const { service, findEffective, tx } = harness();
    findEffective.mockResolvedValue(null);

    const result = await service.evaluateDetailed(tx, FINANCE, 1n, 'NSP');
    expect(result.decision).toBe('DENIED');
    expect(result.reason).toBe('NO_ACTIVE_LIMIT');
  });

  it('DENIES roles that may never approve, without even reading a limit', async () => {
    const { service, findEffective, tx } = harness();

    for (const admin of [SUPPORT, VIEWER]) {
      const result = await service.evaluateDetailed(tx, admin, 1_000n, 'NSP');
      expect(result.decision).toBe('DENIED');
      expect(result.reason).toBe('ROLE_MAY_NOT_APPROVE');
    }
    expect(findEffective).not.toHaveBeenCalled();
  });

  it('does not implicitly grant SUPER_ADMIN — it still needs a limit row', async () => {
    const { service, findEffective, tx } = harness();
    findEffective.mockResolvedValue(null);

    const result = await service.evaluateDetailed(tx, SUPER, 1_000n, 'NSP');
    expect(result.decision).toBe('DENIED');
    expect(result.reason).toBe('NO_ACTIVE_LIMIT');
  });

  it('DENIES a zero or negative amount', async () => {
    const { service, tx } = harness();
    for (const amount of [0n, -1n, -500_000n]) {
      const result = await service.evaluateDetailed(tx, FINANCE, amount, 'NSP');
      expect(result.decision).toBe('DENIED');
      expect(result.reason).toBe('INVALID_AMOUNT');
    }
  });

  it('looks up the limit for the requested currency at the given instant', async () => {
    const { service, findEffective, tx } = harness();
    const at = new Date('2026-06-01T12:00:00Z');
    await service.evaluateDetailed(tx, FINANCE, 1_000n, 'NSP', at);
    expect(findEffective).toHaveBeenCalledWith('admin-1', 'NSP', at, tx);
  });
});

describe('AdminApprovalLimitService.dailyApprovedMinor', () => {
  it('counts both first decisions and second approvals, from UTC midnight', async () => {
    const { service, findMany, tx } = harness();
    const at = new Date('2026-06-01T12:34:56Z');

    await service.dailyApprovedMinor(tx, 'admin-1', 'NSP', at);

    const args = findMany.mock.calls[0]?.[0] as {
      where: {
        decidedAt: { gte: Date; lte: Date };
        OR: unknown[];
        currencyCode: string;
        status: { in: string[] };
      };
    };

    expect(args.where.decidedAt.gte).toEqual(new Date('2026-06-01T00:00:00.000Z'));
    expect(args.where.decidedAt.lte).toEqual(at);
    expect(args.where.currencyCode).toBe('NSP');
    expect(args.where.OR).toEqual([
      { decidedByAdminId: 'admin-1' },
      { secondApproverAdminId: 'admin-1' },
    ]);
    // A failed credit must not consume an admin's daily budget.
    expect(args.where.status.in).not.toContain('CREDIT_FAILED');
    expect(args.where.status.in).not.toContain('REJECTED');
    expect(args.where.status.in).toContain('CREDITED');
  });

  it('is zero when nothing was approved today', async () => {
    const { service, tx } = harness();
    await expect(service.dailyApprovedMinor(tx, 'admin-1', 'NSP')).resolves.toBe(0n);
  });
});
