/**
 * WHY a separate checker when the database already enforces the zero-sum: the trigger guarantees
 * every transaction was balanced AT THE MOMENT IT COMMITTED. It says nothing about what a DBA did
 * with triggers disabled, about a restored backup, or about the advisory cache in
 * ledger_accounts.cached_balance_minor drifting from the entries that are the real truth. These three
 * invariants are what a nightly cron reports on, and a violation is a ReconciliationBreak, not a log
 * line — which is why every violation carries expected/actual/delta ready for that row.
 *
 *   I1  every transaction sums to zero, and has at least two sides
 *   I2  the ledger as a whole sums to zero, per currency
 *   I3  every account's cached balance equals the sum of its entries
 *
 * Every SUM is cast back to ::bigint: SUM(bigint) is `numeric` in PostgreSQL, which Prisma hands
 * back as a Decimal — the one type this codebase refuses to let near money.
 */
import { Injectable, Logger } from '@nestjs/common';

import type { Tx } from '@core/prisma/tx.type';

export type LedgerInvariant =
  | 'I1_TRANSACTION_ZERO_SUM'
  | 'I1_SINGLE_SIDED'
  | 'I2_GLOBAL_ZERO_SUM'
  | 'I3_ACCOUNT_BALANCE_MATCHES_ENTRIES';

export interface LedgerInvariantViolation {
  readonly invariant: LedgerInvariant;
  /** Transaction id, account id, or currency code — whatever the invariant is scoped to. */
  readonly subject: string;
  readonly currencyCode: string;
  readonly expectedMinor: bigint;
  readonly actualMinor: bigint;
  /** actual - expected. Maps straight onto ReconciliationBreak.deltaMinor. */
  readonly deltaMinor: bigint;
  readonly detail: string;
}

export interface LedgerInvariantReport {
  readonly ok: boolean;
  readonly checkedAt: Date;
  readonly violations: readonly LedgerInvariantViolation[];
  /** True when a check hit its row cap, i.e. there may be more violations than are listed. */
  readonly truncated: boolean;
}

/** Row caps keep a broken ledger from producing an unbounded report (and an unbounded alert). */
const DEFAULT_LIMIT = 100;

@Injectable()
export class InvariantsService {
  private readonly logger = new Logger(InvariantsService.name);

  /** I1 — no transaction may be unbalanced, and none may be single-sided. */
  async checkTransactionsBalance(
    tx: Tx,
    limit: number = DEFAULT_LIMIT,
  ): Promise<LedgerInvariantViolation[]> {
    const unbalanced = await tx.$queryRaw<
      { transaction_id: string; currency_code: string; sum_minor: bigint; entry_count: number }[]
    >`
      SELECT e.ledger_transaction_id::text AS transaction_id,
             e.currency_code,
             SUM(e.amount_minor)::bigint  AS sum_minor,
             COUNT(*)::int                AS entry_count
      FROM ledger_entries e
      GROUP BY e.ledger_transaction_id, e.currency_code
      HAVING SUM(e.amount_minor) <> 0
      ORDER BY e.ledger_transaction_id
      LIMIT ${limit}
    `;

    const singleSided = await tx.$queryRaw<
      { transaction_id: string; currency_code: string; entry_count: number }[]
    >`
      SELECT t.id::text AS transaction_id,
             t.currency_code,
             COUNT(e.id)::int AS entry_count
      FROM ledger_transactions t
      LEFT JOIN ledger_entries e ON e.ledger_transaction_id = t.id
      GROUP BY t.id, t.currency_code
      HAVING COUNT(e.id) < 2
      ORDER BY t.id
      LIMIT ${limit}
    `;

    return [
      ...unbalanced.map((row) => ({
        invariant: 'I1_TRANSACTION_ZERO_SUM' as const,
        subject: row.transaction_id,
        currencyCode: row.currency_code,
        expectedMinor: 0n,
        actualMinor: row.sum_minor,
        deltaMinor: row.sum_minor,
        detail: `Transaction ${row.transaction_id} has ${row.entry_count} entries summing to ${row.sum_minor.toString()}`,
      })),
      ...singleSided.map((row) => ({
        invariant: 'I1_SINGLE_SIDED' as const,
        subject: row.transaction_id,
        currencyCode: row.currency_code,
        expectedMinor: 2n,
        actualMinor: BigInt(row.entry_count),
        deltaMinor: BigInt(row.entry_count) - 2n,
        detail: `Transaction ${row.transaction_id} has only ${row.entry_count} entr(y|ies)`,
      })),
    ];
  }

