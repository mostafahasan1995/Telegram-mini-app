import { DepositMode, TenantStatus, WithdrawalMode } from '@prisma/client';

import type { AuditWriteInput } from '@core/audit/audit.types';
import type { AuditService } from '@core/audit/audit.service';
import type { InitDataService } from '@core/auth/services/init-data.service';
import type { AppConfigService } from '@core/config/config.service';
import type { PrismaService } from '@core/prisma/prisma.service';
import type { TenantBotRegistry } from '@core/telegram/services/tenant-bot-registry.service';
import type { TenantRegistryService } from '@core/tenant/services/tenant-registry.service';
import { TENANT_ZERO_ID } from '@core/tenant/tenant.constants';
import { getEffectiveTenantId } from '@core/tenant/tenant.storage';

import type { TenantViewRow } from '../views/tenant.view';

import { TenantAdminService } from './tenant-admin.service';

const OPERATOR_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000006';

const operatorRow = (overrides: Partial<TenantViewRow> = {}): TenantViewRow => ({
  id: OPERATOR_ID,
  slug: 'northern-branch',
  displayName: 'Northern branch',
  status: TenantStatus.ACTIVE,
  webhookPathToken: 'token',
  adminChatId: -1001234567890n,
  feedChatId: null,
  botUsername: 'northern_cashier_bot',
  ichancyBaseUrl: 'https://agents.ichancy.com',
  ichancyUsername: 'agent_north',
  ichancyAgentId: '10099',
  currencyCode: 'NSP',
  dualApprovalThresholdMinor: 30_000_000n,
  agentFloatLowWatermarkMinor: 50_000_000n,
  depositExpiryMinutes: 30,
  depositMode: DepositMode.MANUAL,
  withdrawalMode: WithdrawalMode.MANUAL,
  miniAppUrl: null,
  createdAt: new Date('2026-09-01T10:00:00.000Z'),
  updatedAt: new Date('2026-09-02T11:30:00.000Z'),
  ...overrides,
});

interface HarnessOptions {
  /** The view row a read AFTER the write answers. Defaults to `current`. */
  after?: TenantViewRow;
  /** The deployment's ICHANCY_FAKE. Defaults to false, real mode. */
  ichancyFake?: boolean;
}

