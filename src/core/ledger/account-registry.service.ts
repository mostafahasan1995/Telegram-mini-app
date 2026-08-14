/**
 * WHY resolve-or-create instead of seeding every account up front: accounts are per-player and
 * per-payment-method, so the set is unbounded and only known at the moment money first moves. The
 * code is deterministic (see ./account-codes.ts), so "create if absent" is safe to run concurrently.
 *
 * WHY raw INSERT ... ON CONFLICT and not prisma.upsert(): under concurrency Prisma's upsert can
 * still surface a unique violation, and in PostgreSQL ANY error inside a transaction poisons it —
 * every later statement fails with "current transaction is aborted". Catching P2002 and carrying on
 * simply does not work here. ON CONFLICT resolves the race inside the database, in one statement,
 * without ever raising. The `DO UPDATE SET code = EXCLUDED.code` is a deliberate no-op write: it is
 * the only way to get RETURNING to hand back the pre-existing row.
 */
import { Injectable } from '@nestjs/common';

import type { Tx } from '@core/prisma/tx.type';

import { parseAccountCode } from './account-codes';
import { LedgerError } from './ledger.errors';
import type { LedgerAccountRef } from './ledger.types';
import { LedgerAccountKind } from '@prisma/client';

/** Shape returned by the raw statements below; snake_case because it comes straight from Postgres. */
interface RawAccountRow {
  id: string;
  code: string;
  kind: string;
  currency_code: string;
  is_debit_normal: boolean;
  is_active: boolean;
  cached_balance_minor: bigint;
}

const isAccountKind = (value: string): value is LedgerAccountKind =>
  Object.prototype.hasOwnProperty.call(LedgerAccountKind, value);

function toRef(row: RawAccountRow): LedgerAccountRef {
  if (!isAccountKind(row.kind)) {
    throw new LedgerError(
      'LEDGER_INVALID_ACCOUNT_CODE',
      `Account ${row.code} has unknown kind "${row.kind}"`,
      { code: row.code, kind: row.kind },
    );
  }
  return {
    id: row.id,
    code: row.code,
    kind: row.kind,
    currencyCode: row.currency_code,
    isDebitNormal: row.is_debit_normal,
    isActive: row.is_active,
    cachedBalanceMinor: row.cached_balance_minor,
  };
}

@Injectable()
export class AccountRegistryService {
  /**
   * Idempotently materialise the account named by `code`. The code alone determines kind, scope,
   * currency and normal side, so two concurrent callers cannot disagree about what they created.
   */
  async resolveOrCreate(tx: Tx, code: string): Promise<LedgerAccountRef> {
    const parsed = parseAccountCode(code);

    // updated_at has no database default (Prisma normally fills @updatedAt client-side), so a raw
    // insert must set it explicitly or the NOT NULL constraint fires.
    const rows = await tx.$queryRaw<RawAccountRow[]>`
      INSERT INTO ledger_accounts (
        id, code, kind, name, currency_code, player_id, payment_method_id,
        is_debit_normal, is_active, cached_balance_minor, created_at, updated_at
      )
      VALUES (
        gen_random_uuid(),
        ${parsed.code},
        ${parsed.kind}::ledger_account_kind,
        ${parsed.name},
        ${parsed.currencyCode},
        ${parsed.playerId}::uuid,
        ${parsed.paymentMethodId}::uuid,
        ${parsed.spec.isDebitNormal},
        true,
        0,
        now(),
        now()
      )
      ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code
      RETURNING id, code, kind::text AS kind, currency_code,
                is_debit_normal, is_active, cached_balance_minor
    `;

    const row = rows[0];
    if (row === undefined) {
      throw new LedgerError(
        'LEDGER_ACCOUNT_NOT_FOUND',
        `Failed to resolve or create ledger account ${code}`,
        { code },
      );
    }
    return toRef(row);
  }

  /**
   * Resolve many codes, de-duplicated and **sorted by code**.
   *
   * The sort is a deadlock fix, not tidiness. `ON CONFLICT DO UPDATE` takes a row lock on the
   * conflicting row and holds it until commit, so this loop acquires locks in whatever order the
   * caller happened to list its entries. Two postings naming the same two accounts in opposite order
   * therefore invert their lock order and deadlock — before the repository's carefully sorted
   * `SELECT … FOR UPDATE` ever runs. Verified: without this sort, 8 concurrent postings against one
   * pair of accounts wedge until the transaction timeout; with it, all 8 commit.
   *
   * Sequential on purpose: parallel statements inside one interactive transaction share a single
   * connection and would interleave.
   */
  async resolveManyOrCreate(
    tx: Tx,
    codes: readonly string[],
  ): Promise<Map<string, LedgerAccountRef>> {
    const resolved = new Map<string, LedgerAccountRef>();
    for (const code of [...new Set(codes)].sort()) {
      resolved.set(code, await this.resolveOrCreate(tx, code));
    }
    return resolved;
  }

  /** Look up without creating. Returns null when the account has never been used. */
  async findByCode(tx: Tx, code: string): Promise<LedgerAccountRef | null> {
    const rows = await tx.$queryRaw<RawAccountRow[]>`
      SELECT id, code, kind::text AS kind, currency_code,
             is_debit_normal, is_active, cached_balance_minor
      FROM ledger_accounts
      WHERE code = ${code}
    `;
    const row = rows[0];
    return row === undefined ? null : toRef(row);
  }

  /**
   * Balance straight from the entries rather than the cache — used by the approval path when it
   * needs the truth (can the agent float cover this?) instead of the advisory number.
   */
  async computeBalanceFromEntries(tx: Tx, accountId: string): Promise<bigint> {
    const rows = await tx.$queryRaw<{ balance_minor: bigint }[]>`
      SELECT COALESCE(SUM(amount_minor), 0)::bigint AS balance_minor
      FROM ledger_entries
      WHERE ledger_account_id = ${accountId}::uuid
    `;
    return rows[0]?.balance_minor ?? 0n;
  }
}
