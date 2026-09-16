/**
 * AgentFloatSyncService: the comparison itself, and WHO the five-minute sweep compares.
 *
 * The comparison — under ICHANCY_FAKE the wallet is a fixture: the sync must not read it, must not
 * open a break from it, and must say why the Ichancy side is empty (`ichancyFake`) so the console
 * does not report an outage or a drift.
 *
 * Who is swept — tenant zero is the PLATFORM. By design it has no Ichancy agent, so asking for its
 * wallet is refused with ICHANCY_PLATFORM_HAS_NO_AGENT, and the sweep logged that refusal at ERROR
 * twelve times an hour for a tenant whose float cannot exist. An error that is never a problem is
 * how an owner learns to skim past the log, and that log is where a REAL operator's drift has to be
 * visible. So the sweep skips the platform outright — and only the sweep: a person who points the
 * console at tenant zero still gets the explicit refusal, which is the last test in this file.
 */
import { Logger } from '@nestjs/common';

import type { LockHandle, LockService } from '@core/cache/lock.service';
import type { RedisService } from '@core/cache/redis.service';
import type { AppConfigService } from '@core/config/config.service';
import type { IchancyPort } from '@core/ichancy';
import type { AccountRegistryService, LedgerService } from '@core/ledger';
import type { PrismaService } from '@core/prisma/prisma.service';
import type { BotService } from '@core/telegram/services/bot.service';
import { TENANT_ZERO_ID } from '@core/tenant/tenant.constants';
import { getEffectiveTenantId, runWithTenant } from '@core/tenant/tenant.storage';

import { AgentFloatSyncService } from './agent-float-sync.service';
import type { ReconciliationBreakService } from './reconciliation-break.service';

const OPERATOR_ID = '11111111-1111-4111-8111-111111111111';
const SUSPENDED_ID = '22222222-2222-4222-8222-222222222222';
const LEDGER_MINOR = 10_000_000n;

const WALLET_IN_SYNC = {
  kind: 'ok',
  data: { balanceMinor: LEDGER_MINOR, availableMinor: LEDGER_MINOR },
};

/** What the resolver answers for tenant zero, verbatim from TenantIchancyAgentResolver.forTenant. */
const PLATFORM_HAS_NO_AGENT = {
  kind: 'rejected',
  code: 'ICHANCY_PLATFORM_HAS_NO_AGENT',
  message: 'Tenant zero is the platform and has no Ichancy agent. Point the request at an operator.',
};

let errorSpy: jest.SpyInstance;