function harness(current: TenantViewRow | null, options: HarnessOptions = {}) {
  const afterRow = options.after ?? current;
  const tx = {
    tenant: {
      findUnique: jest.fn().mockResolvedValue(current),
      findUniqueOrThrow: jest.fn().mockResolvedValue(afterRow),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = {
    runInTransaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    tenant: { findUnique: jest.fn().mockResolvedValue(current) },
    player: { count: jest.fn().mockResolvedValue(3) },
    depositRequest: { count: jest.fn().mockResolvedValue(7) },
  };

  /** Each audit row with the tenant context it was written in, which is where it lands. */
  const audits: { input: AuditWriteInput; tenantId: string | undefined }[] = [];
  const audit = {
    write: jest.fn((_tx: unknown, input: AuditWriteInput) => {
      audits.push({ input, tenantId: getEffectiveTenantId() });
      return Promise.resolve('audit-id');
    }),
  };
  const registry = { invalidate: jest.fn().mockResolvedValue(undefined) };
  const bots = { invalidate: jest.fn().mockResolvedValue(undefined) };
  const initData = { invalidate: jest.fn() };

  const service = new TenantAdminService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    registry as unknown as TenantRegistryService,
    bots as unknown as TenantBotRegistry,
    initData as unknown as InitDataService,
    { ichancy: { fake: options.ichancyFake ?? false } } as unknown as AppConfigService,
  );

  return { service, tx, prisma, audits, registry, bots, initData };
}

describe('TenantAdminService views and ICHANCY_FAKE', () => {
  it('marks every view with the deployment’s fake mode, and real mode as false', async () => {
    expect(await harness(operatorRow(), { ichancyFake: true }).service.get(OPERATOR_ID)).toMatchObject({
      status: 'ACTIVE',
      ichancyFake: true,
    });
    expect(await harness(operatorRow()).service.get(OPERATOR_ID)).toMatchObject({ ichancyFake: false });
  });
});

describe('TenantAdminService.suspend', () => {
  it("suspends an ACTIVE operator, audits it in that operator's own log and evicts all three caches", async () => {
    const h = harness(operatorRow(), { after: operatorRow({ status: TenantStatus.SUSPENDED }) });

    const view = await h.service.suspend(ACTOR_ID, OPERATOR_ID);

    expect(view).toMatchObject({ status: 'SUSPENDED', counts: { players: 3, deposits: 7 } });
    expect(h.tx.tenant.updateMany).toHaveBeenCalledWith({
      where: { id: OPERATOR_ID, status: TenantStatus.ACTIVE },
      data: { status: TenantStatus.SUSPENDED },
    });
    expect(h.audits).toEqual([
      {
        tenantId: OPERATOR_ID,
        input: expect.objectContaining({
          action: 'tenant.suspended',
          actor: { type: 'ADMIN', id: ACTOR_ID },
          subjectType: 'Tenant',
          subjectId: OPERATOR_ID,
          before: { status: 'ACTIVE' },
          after: { status: 'SUSPENDED' },
        }),
      },
    ]);

    expect(h.registry.invalidate).toHaveBeenCalledWith(OPERATOR_ID);
    expect(h.bots.invalidate).toHaveBeenCalledWith(OPERATOR_ID);
    expect(h.initData.invalidate).toHaveBeenCalledWith(OPERATOR_ID);
  });

  it('records one decision when a concurrent suspend already won the row', async () => {
    const h = harness(operatorRow(), { after: operatorRow({ status: TenantStatus.SUSPENDED }) });
    h.tx.tenant.updateMany.mockResolvedValue({ count: 0 });

    await h.service.suspend(ACTOR_ID, OPERATOR_ID);

    expect(h.audits).toHaveLength(0);
  });

  it('answers an already suspended operator without writing, and still evicts', async () => {
    const h = harness(operatorRow({ status: TenantStatus.SUSPENDED }));

    const view = await h.service.suspend(ACTOR_ID, OPERATOR_ID);

    expect(view.status).toBe('SUSPENDED');
    expect(h.tx.tenant.updateMany).not.toHaveBeenCalled();
    expect(h.audits).toHaveLength(0);
    expect(h.bots.invalidate).toHaveBeenCalledWith(OPERATOR_ID);
  });

  it('refuses tenant zero before touching the database', async () => {
    const h = harness(operatorRow({ id: TENANT_ZERO_ID }));

    await expect(h.service.suspend(ACTOR_ID, TENANT_ZERO_ID)).rejects.toMatchObject({
      httpStatus: 422,
      errorCode: 'TENANT_PLATFORM_LOCKED',
    });
    expect(h.prisma.runInTransaction).not.toHaveBeenCalled();
    expect(h.registry.invalidate).not.toHaveBeenCalled();
  });

  it('refuses a CLOSED operator and an unknown id', async () => {
    const closed = harness(operatorRow({ status: TenantStatus.CLOSED }));
    await expect(closed.service.suspend(ACTOR_ID, OPERATOR_ID)).rejects.toMatchObject({
      httpStatus: 422,
      errorCode: 'TENANT_CLOSED',
    });
    expect(closed.bots.invalidate).not.toHaveBeenCalled();

    const missing = harness(null);
    await expect(missing.service.suspend(ACTOR_ID, OPERATOR_ID)).rejects.toMatchObject({
      httpStatus: 404,
      errorCode: 'TENANT_NOT_FOUND',
    });
  });
});

describe('TenantAdminService.evictOperator', () => {
  it('drops exactly the three caches a suspension drops, so an activation can reuse it', async () => {
    const h = harness(operatorRow());

    await h.service.evictOperator(OPERATOR_ID);

    expect(h.registry.invalidate).toHaveBeenCalledWith(OPERATOR_ID);
    expect(h.bots.invalidate).toHaveBeenCalledWith(OPERATOR_ID);
    expect(h.initData.invalidate).toHaveBeenCalledWith(OPERATOR_ID);
  });
});

describe('TenantAdminService.update', () => {
  it('refuses slug and currencyCode by name, before any read', async () => {
    const h = harness(operatorRow());

    await expect(
      h.service.update(ACTOR_ID, OPERATOR_ID, { slug: 'renamed', displayName: 'New name' }),
    ).rejects.toMatchObject({
      httpStatus: 400,
      errorCode: 'TENANT_FIELD_IMMUTABLE',
      details: { fields: ['slug cannot be changed after creation'] },
    });
    expect(h.prisma.runInTransaction).not.toHaveBeenCalled();
  });

  it("writes and audits only the fields that changed, in the operator's log", async () => {
    const h = harness(operatorRow());
    h.tx.tenant.update.mockResolvedValue(
      operatorRow({ dualApprovalThresholdMinor: 75_000_000n, miniAppUrl: 'https://cashier.example.app' }),
    );

    const view = await h.service.update(ACTOR_ID, OPERATOR_ID, {
      displayName: 'Northern branch',
      dualApprovalThresholdMinor: '75000000',
      miniAppUrl: 'https://cashier.example.app',
    });

    expect(view.dualApprovalThresholdMinor).toBe('75000000');
    expect(h.tx.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: OPERATOR_ID },
        data: { dualApprovalThresholdMinor: 75_000_000n, miniAppUrl: 'https://cashier.example.app' },
      }),
    );
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      tenantId: OPERATOR_ID,
      input: {
        action: 'tenant.updated',
        before: { dualApprovalThresholdMinor: 30_000_000n, miniAppUrl: null },
        after: { dualApprovalThresholdMinor: 75_000_000n, miniAppUrl: 'https://cashier.example.app' },
      },
    });
    expect(h.registry.invalidate).toHaveBeenCalledWith(OPERATOR_ID);
  });

  it('writes nothing for a save that changes nothing', async () => {
    const h = harness(operatorRow());

    await h.service.update(ACTOR_ID, OPERATOR_ID, {
      displayName: 'Northern branch',
      adminChatId: '-1001234567890',
    });

    expect(h.tx.tenant.update).not.toHaveBeenCalled();
    expect(h.audits).toHaveLength(0);
    expect(h.registry.invalidate).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown operator', async () => {
    await expect(
      harness(null).service.update(ACTOR_ID, OPERATOR_ID, { displayName: 'x' }),
    ).rejects.toMatchObject({ httpStatus: 404, errorCode: 'TENANT_NOT_FOUND' });
  });
});
