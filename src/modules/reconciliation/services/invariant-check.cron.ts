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
 *
 * ══ WHOSE BOOKS ═════════════════════════════════════════════════════════════════════════════
 * The checks are raw aggregates over the whole ledger, so ONE pass finds violations belonging to
 * every operator at once — the "scan across operators, then handle each finding in its own context"
 * sweep shape. A break is then filed against the operator that owns the offending ROW: the
 * transaction for I1, the account for I3, looked up here because LedgerInvariantViolation carries
 * only a subject id. `runAsPlatform()` would file an operator's imbalance against the platform,
 * where the people who can fix it will never see it.
 *
 * I2 is the exception and the one real gap: "all SYP entries sum to X" is a number computed across
 * every operator's entries and names no owner, so it cannot become a break. It is logged and
 * alerted, never filed. Closing that needs InvariantsService to group I2 by tenant and carry a
 * tenantId on every violation.
 *
 * WHY a request narrows the report: an admin pressing "run invariants" is inside their own tenant
 * context, and the raw scan has just read every operator's ledger. Handing back another operator's
 * transaction ids — or a cross-operator total — would make this endpoint a disclosure, so when a
 * context exists the report is narrowed to that operator's own findings and only those open breaks.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { BreakCategory } from '@prisma/client';

import { LockService } from '@core/cache/lock.service';
import { AppConfigService } from '@core/config/config.service';
import {
  InvariantsService,
  type LedgerInvariantReport,
  type LedgerInvariantViolation,
} from '@core/ledger';
import { PrismaService } from '@core/prisma/prisma.service';
import { acrossTenants } from '@core/prisma/tenant-scope.extension';
import { BotService } from '@core/telegram/services/bot.service';
import { getEffectiveTenantId, runWithTenant } from '@core/tenant';

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

    // Undefined on the cron tick, which is what makes this a sweep of every operator. Set when an
    // admin ran it from a request, and then it is both the filter on what comes back and the limit
    // on which operators' breaks this run may touch.
    const scope = getEffectiveTenantId();
    const visible: LedgerInvariantViolation[] = [];
    let unattributed = 0;

    for (const violation of report.violations) {
      const tenantId = await this.ownerOf(violation);

      if (tenantId === null) {
        // I2, or a subject row that has since been deleted. Nothing to file it against, and
        // guessing an owner for a money break is worse than an alert with no row behind it.
        unattributed += 1;
        this.logger.error(`unattributable ledger violation, no break opened: ${violation.detail}`);
        if (scope === undefined) visible.push(violation);
        continue;
      }
      if (scope !== undefined && tenantId !== scope) continue;

      visible.push(violation);
      await runWithTenant(tenantId, () => this.record(tenantId, violation, report.truncated));
    }

    if (visible.length === 0) {
      this.logger.debug('ledger invariants OK');
    } else {
      this.logger.error(
        `ledger invariants: ${visible.length} violation(s)` +
          (unattributed > 0 ? `, ${unattributed} with no owner` : ''),
      );
    }

    // Rebuilt rather than returned as-is: `ok` has to agree with the violations actually being
    // handed back, or a narrowed report would say "failed" while listing nothing.
    return {
      ok: visible.length === 0,
      checkedAt: report.checkedAt,
      violations: visible,
      truncated: report.truncated,
    };
  }

  /**
   * Open (or re-observe) the break for one violation, and repair it when repairing is safe. Always
   * called inside the owning operator's context.
   */
  private async record(
    tenantId: string,
    violation: LedgerInvariantViolation,
    truncated: boolean,
  ): Promise<void> {
    const isCacheDrift = violation.invariant === 'I3_ACCOUNT_BALANCE_MATCHES_ENTRIES';

    await this.breaks.observeStandalone({
      // From the offending row, not from the ambient context: the sweep enters a context per
      // finding, and the row it examined is the more authoritative of the two.
      tenantId,
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
        truncated,
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

  /**
   * The operator a violation belongs to, or null when nothing can name one.
   *
   * The lookups carry ALL_TENANTS because they must answer the same way whether this run is a
   * context-less sweep or an admin request standing in one operator: scoped to the caller, a
   * transaction id from another operator would come back empty and a real imbalance would be
   * dismissed as "no owner". Reading the id is all it does; what the caller may then DO with the
   * finding is decided against `scope` above.
   */
  private async ownerOf(violation: LedgerInvariantViolation): Promise<string | null> {
    if (violation.invariant === 'I2_GLOBAL_ZERO_SUM') {
      // The subject is a currency code and the sum spans every operator's entries, so there is no
      // one book to blame. See the header.
      return null;
    }

    if (violation.invariant === 'I3_ACCOUNT_BALANCE_MATCHES_ENTRIES') {
      const account = await this.prisma.ledgerAccount.findFirst({
        where: acrossTenants({ id: violation.subject }),
        select: { tenantId: true },
      });
      return account?.tenantId ?? null;
    }

    const transaction = await this.prisma.ledgerTransaction.findFirst({
      where: acrossTenants({ id: violation.subject }),
      select: { tenantId: true },
    });
    return transaction?.tenantId ?? null;
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
    // Admins ONLY — never the feed: "our books do not add up" is an internal engineering signal, and
    // in a group that may contain customers it reads as "your money is missing". A PLATFORM alert:
    // one check spans every operator's ledger, so no single operator's bot is the sender, and it is
    // not delivered until platform alerts are given a destination. The error log above still fires.
    await this.bot.notifyPlatformAdmins(lines.join('\n'), {
      parseMode: 'HTML',
      linkPreview: false,
    });
  }
}
