/**
 * AgentFloatSyncService.sync in both Ichancy modes, every collaborator faked. Under ICHANCY_FAKE the
 * wallet is a fixture: the sync must not read it, must not open a break from it, and must say why the
 * Ichancy side is empty (`ichancyFake`) so the console does not report an outage or a drift.
 */
import type { LockService } from '@core/cache/lock.service';
import type { RedisService } from '@core/cache/redis.service';
import type { AppConfigService } from '@core/config/config.service';
import type { IchancyPort } from '@core/ichancy';
import type { AccountRegistryService, LedgerService } from '@core/ledger';
import type { PrismaService } from '@core/prisma/prisma.service';
import type { BotService } from '@core/telegram/services/bot.service';
import { runWithTenant } from '@core/tenant/tenant.storage';

import { AgentFloatSyncService } from './agent-float-sync.service';
import type { ReconciliationBreakService } from './reconciliation-break.service';

const OPERATOR_ID = '11111111-1111-4111-8111-111111111111';
const LEDGER_MINOR = 10_000_000n;

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
