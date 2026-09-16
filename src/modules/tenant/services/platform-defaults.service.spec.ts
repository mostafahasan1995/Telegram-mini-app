import type { PlatformDefaults } from '@prisma/client';

import type { AuditWriteInput } from '@core/audit/audit.types';
import type { AuditService } from '@core/audit/audit.service';
import type { AppConfigService } from '@core/config/config.service';
import type { PrismaService } from '@core/prisma/prisma.service';
import { TENANT_ZERO_ID } from '@core/tenant/tenant.constants';
import { getEffectiveTenantId } from '@core/tenant/tenant.storage';

import { PlatformDefaultsService } from './platform-defaults.service';

const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000006';

const config = {
  ichancy: { baseUrl: 'https://agents.ichancy.com', agentId: '1234567', currency: 'NSP' },
  limits: {
    dualApprovalThresholdMinor: 100_000_000n,
    agentFloatLowWatermarkMinor: 50_000_000n,
    depositExpiryMinutes: 120,
  },
};

/** The row as the multi-tenant migration inserts it: literals, never seeded. */
const migrationRow = (): PlatformDefaults => ({
  id: 1,
  ichancyBaseUrl: 'https://agents.ichancy.com',
  ichancyAgentId: null,
  currencyCode: 'NSP',
  dualApprovalThresholdMinor: 0n,
  agentFloatLowWatermarkMinor: 0n,
  depositExpiryMinutes: 30,
  seededFromEnvAt: null,
  updatedAt: new Date('2026-09-11T09:00:00.000Z'),
});

const seededRow = (overrides: Partial<PlatformDefaults> = {}): PlatformDefaults => ({
  id: 1,
  ichancyBaseUrl: 'https://agents.ichancy.com',
  ichancyAgentId: '1234567',
  currencyCode: 'NSP',
  dualApprovalThresholdMinor: 100_000_000n,
  agentFloatLowWatermarkMinor: 50_000_000n,
  depositExpiryMinutes: 120,
  seededFromEnvAt: new Date('2026-09-15T08:00:00.000Z'),
  updatedAt: new Date('2026-09-15T08:00:00.000Z'),
  ...overrides,
});

function harness(stored: PlatformDefaults | null) {
  const tx = {
    platformDefaults: {
      findUnique: jest.fn().mockResolvedValue(stored),
      findUniqueOrThrow: jest.fn().mockResolvedValue(seededRow()),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn(),
    },
    currency: { findUnique: jest.fn().mockResolvedValue({ isActive: true }) },
  };
  const prisma = {
    runInTransaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    platformDefaults: { findUnique: jest.fn().mockResolvedValue(stored) },
  };
  const audits: { input: AuditWriteInput; tenantId: string | undefined }[] = [];
  const audit = {
    write: jest.fn((_tx: unknown, input: AuditWriteInput) => {
      audits.push({ input, tenantId: getEffectiveTenantId() });
      return Promise.resolve('audit-id');
    }),
  };

  const service = new PlatformDefaultsService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    config as unknown as AppConfigService,
  );
  return { service, tx, prisma, audits };
}