beforeEach(() => {
  for (const level of ['log', 'warn', 'debug'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
  errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Every line the service logged at ERROR. The defect was visible only here. */
const errorLogs = (): string[] =>
  (errorSpy.mock.calls as unknown[][]).map((call) => String(call[0]));

function harness(fake: boolean) {
  const accounts = {
    findByCode: jest.fn().mockResolvedValue({ id: 'float-account' }),
    computeBalanceFromEntries: jest.fn().mockResolvedValue(LEDGER_MINOR),
  };
  const breaks = { observeStandalone: jest.fn().mockResolvedValue({ id: 'break-1' }) };
  const port = { getAgentWallet: jest.fn() };
  const redis = { set: jest.fn().mockResolvedValue(null) };
  const bot = { notifyAdmins: jest.fn() };
  // A zero watermark keeps the low-float warning out of these cases; it is not what they test.
  const config = { ichancy: { fake }, limits: { agentFloatLowWatermarkMinor: 0n } };

  const service = new AgentFloatSyncService(
    {} as unknown as PrismaService,
    accounts as unknown as AccountRegistryService,
    {} as unknown as LedgerService,
    breaks as unknown as ReconciliationBreakService,
    {} as unknown as LockService,
    bot as unknown as BotService,
    config as unknown as AppConfigService,
    redis as unknown as RedisService,
    port as unknown as IchancyPort,
  );
  const sync = () => runWithTenant(OPERATOR_ID, () => service.sync('NSP'));
  return { sync, port, breaks, bot };
}

describe('AgentFloatSyncService.sync', () => {
  it('under ICHANCY_FAKE reads no wallet, opens no break, and says the comparison was not made', async () => {
    const h = harness(true);

    expect(await h.sync()).toEqual({
      currencyCode: 'NSP',
      ledgerMinor: LEDGER_MINOR,
      ichancyMinor: null,
      deltaMinor: null,
      breakId: null,
      belowWatermark: false,
      ichancyFake: true,
    });
    expect(h.port.getAgentWallet).not.toHaveBeenCalled();
    expect(h.breaks.observeStandalone).not.toHaveBeenCalled();
    expect(h.bot.notifyAdmins).not.toHaveBeenCalled();
  });

  it('in real mode compares the wallet with the ledger, unchanged, with ichancyFake false', async () => {
    const h = harness(false);
    h.port.getAgentWallet.mockResolvedValue({
      kind: 'ok',
      data: { balanceMinor: LEDGER_MINOR, availableMinor: LEDGER_MINOR },
    });

    expect(await h.sync()).toEqual({
      currencyCode: 'NSP',
      ledgerMinor: LEDGER_MINOR,
      ichancyMinor: LEDGER_MINOR,
      deltaMinor: 0n,
      breakId: null,
      belowWatermark: false,
      ichancyFake: false,
    });
    expect(h.breaks.observeStandalone).not.toHaveBeenCalled();
  });

  it('in real mode still opens a break on drift', async () => {
    const h = harness(false);
    h.port.getAgentWallet.mockResolvedValue({
      kind: 'ok',
      data: { balanceMinor: 9_000_000n, availableMinor: 9_000_000n },
    });

    expect(await h.sync()).toMatchObject({
      ichancyMinor: 9_000_000n,
      deltaMinor: -1_000_000n,
      breakId: 'break-1',
      ichancyFake: false,
    });
    expect(h.breaks.observeStandalone).toHaveBeenCalledTimes(1);
  });

  it('in real mode reports an unreadable wallet as null, not as fake', async () => {
    const h = harness(false);
    h.port.getAgentWallet.mockResolvedValue({ kind: 'ambiguous', cause: 'timeout' });

    expect(await h.sync()).toMatchObject({ ichancyMinor: null, breakId: null, ichancyFake: false });
  });
});

// ── the sweep ──────────────────────────────────────────────────────────────────────────────────

interface TenantRow {
  id: string;
  slug: string;
  currencyCode: string;
  status: 'ACTIVE' | 'SUSPENDED';
}

const PLATFORM: TenantRow = {
  id: TENANT_ZERO_ID,
  slug: 'platform',
  currencyCode: 'NSP',
  status: 'ACTIVE',
};
const OPERATOR: TenantRow = {
  id: OPERATOR_ID,
  slug: 'alpha',
  currencyCode: 'NSP',
  status: 'ACTIVE',
};
const SUSPENDED: TenantRow = {
  id: SUSPENDED_ID,
  slug: 'beta',
  currencyCode: 'NSP',
  status: 'SUSPENDED',
};

const HANDLE: LockHandle = {
  key: 'lock:cron:agent-float-sync',
  token: 'token',
  acquiredAt: 0,
  ttlMs: 1_000,
};

/**
 * Enough of `prisma.tenant.findMany` to ANSWER the sweep's query rather than merely record it: the
 * `where` is applied to these rows. So a sweep that stops excluding the platform gets the platform
 * back and reads its wallet — failing exactly where the deployed worker's log did, instead of
 * passing on an assertion about a query string.
 */
const fakeTenantTable = (rows: readonly TenantRow[]): jest.Mock =>
  jest.fn((args: { where: { status?: string; id?: { not?: string } } }) =>
    Promise.resolve(
      rows
        .filter((row) => args.where.status === undefined || row.status === args.where.status)
        .filter((row) => args.where.id?.not === undefined || row.id !== args.where.id.not)
        .sort((left, right) => left.slug.localeCompare(right.slug))
        .map((row) => ({ id: row.id, currencyCode: row.currencyCode })),
    ),
  );

function sweep(rows: readonly TenantRow[]) {
  const findMany = fakeTenantTable(rows);
  /** Whose wallet was actually read, as the tenant context stood at the moment of the call. */
  const walletReads: (string | undefined)[] = [];
  const port = { getAgentWallet: jest.fn() };
  port.getAgentWallet.mockImplementation(() => {
    walletReads.push(getEffectiveTenantId());
    return Promise.resolve(WALLET_IN_SYNC);
  });

  const accounts = {
    findByCode: jest.fn().mockResolvedValue({ id: 'float-account' }),
    computeBalanceFromEntries: jest.fn().mockResolvedValue(LEDGER_MINOR),
  };
  const locks = {
    acquire: jest.fn().mockResolvedValue(HANDLE),
    release: jest.fn().mockResolvedValue(true),
  };

  const service = new AgentFloatSyncService(
    { tenant: { findMany } } as unknown as PrismaService,
    accounts as unknown as AccountRegistryService,
    {} as unknown as LedgerService,
    { observeStandalone: jest.fn().mockResolvedValue({ id: 'break-1' }) } as unknown as ReconciliationBreakService,
    locks as unknown as LockService,
    { notifyAdmins: jest.fn() } as unknown as BotService,
    {
      app: { isWorker: true },
      ichancy: { fake: false },
      limits: { agentFloatLowWatermarkMinor: 0n },
    } as unknown as AppConfigService,
    { set: jest.fn().mockResolvedValue(null) } as unknown as RedisService,
    port as unknown as IchancyPort,
  );
  return { service, findMany, port, walletReads };
}

describe('AgentFloatSyncService.tick (the five-minute sweep)', () => {
  it('never asks the platform for a wallet, and logs no error about it', async () => {
    // The deployed worker logged ICHANCY_PLATFORM_HAS_NO_AGENT at ERROR every five minutes. Tenant
    // zero is ACTIVE by seed, so only an explicit exclusion keeps it out of the sweep.
    const h = sweep([PLATFORM, OPERATOR]);

    await h.service.tick();

    expect(h.walletReads).toEqual([OPERATOR_ID]);
    expect(errorLogs()).toEqual([]);
  });

  it('still syncs an ordinary operator, and leaves a suspended one alone', async () => {
    const h = sweep([PLATFORM, OPERATOR, SUSPENDED]);

    await h.service.tick();

    // The point of the sweep survives the fix: the operator IS compared, in its own context.
    expect(h.port.getAgentWallet).toHaveBeenCalledTimes(1);
    expect(h.walletReads).toEqual([OPERATOR_ID]);
  });

  it('asks for ACTIVE operators only, with the platform excluded by id', async () => {
    const h = sweep([OPERATOR]);

    await h.service.tick();

    // Named in the query — a skip that is stated, not an exception swallowed further down.
    expect(h.findMany).toHaveBeenCalledWith({
      where: { status: 'ACTIVE', id: { not: TENANT_ZERO_ID } },
      select: { id: true, currencyCode: true },
      orderBy: { slug: 'asc' },
    });
  });
});

describe('AgentFloatSyncService.sync pointed at the platform (the manual path)', () => {
  it('still attempts the read and reports ICHANCY_PLATFORM_HAS_NO_AGENT', async () => {
    const h = sweep([]);
    h.port.getAgentWallet.mockImplementation(() => Promise.resolve(PLATFORM_HAS_NO_AGENT));

    const result = await runWithTenant(TENANT_ZERO_ID, () => h.service.sync('NSP'));

    // The SWEEP skips tenant zero. A person who points the console at it must still get the
    // explicit answer rather than silence, so nothing here may short-circuit on the id.
    expect(h.port.getAgentWallet).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ichancyMinor: null,
      deltaMinor: null,
      breakId: null,
      ichancyFake: false,
    });
    expect(errorLogs().join(' ')).toContain('ICHANCY_PLATFORM_HAS_NO_AGENT');
  });
});
