/**
 * The RAIL_CLEARING ageing report.
 *
 * WHAT IT MEASURES: T1 moves money into RAIL_CLEARING ("we believe this is on its way to us") and
 * railSettled moves it out again when a bank statement confirms it. Anything still sitting in that
 * account is money we have already credited a player for and have NOT yet seen arrive. Fresh
 * balances there are normal — rails take hours. Balances that keep ageing are the earliest possible
 * signal of a fake receipt that a reviewer accepted, or of a rail whose statements stopped importing.
 *
 * WHY it is bucketed by AGE rather than reported as one total: a clearing account with 50k in it
 * says nothing on its own. The same 50k, all of it older than thirty days, is a loss that has not
 * been written down yet. The buckets are what turn one number into a question with an answer.
 *
 * WHY it reads ENTRIES rather than the account cache: the cache holds a single current balance and
 * has no age. The ageing has to come from `ledger_entries.created_at`, which is also why the query
 * is raw SQL — it is a bucketed aggregate, not a row fetch.
 *
 * NOTE this is FIFO-by-assumption: it ages the NET balance against the oldest debits, which is the
 * standard clearing-account convention. It is a report, not a posting, so the assumption costs
 * nothing beyond how the same money is labelled.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { BreakCategory } from '@prisma/client';

import { formatMinorToDecimal } from '@common/helpers/money.util';
import { LockService } from '@core/cache/lock.service';
import { AppConfigService } from '@core/config/config.service';
import { PrismaService } from '@core/prisma/prisma.service';

import {
  breakKeys,
  RAIL_AGEING_BUCKET_DAYS,
  RAIL_AGEING_INTERVAL_MS,
  RECON_LOCK_TTL_MS,
  utcDay,
} from '../reconciliation.constants';
import { ReconciliationBreakService } from './reconciliation-break.service';

export interface RailAgeingBucket {
  /** Human label: "0-1d", "1-3d", "3-7d", "7-30d", "30d+". */
  label: string;
  /** Inclusive lower bound in days. */
  fromDays: number;
  /** Exclusive upper bound, or null for the open-ended last bucket. */
  toDays: number | null;
  debitMinor: string;
  creditMinor: string;
  netMinor: string;
  entryCount: number;
}

export interface RailAgeingRow {
  accountId: string;
  accountCode: string;
  currencyCode: string;
  paymentMethodId: string | null;
  balanceMinor: string;
  oldestUnsettledAt: string | null;
  buckets: RailAgeingBucket[];
}

export interface RailAgeingReport {
  generatedAt: string;
  rows: RailAgeingRow[];
  /** Accounts whose net balance is older than the last bucket boundary. These are the problems. */
  staleAccountCodes: string[];
}

interface RawAgeingRow {
  account_id: string;
  account_code: string;
  currency_code: string;
  payment_method_id: string | null;
  bucket: number;
  debit_minor: bigint;
  credit_minor: bigint;
  entry_count: number;
  oldest_at: Date | null;
}

/** Money that has been "in transit" past the last bucket is a real risk of loss. */
const SEVERITY_STALE_CLEARING = 4;

@Injectable()
export class RailAgeingService {
  private readonly logger = new Logger(RailAgeingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly breaks: ReconciliationBreakService,
    private readonly locks: LockService,
    private readonly config: AppConfigService,
  ) {}