  /**
   * I2 — the whole ledger nets to zero per currency. This is the strongest single number we have:
   * if it holds, no money was created or destroyed anywhere, by anyone.
   */
  async checkGlobalBalance(tx: Tx): Promise<LedgerInvariantViolation[]> {
    const rows = await tx.$queryRaw<
      { currency_code: string; sum_minor: bigint; entry_count: number }[]
    >`
      SELECT currency_code,
             SUM(amount_minor)::bigint AS sum_minor,
             COUNT(*)::int             AS entry_count
      FROM ledger_entries
      GROUP BY currency_code
      HAVING SUM(amount_minor) <> 0
      ORDER BY currency_code
    `;

    return rows.map((row) => ({
      invariant: 'I2_GLOBAL_ZERO_SUM' as const,
      subject: row.currency_code,
      currencyCode: row.currency_code,
      expectedMinor: 0n,
      actualMinor: row.sum_minor,
      deltaMinor: row.sum_minor,
      detail: `All ${row.entry_count} ${row.currency_code} entries sum to ${row.sum_minor.toString()} instead of 0`,
    }));
  }

  /**
   * I3 — the advisory cache still matches the entries. A drift here does not mean money is missing;
   * it means the number the approval path reads (can the float cover this?) is lying, which is how
   * an overdraft gets approved.
   */
  async checkAccountBalances(
    tx: Tx,
    limit: number = DEFAULT_LIMIT,
  ): Promise<LedgerInvariantViolation[]> {
    const rows = await tx.$queryRaw<
      {
        account_id: string;
        code: string;
        currency_code: string;
        cached_minor: bigint;
        entries_minor: bigint;
      }[]
    >`
      SELECT a.id::text                          AS account_id,
             a.code,
             a.currency_code,
             a.cached_balance_minor              AS cached_minor,
             COALESCE(SUM(e.amount_minor), 0)::bigint AS entries_minor
      FROM ledger_accounts a
      LEFT JOIN ledger_entries e ON e.ledger_account_id = a.id
      GROUP BY a.id, a.code, a.currency_code, a.cached_balance_minor
      HAVING a.cached_balance_minor <> COALESCE(SUM(e.amount_minor), 0)
      ORDER BY a.code
      LIMIT ${limit}
    `;

    return rows.map((row) => ({
      invariant: 'I3_ACCOUNT_BALANCE_MATCHES_ENTRIES' as const,
      subject: row.account_id,
      currencyCode: row.currency_code,
      expectedMinor: row.entries_minor,
      actualMinor: row.cached_minor,
      deltaMinor: row.cached_minor - row.entries_minor,
      detail: `Account ${row.code} caches ${row.cached_minor.toString()} but its entries sum to ${row.entries_minor.toString()}`,
    }));
  }

  /** Run everything. The report is what the reconciliation cron turns into ReconciliationBreak rows. */
  async checkAll(tx: Tx, limit: number = DEFAULT_LIMIT): Promise<LedgerInvariantReport> {
    const [transactions, global, accounts] = [
      await this.checkTransactionsBalance(tx, limit),
      await this.checkGlobalBalance(tx),
      await this.checkAccountBalances(tx, limit),
    ];
    const violations = [...transactions, ...global, ...accounts];
    const truncated = transactions.length >= limit || accounts.length >= limit;

    if (violations.length > 0) {
      this.logger.error(
        `ledger invariants FAILED: ${violations.length} violation(s)${truncated ? ' (truncated)' : ''}`,
      );
    }

    return { ok: violations.length === 0, checkedAt: new Date(), violations, truncated };
  }

  /**
   * Recompute one account's cache from its entries. The repairing half of I3 — kept here so the fix
   * lives next to the detection and cannot drift from it.
   */
  async recomputeAccountCache(tx: Tx, accountId: string): Promise<bigint> {
    const rows = await tx.$queryRaw<{ entries_minor: bigint }[]>`
      SELECT COALESCE(SUM(amount_minor), 0)::bigint AS entries_minor
      FROM ledger_entries
      WHERE ledger_account_id = ${accountId}::uuid
    `;
    const balance = rows[0]?.entries_minor ?? 0n;
    await tx.ledgerAccount.update({
      where: { id: accountId },
      data: { cachedBalanceMinor: balance, cachedAt: new Date() },
    });
    return balance;
  }
}
