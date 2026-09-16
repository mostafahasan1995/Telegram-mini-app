import type { AdminApprovalLimit } from '@prisma/client';

import type { Tx } from '@core/prisma/tx.type';
import { TENANT_ZERO_ID } from '@core/tenant/tenant.constants';
import { AdminApprovalLimitService, type ApprovingAdmin } from './admin-approval-limit.service';
import type { AdminApprovalLimitRepository } from '../repositories/admin-approval-limit.repository';
import type { AdminUserRepository } from '../repositories/admin-user.repository';

/** 1000.00 NSP in minor units. */
const GLOBAL_THRESHOLD = 100_000n;

/**
 * These tests never cross a tenant boundary — `evaluate` is handed its rows directly — so the id
 * only has to be a well-formed uuid that every fixture agrees on.
 */
const FIXTURE_TENANT_ID = '11111111-1111-1111-1111-111111111111';

const FINANCE: ApprovingAdmin = {
  adminUserId: 'admin-1',
  role: 'FINANCE_ADMIN',
  tenantId: FIXTURE_TENANT_ID,
};
const SUPPORT: ApprovingAdmin = {
  adminUserId: 'admin-2',
  role: 'SUPPORT',
  tenantId: FIXTURE_TENANT_ID,
};
const VIEWER: ApprovingAdmin = {
  adminUserId: 'admin-3',
  role: 'VIEWER',
  tenantId: FIXTURE_TENANT_ID,
};
const SUPER: ApprovingAdmin = {
  adminUserId: 'admin-4',
  role: 'SUPER_ADMIN',
  tenantId: FIXTURE_TENANT_ID,
};
/** Platform staff: PLATFORM_ADMIN whose row lives in tenant zero. */
const PLATFORM: ApprovingAdmin = {
  adminUserId: 'admin-5',
  role: 'PLATFORM_ADMIN',
  tenantId: TENANT_ZERO_ID,
};

function limitRow(overrides: Partial<AdminApprovalLimit> = {}): AdminApprovalLimit {
  return {
    id: 'limit-1',
    tenantId: FIXTURE_TENANT_ID,
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

/**
 * API-CONTRACT.md §3: PLATFORM_ADMIN's "money decisions are unbounded by an approval limit (the
 * backend `RolesGuard` and the approval-limit evaluator both exempt it)". Four eyes is not an
 * approval limit, so the dual threshold still applies to it.
 */
describe('AdminApprovalLimitService.evaluate — PLATFORM_ADMIN (owner superset)', () => {
  it('is not ROLE_MAY_NOT_APPROVE and does NOT fail closed without a limit row', async () => {
    const { service, findEffective, tx } = harness();
    findEffective.mockResolvedValue(null);

    const result = await service.evaluateDetailed(tx, PLATFORM, 50_000n, 'NSP');
    expect(result.decision).toBe('ALLOWED');
    expect(result.reason).toBe('WITHIN_LIMITS');
    expect(result.maxSingleApprovalMinor).toBeNull();
    expect(result.maxDailyApprovalMinor).toBeNull();
    // Unbounded means no row is consulted at all — see evaluatePlatformStaff for why.
    expect(findEffective).not.toHaveBeenCalled();
  });

  it('ignores the ceilings of a limit row that exists', async () => {
    const { service, findEffective, findMany, tx } = harness();
    findEffective.mockResolvedValue(
      limitRow({
        adminUserId: 'admin-5',
        maxSingleApprovalMinor: 1_000n,
        maxDailyApprovalMinor: 1_000n,
        secondApprovalAboveMinor: 900_000_000n,
      }),
    );
    findMany.mockResolvedValue([{ claimedAmountMinor: 5_000_000n, verifiedAmountMinor: null }]);

    // Above the row's single AND daily ceiling, below the global threshold: allowed alone.
    const result = await service.evaluateDetailed(tx, PLATFORM, GLOBAL_THRESHOLD, 'NSP');
    expect(result.decision).toBe('ALLOWED');
    expect(result.dailyUsedMinor).toBe(5_000_000n);
    expect(findEffective).not.toHaveBeenCalled();
  });

  it('still needs a SECOND approver above the global dual threshold — with or without a row', async () => {
    for (const row of [
      null,
      limitRow({ adminUserId: 'admin-5', secondApprovalAboveMinor: 900_000_000n }),
    ]) {
      const { service, findEffective, tx } = harness();
      findEffective.mockResolvedValue(row);

      const result = await service.evaluateDetailed(tx, PLATFORM, GLOBAL_THRESHOLD + 1n, 'NSP');
      expect(result.decision).toBe('NEEDS_SECOND');
      expect(result.reason).toBe('ABOVE_DUAL_THRESHOLD');
      // A row cannot lift four eyes for platform staff: the threshold applied is the global one.
      expect(result.secondApprovalAboveMinor).toBe(GLOBAL_THRESHOLD);
    }
  });

  it('still DENIES a zero or negative amount', async () => {
    const { service, tx } = harness();
    const result = await service.evaluateDetailed(tx, PLATFORM, 0n, 'NSP');
    expect(result.decision).toBe('DENIED');
    expect(result.reason).toBe('INVALID_AMOUNT');
  });

  it('grants nothing to a PLATFORM_ADMIN row outside tenant zero', async () => {
    const { service, findEffective, tx } = harness();
    const stray: ApprovingAdmin = { ...PLATFORM, tenantId: FIXTURE_TENANT_ID };

    const result = await service.evaluateDetailed(tx, stray, 1_000n, 'NSP');
    expect(result.decision).toBe('DENIED');
    expect(result.reason).toBe('ROLE_MAY_NOT_APPROVE');
    expect(findEffective).not.toHaveBeenCalled();
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