describe('PlatformDefaultsService.read', () => {
  it('answers a seeded row without opening a transaction', async () => {
    const h = harness(seededRow());

    await expect(h.service.view()).resolves.toEqual({
      ichancyBaseUrl: 'https://agents.ichancy.com',
      ichancyAgentId: '1234567',
      currencyCode: 'NSP',
      dualApprovalThresholdMinor: '100000000',
      agentFloatLowWatermarkMinor: '50000000',
      depositExpiryMinutes: 120,
      updatedAt: '2026-09-15T08:00:00.000Z',
      appliesToNewOperatorsOnly: true,
    });
    expect(h.prisma.runInTransaction).not.toHaveBeenCalled();
  });

  it("copies the env over the migration's literals on first read, and audits it as SYSTEM in tenant zero", async () => {
    const h = harness(migrationRow());

    await h.service.read();

    expect(h.tx.platformDefaults.updateMany).toHaveBeenCalledWith({
      where: { id: 1, seededFromEnvAt: null },
      data: expect.objectContaining({
        ichancyAgentId: '1234567',
        dualApprovalThresholdMinor: 100_000_000n,
        depositExpiryMinutes: 120,
        seededFromEnvAt: expect.any(Date),
      }),
    });
    expect(h.tx.platformDefaults.createMany).not.toHaveBeenCalled();
    expect(h.audits).toEqual([
      {
        tenantId: TENANT_ZERO_ID,
        input: expect.objectContaining({
          action: 'platform.defaults.seeded',
          actor: { type: 'SYSTEM', id: null },
          before: expect.objectContaining({ dualApprovalThresholdMinor: '0' }),
          after: expect.objectContaining({ dualApprovalThresholdMinor: '100000000' }),
        }),
      },
    ]);
  });

  it('writes no second audit row when a concurrent first read already seeded it', async () => {
    const h = harness(migrationRow());
    h.tx.platformDefaults.updateMany.mockResolvedValue({ count: 0 });

    await h.service.read();

    expect(h.tx.platformDefaults.createMany).not.toHaveBeenCalled();
    expect(h.audits).toHaveLength(0);
  });

  it('creates the row when the migration never ran, still exactly once', async () => {
    const h = harness(null);
    h.tx.platformDefaults.updateMany.mockResolvedValue({ count: 0 });

    await h.service.read();

    expect(h.tx.platformDefaults.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ id: 1, seededFromEnvAt: expect.any(Date) })],
      skipDuplicates: true,
    });
    expect(h.audits).toHaveLength(1);
  });
});

describe('PlatformDefaultsService.update', () => {
  it('writes and audits only changed fields in tenant zero', async () => {
    const h = harness(seededRow());
    h.tx.platformDefaults.findUniqueOrThrow.mockResolvedValue(seededRow());
    h.tx.platformDefaults.update.mockResolvedValue(seededRow({ ichancyAgentId: '10500' }));

    const view = await h.service.update(ACTOR_ID, {
      ichancyAgentId: '10500',
      currencyCode: 'NSP',
      depositExpiryMinutes: 120,
    });

    expect(view.ichancyAgentId).toBe('10500');
    expect(h.tx.platformDefaults.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { ichancyAgentId: '10500' },
    });
    expect(h.audits).toEqual([
      {
        tenantId: TENANT_ZERO_ID,
        input: expect.objectContaining({
          action: 'platform.defaults.updated',
          actor: { type: 'ADMIN', id: ACTOR_ID },
          before: { ichancyAgentId: '1234567' },
          after: { ichancyAgentId: '10500' },
        }),
      },
    ]);
  });

  it('seeds before editing, so the first read cannot overwrite the edit', async () => {
    const h = harness(migrationRow());
    h.tx.platformDefaults.update.mockResolvedValue(seededRow({ depositExpiryMinutes: 45 }));

    await h.service.update(ACTOR_ID, { depositExpiryMinutes: 45 });

    const seedOrder = h.tx.platformDefaults.updateMany.mock.invocationCallOrder[0] ?? Infinity;
    const editOrder = h.tx.platformDefaults.update.mock.invocationCallOrder[0] ?? -Infinity;
    expect(seedOrder).toBeLessThan(editOrder);
  });

  it('refuses an unknown currency and an inactive one with different sentences', async () => {
    const unknown = harness(seededRow());
    unknown.tx.currency.findUnique.mockResolvedValue(null);
    await expect(unknown.service.update(ACTOR_ID, { currencyCode: 'XYZ' })).rejects.toMatchObject({
      httpStatus: 400,
      errorCode: 'VALIDATION_FAILED',
      details: { fields: ['currencyCode: there is no currency XYZ'] },
    });

    const inactive = harness(seededRow());
    inactive.tx.currency.findUnique.mockResolvedValue({ isActive: false });
    await expect(inactive.service.update(ACTOR_ID, { currencyCode: 'SYP' })).rejects.toMatchObject({
      httpStatus: 400,
      errorCode: 'VALIDATION_FAILED',
      details: {
        fields: ['currencyCode: SYP exists but is not active, so no new operator may use it'],
      },
    });
    expect(inactive.tx.platformDefaults.update).not.toHaveBeenCalled();
  });

  it('writes nothing for an edit that changes nothing', async () => {
    const h = harness(seededRow());

    await h.service.update(ACTOR_ID, { ichancyAgentId: '1234567' });

    expect(h.tx.platformDefaults.update).not.toHaveBeenCalled();
    expect(h.audits).toHaveLength(0);
  });
});
