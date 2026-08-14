/**
 * I1 / I2 / I3, every fifteen minutes.
 *
 *   I1  every transaction sums to zero, and none is single-sided
 *   I2  the ledger as a whole sums to zero, per currency
 *   I3  every account's cached balance equals the sum of its entries
 *
 * WHY run these when the database already enforces the zero-sum with a deferrable constraint
 * trigger: the trigger guarantees every transaction was balanced AT THE MOMENT IT COMMITTED. It says
 * nothing about a restored backup, about a DBA who ran with triggers disabled, or about the advisory
 * cache in `ledger_accounts.cached_balance_minor` drifting from the entries. I3 in particular is not
 * a "money is missing" alarm — it is the number the APPROVAL path reads to decide whether the agent
 * float can cover a credit, so a drift there is how an unfundable approval gets through.
 *
 * WHY a violation becomes a ReconciliationBreak rather than a log line: a log line is read by
 * whoever happens to be looking. A break is a row with a severity, an owner and a resolution, and it
 * survives a deploy.
 *
 * WHY I3 is repaired automatically and I1/I2 are not: recomputing a cache from the entries that are
 * the truth is a safe, reversible operation. Repairing an unbalanced TRANSACTION would mean inventing
 * a ledger entry, which is exactly the thing no automated process may ever do.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { BreakCategory } from '@prisma/client';

import { LockService } from '@core/cache/lock.service';
import { AppConfigService } from '@core/config/config.service';
import { InvariantsService, type LedgerInvariantReport } from '@core/ledger';
import { PrismaService } from '@core/prisma/prisma.service';
import { BotService } from '@core/telegram/services/bot.service';

import {
  breakKeys,
  INVARIANT_CHECK_INTERVAL_MS,
  INVARIANT_ROW_LIMIT,
  RECON_LOCK_TTL_MS,
} from '../reconciliation.constants';
import { ReconciliationBreakService } from './reconciliation-break.service';

/** I1/I2 mean the books do not add up. Nothing in this system is more serious. */
const SEVERITY_LEDGER_IMBALANCE = 5;
/** I3 is a lying cache: serious, but no money has moved anywhere it should not have. */
const SEVERITY_CACHE_DRIFT = 3;

@Injectable()
export class InvariantCheckCron {
  private readonly logger = new Logger(InvariantCheckCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly invariants: InvariantsService,
    private readonly breaks: ReconciliationBreakService,
    private readonly locks: LockService,
    private readonly bot: BotService,
    private readonly config: AppConfigService,
  ) {}

  @Interval('ledger-invariants', INVARIANT_CHECK_INTERVAL_MS)
  async tick(): Promise<void> {
    if (!this.config.app.isWorker) return;

    const handle = await this.locks.acquire(
      LockService.key('cron', 'ledger-invariants'),
      RECON_LOCK_TTL_MS,
    );
    if (handle === null) return;

    try {
      const report = await this.runOnce();
      if (!report.ok) await this.alert(report);
    } catch (cause) {
      this.logger.error(
        `invariant check failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      await this.locks.release(handle).catch(() => false);
    }
  }

  /** Exposed for the admin endpoint and for tests. */
  async runOnce(): Promise<LedgerInvariantReport> {
    const report = await this.prisma.runInTransaction((tx) =>
      this.invariants.checkAll(tx, INVARIANT_ROW_LIMIT),
    );

    for (const violation of report.violations) {
      const isCacheDrift = violation.invariant === 'I3_ACCOUNT_BALANCE_MATCHES_ENTRIES';

      await this.breaks.observeStandalone({
        // BreakCategory has no separate member for a cache drift; the severity is what tells an
        // operator whether the books are wrong or only the number the approval path reads is.
        category: BreakCategory.LEDGER_IMBALANCE,
        severity: isCacheDrift ? SEVERITY_CACHE_DRIFT : SEVERITY_LEDGER_IMBALANCE,
        currencyCode: violation.currencyCode,
        dedupeKey: breakKeys.invariant(violation.invariant, violation.subject),
        expectedMinor: violation.expectedMinor,
        actualMinor: violation.actualMinor,
        ...(isCacheDrift ? { ledgerAccountId: violation.subject } : {}),
        detail: {
          invariant: violation.invariant,
          subject: violation.subject,
          message: violation.detail,
          truncated: report.truncated,
        },
      });

      // I3 only: rewrite the cache from the entries, which are the truth. Detection and repair live
      // next to each other on purpose — a repair that drifts from its detector fixes the wrong thing.
      if (isCacheDrift) {
        const repaired = await this.prisma.runInTransaction((tx) =>
          this.invariants.recomputeAccountCache(tx, violation.subject),
        );
        this.logger.warn(
          `repaired cached balance for account ${violation.subject}: ` +
            `${violation.actualMinor.toString()} -> ${repaired.toString()}`,
        );
      }
    }

    if (report.ok) {
      this.logger.debug('ledger invariants OK');
    } else {
      this.logger.error(`ledger invariants: ${report.violations.length} violation(s)`);
    }
    return report;
  }

  /**
   * One message, not one per violation: a broken ledger can produce a hundred rows and a hundred
   * alerts is an alert nobody reads. Sent through BotService directly rather than through a queue —
   * an alert that waits behind a backlog of review cards is an alert that arrives too late.
   */
  private async alert(report: LedgerInvariantReport): Promise<void> {
    const worst = report.violations.filter(
      (violation) => violation.invariant !== 'I3_ACCOUNT_BALANCE_MATCHES_ENTRIES',
    );
    const lines = [
      `🚨 <b>LEDGER INVARIANTS FAILED</b>`,
      `${report.violations.length} violation(s)${report.truncated ? ' (truncated)' : ''}`,
      '',
      ...report.violations.slice(0, 8).map((violation) => `• ${violation.detail}`),
    ];
    if (worst.length > 0) {
      lines.push('', '<b>At least one is a real imbalance, not a cache drift.</b>');
    }
    await this.bot.notifyAdmins(lines.join('\n'), { parseMode: 'HTML', linkPreview: false });
  }
}
