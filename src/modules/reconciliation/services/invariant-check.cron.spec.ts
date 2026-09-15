/**
 * Who hears that the books do not add up: the operator that owns the offending rows, in its own
 * admin group, about its own violations only — and nobody at all for a violation no operator owns.
 */
import { Logger } from '@nestjs/common';

import { type LockService } from '@core/cache/lock.service';
import { type AppConfigService } from '@core/config/config.service';
import {
  type InvariantsService,
  type LedgerInvariantReport,
  type LedgerInvariantViolation,
} from '@core/ledger';
import { type PrismaService } from '@core/prisma/prisma.service';
import { type BotService } from '@core/telegram/services/bot.service';

import { InvariantCheckCron } from './invariant-check.cron';
import { type ReconciliationBreakService } from './reconciliation-break.service';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

const violation = (
  invariant: LedgerInvariantViolation['invariant'],
  subject: string,
  detail: string,
): LedgerInvariantViolation => ({
  invariant,
  subject,
  currencyCode: 'NSP',
  expectedMinor: 0n,
  actualMinor: 5n,
  deltaMinor: 5n,
  detail,
});

const TX_A = violation('I1_TRANSACTION_ZERO_SUM', 'tx-a', 'transaction tx-a is unbalanced');
const TX_B = violation('I1_TRANSACTION_ZERO_SUM', 'tx-b', 'transaction tx-b is unbalanced');
const GLOBAL = violation('I2_GLOBAL_ZERO_SUM', 'NSP', 'all NSP entries sum to 5');

function build(violations: LedgerInvariantViolation[]): {
  cron: InvariantCheckCron;
  notifyAdmins: jest.Mock;
} {
  const report: LedgerInvariantReport = {
    ok: violations.length === 0,
    checkedAt: new Date('2026-09-15T00:00:00.000Z'),
    violations,
    truncated: false,
  };
  const owners: Record<string, string> = { 'tx-a': TENANT_A, 'tx-b': TENANT_B };
  const notifyAdmins = jest.fn().mockResolvedValue({ message_id: 1 });

  const cron = new InvariantCheckCron(
    {
      runInTransaction: (body: (tx: unknown) => unknown) => body({}),
      ledgerTransaction: {
        findFirst: (args: { where: { id: string } }) =>
          Promise.resolve(
            owners[args.where.id] === undefined ? null : { tenantId: owners[args.where.id] },
          ),
      },
      ledgerAccount: { findFirst: () => Promise.resolve(null) },
    } as unknown as PrismaService,
    {
      checkAll: jest.fn().mockResolvedValue(report),
      recomputeAccountCache: jest.fn().mockResolvedValue(0n),
    } as unknown as InvariantsService,
    { observeStandalone: jest.fn().mockResolvedValue({}) } as unknown as ReconciliationBreakService,
    {
      acquire: jest.fn().mockResolvedValue({ key: 'k', token: 't', acquiredAt: 0, ttlMs: 1 }),
      release: jest.fn().mockResolvedValue(true),
    } as unknown as LockService,
    { notifyAdmins } as unknown as BotService,
    { app: { isWorker: true } } as unknown as AppConfigService,
  );
  return { cron, notifyAdmins };
}

describe('InvariantCheckCron alerts', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    for (const level of ['log', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('tells each owning operator about its own violations only', async () => {
    const { cron, notifyAdmins } = build([TX_A, TX_B, GLOBAL]);

    await cron.tick();

    expect(notifyAdmins).toHaveBeenCalledTimes(2);
    const byTenant = new Map(
      (notifyAdmins.mock.calls as unknown[][]).map((call) => [call[0], call[1] as string]),
    );
    expect(byTenant.get(TENANT_A)).toContain('tx-a');
    expect(byTenant.get(TENANT_A)).not.toContain('tx-b');
    expect(byTenant.get(TENANT_B)).toContain('tx-b');
    expect(byTenant.get(TENANT_B)).not.toContain('tx-a');
  });

  it('sends a violation no operator owns to nobody, and says so', async () => {
    const { cron, notifyAdmins } = build([GLOBAL]);

    await cron.tick();

    expect(notifyAdmins).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no owning operator'));
  });

  it('does not let one operator’s broken bot cost another its alert', async () => {
    const { cron, notifyAdmins } = build([TX_A, TX_B]);
    notifyAdmins.mockImplementation((tenantId: string) =>
      tenantId === TENANT_A ? Promise.reject(new Error('bot token revoked')) : Promise.resolve({}),
    );

    await cron.tick();

    expect(notifyAdmins).toHaveBeenCalledWith(TENANT_B, expect.any(String), expect.any(Object));
  });

  it('sends nothing when the books add up', async () => {
    const { cron, notifyAdmins } = build([]);

    await cron.tick();

    expect(notifyAdmins).not.toHaveBeenCalled();
  });
});