  @Interval('rail-ageing', RAIL_AGEING_INTERVAL_MS)
  async tick(): Promise<void> {
    if (!this.config.app.isWorker) return;

    const handle = await this.locks.acquire(
      LockService.key('cron', 'rail-ageing'),
      RECON_LOCK_TTL_MS,
    );
    if (handle === null) return;

    try {
      const report = await this.report();
      for (const code of report.staleAccountCodes) {
        const row = report.rows.find((candidate) => candidate.accountCode === code);
        if (row === undefined) continue;
        await this.breaks.observeStandalone({
          category: BreakCategory.UNIDENTIFIED_RECEIPT,
          severity: SEVERITY_STALE_CLEARING,
          currencyCode: row.currencyCode,
          dedupeKey: breakKeys.railAgeing(code, utcDay()),
          // Expected: a clearing account that is doing its job holds nothing this old.
          expectedMinor: 0n,
          actualMinor: BigInt(row.balanceMinor),
          ledgerAccountId: row.accountId,
          detail: {
            accountCode: code,
            oldestUnsettledAt: row.oldestUnsettledAt,
            buckets: row.buckets,
            hint:
              'Money credited to players that the rail has still not confirmed. ' +
              'Check the statement import for this payment method before writing anything off.',
          },
        });
      }
    } catch (cause) {
      this.logger.error(
        `rail ageing report failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      await this.locks.release(handle).catch(() => false);
    }
  }

  async report(now: Date = new Date()): Promise<RailAgeingReport> {
    const boundaries = [...RAIL_AGEING_BUCKET_DAYS];
    const rows = await this.prisma.$queryRaw<RawAgeingRow[]>`
      SELECT a.id::text                 AS account_id,
             a.code                     AS account_code,
             a.currency_code,
             a.payment_method_id::text  AS payment_method_id,
             CASE
               WHEN e.created_at > ${now}::timestamptz - make_interval(days => ${boundaries[0] ?? 1}) THEN 0
               WHEN e.created_at > ${now}::timestamptz - make_interval(days => ${boundaries[1] ?? 3}) THEN 1
               WHEN e.created_at > ${now}::timestamptz - make_interval(days => ${boundaries[2] ?? 7}) THEN 2
               WHEN e.created_at > ${now}::timestamptz - make_interval(days => ${boundaries[3] ?? 30}) THEN 3
               ELSE 4
             END                                                    AS bucket,
             COALESCE(SUM(e.amount_minor) FILTER (WHERE e.amount_minor > 0), 0)::bigint AS debit_minor,
             COALESCE(SUM(-e.amount_minor) FILTER (WHERE e.amount_minor < 0), 0)::bigint AS credit_minor,
             COUNT(*)::int                                          AS entry_count,
             MIN(e.created_at)                                      AS oldest_at
      FROM ledger_accounts a
      JOIN ledger_entries  e ON e.ledger_account_id = a.id
      WHERE a.kind = 'RAIL_CLEARING'::ledger_account_kind
      GROUP BY a.id, a.code, a.currency_code, a.payment_method_id, bucket
      ORDER BY a.code, bucket
    `;

    const byAccount = new Map<string, RailAgeingRow>();
    for (const raw of rows) {
      const existing = byAccount.get(raw.account_code) ?? {
        accountId: raw.account_id,
        accountCode: raw.account_code,
        currencyCode: raw.currency_code,
        paymentMethodId: raw.payment_method_id,
        balanceMinor: '0',
        oldestUnsettledAt: null,
        buckets: [],
      };

      const net = raw.debit_minor - raw.credit_minor;
      existing.buckets.push({
        ...this.labelFor(raw.bucket, boundaries),
        debitMinor: raw.debit_minor.toString(),
        creditMinor: raw.credit_minor.toString(),
        netMinor: net.toString(),
        entryCount: raw.entry_count,
      });
      existing.balanceMinor = (BigInt(existing.balanceMinor) + net).toString();

      if (raw.oldest_at !== null) {
        const iso = raw.oldest_at.toISOString();
        if (existing.oldestUnsettledAt === null || iso < existing.oldestUnsettledAt) {
          existing.oldestUnsettledAt = iso;
        }
      }

      byAccount.set(raw.account_code, existing);
    }

    const result = [...byAccount.values()];
    // "Stale" = the account still holds money AND its oldest bucket is the open-ended one. An
    // account whose old entries have all been settled nets to zero there and is not flagged.
    const staleAccountCodes = result
      .filter((row) => {
        if (BigInt(row.balanceMinor) <= 0n) return false;
        const oldest = row.buckets.find((bucket) => bucket.toDays === null);
        return oldest !== undefined && BigInt(oldest.netMinor) > 0n;
      })
      .map((row) => row.accountCode);

    if (staleAccountCodes.length > 0) {
      this.logger.warn(`rail clearing has aged balances on: ${staleAccountCodes.join(', ')}`);
    }

    return { generatedAt: now.toISOString(), rows: result, staleAccountCodes };
  }

  /** Human summary for the admin chat / an ops channel. */
  formatReport(report: RailAgeingReport): string {
    if (report.rows.length === 0) return 'No rail clearing balances.';
    return report.rows
      .map((row) => {
        const oldest = row.buckets.find((bucket) => bucket.toDays === null);
        return (
          `${row.accountCode}: ${formatMinorToDecimal(BigInt(row.balanceMinor))} ${row.currencyCode}` +
          (oldest === undefined || BigInt(oldest.netMinor) <= 0n
            ? ''
            : ` (⚠ ${formatMinorToDecimal(BigInt(oldest.netMinor))} older than ${oldest.fromDays}d)`)
        );
      })
      .join('\n');
  }

  private labelFor(
    bucket: number,
    boundaries: readonly number[],
  ): Pick<RailAgeingBucket, 'label' | 'fromDays' | 'toDays'> {
    const from = bucket === 0 ? 0 : (boundaries[bucket - 1] ?? 0);
    const to = boundaries[bucket] ?? null;
    return {
      label: to === null ? `${from}d+` : `${from}-${to}d`,
      fromDays: from,
      toDays: to,
    };
  }
}
