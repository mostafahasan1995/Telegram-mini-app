/**
 * WHY this file is the narrowest waist in the system: it is the only place that turns an intention
 * ("credit this player") into rows. Everything it does is about making concurrency boring.
 *
 * Three locks, in this order, every time:
 *  1. a transaction-scoped ADVISORY lock on the idempotency key, so two workers replaying the same
 *     posting queue behind each other instead of racing. This is what lets us do a plain
 *     find-then-insert on idempotency_keys: in PostgreSQL a unique violation aborts the whole
 *     transaction, so "catch P2002 and continue" is not an option — the race must be prevented,
 *     not handled.
 *  2. SELECT ... FOR UPDATE on every touched account, taken in SORTED id order. Sorting is the whole
 *     trick: two postings that touch {A,B} and {B,A} would otherwise deadlock, and a deadlock on the
 *     credit path is a stuck deposit.
 *  3. the DEFERRABLE constraint trigger in prisma/sql/001, which re-checks the zero-sum at COMMIT
 *     even if this code is wrong.
 *
 * SCHEMA DEVIATION (deliberate, see README.md): the brief asked for entries carrying
 * previousBalanceMinor/currentBalanceMinor/accountVersion and an UPDATE of balance_minor + version.
 * ledger_entries has no such columns and ledger_accounts has no version column — and both ledger
 * tables are append-only (prisma/sql/002) with the app role holding SELECT+INSERT only
 * (prisma/sql/003), so they could not be added from here. The balance snapshots are therefore
 * written into ledger_transactions.metadata, which is equally immutable, and the running balance
 * lives in ledger_accounts.cached_balance_minor. The optimistic `version` column is unnecessary
 * here: the FOR UPDATE row locks are pessimistic and strictly stronger.
 */
import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { Tx } from '@core/prisma/tx.type';

import { parseAccountCode, satisfiesSignPolicy, ACCOUNT_KIND_SPECS } from './account-codes';
import { AccountRegistryService } from './account-registry.service';
import { LedgerError } from './ledger.errors';
import {
  BALANCE_SNAPSHOT_METADATA_KEY,
  LEDGER_IDEMPOTENCY_SCOPE,
  LEDGER_IDEMPOTENCY_TTL_DAYS,
  type EntryBalanceSnapshot,
  type PostedEntry,
  type PostedTransaction,
  type Posting,
} from './ledger.types';
import { assertValidPosting } from './posting-validation';

/** Locked account row. snake_case: it comes straight out of Postgres, untouched by Prisma mapping. */
interface LockedAccountRow {
  id: string;
  code: string;
  kind: string;
  currency_code: string;
  is_debit_normal: boolean;
  is_active: boolean;
  cached_balance_minor: bigint;
}

const MS_PER_DAY = 86_400_000;

/**
 * FNV-1a 64-bit, folded into a signed bigint for pg_advisory_xact_lock(bigint).
 * Computed in JS rather than with Postgres' `hashtext` because hashtext is undocumented and its
 * value has changed between major versions — a lock key that silently changes on upgrade would
 * quietly stop serialising anything.
 */
function advisoryLockKey(input: string): bigint {
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK64 = 0xffffffffffffffffn;
  let hash = FNV_OFFSET;
  for (const byte of Buffer.from(input, 'utf8')) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK64;
  }
  return BigInt.asIntN(64, hash);
}

/**
 * Hash of everything that defines the movement. A replay carrying the same key but a different body
 * is a caller bug and must be refused, never answered from cache — that is how a double credit
 * disguises itself as a successful retry.
 */
function hashPosting(posting: Posting): string {
  const canonical = JSON.stringify({
    kind: posting.kind,
    refType: posting.refType,
    refId: posting.refId,
    currency: posting.currency,
    reversesTxId: posting.reversesTxId ?? null,
    entries: posting.entries.map((entry) => ({
      account: entry.accountId ?? entry.accountCode ?? '',
      amount: entry.amountMinor.toString(),
    })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Defensive reader for the snapshots we stored in metadata; malformed JSON yields no snapshots. */
function readBalanceSnapshots(
  metadata: Prisma.JsonValue | null,
): Map<number, EntryBalanceSnapshot> {
  const out = new Map<number, EntryBalanceSnapshot>();
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return out;
  const raw = (metadata as Record<string, Prisma.JsonValue>)[BALANCE_SNAPSHOT_METADATA_KEY];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, Prisma.JsonValue>;
    const sequence = record['sequence'];
    const previous = record['previousBalanceMinor'];
    const current = record['currentBalanceMinor'];
    const accountId = record['accountId'];
    const accountCode = record['accountCode'];
    if (
      typeof sequence !== 'number' ||
      typeof previous !== 'string' ||
      typeof current !== 'string' ||
      typeof accountId !== 'string' ||
      typeof accountCode !== 'string'
    ) {
      continue;
    }
    out.set(sequence, {
      sequence,
      accountId,
      accountCode,
      previousBalanceMinor: BigInt(previous),
      currentBalanceMinor: BigInt(current),
    });
  }
  return out;
}

@Injectable()
export class LedgerRepository {
  private readonly logger = new Logger(LedgerRepository.name);

  constructor(private readonly accounts: AccountRegistryService) {}

  /**
   * Write one balanced posting. Callers must already own `tx` — an HTTP call must never sit inside
   * the same transaction (see @core/prisma/tx.type), so the credit worker posts T2 only AFTER
   * Ichancy has answered.
   */
  async post(tx: Tx, posting: Posting): Promise<PostedTransaction> {
    assertValidPosting(posting);

    await this.acquireIdempotencyLock(tx, posting.idempotencyKey);

    const requestHash = hashPosting(posting);
    const replay = await this.findReplay(tx, posting, requestHash);
    if (replay !== null) return replay;

    const refToAccountId = await this.resolveAccounts(tx, posting);
    const orderedIds = [...new Set(refToAccountId.values())].sort();
    const locked = await this.lockAccounts(tx, orderedIds);

    const { snapshots, finalBalances } = this.computeBalances(posting, refToAccountId, locked);

    const occurredAt = posting.occurredAt ?? new Date();
    const metadata: Prisma.InputJsonObject = {
      ...(posting.metadata ?? {}),
      ref: { type: posting.refType, id: posting.refId },
      [BALANCE_SNAPSHOT_METADATA_KEY]: snapshots.map((snapshot) => ({
        sequence: snapshot.sequence,
        accountId: snapshot.accountId,
        accountCode: snapshot.accountCode,
        previousBalanceMinor: snapshot.previousBalanceMinor.toString(),
        currentBalanceMinor: snapshot.currentBalanceMinor.toString(),
      })),
    };

    const created = await tx.ledgerTransaction.create({
      data: {
        kind: posting.kind,
        currencyCode: posting.currency,
        occurredAt,
        description: posting.description,
        actorType: posting.actor.type,
        actorId: posting.actor.id,
        depositRequestId: posting.refType === 'DEPOSIT' ? posting.refId : null,
        externalRef: posting.externalRef ?? null,
        reversesTxId: posting.reversesTxId ?? null,
        metadata,
      },
      select: { id: true, postedAt: true },
    });

    await tx.ledgerEntry.createMany({
      data: posting.entries.map((entry, index) => {
        // computeBalances already resolved and locked every account, in entry order.
        const snapshot = snapshots[index];
        if (snapshot === undefined) {
          throw new LedgerError('LEDGER_ACCOUNT_NOT_FOUND', `Entry ${index} lost its account`);
        }
        return {
          ledgerTransactionId: created.id,
          ledgerAccountId: snapshot.accountId,
          currencyCode: posting.currency,
          amountMinor: entry.amountMinor,
          sequence: index,
          memo: entry.memo ?? null,
        };
      }),
    });

    // The cache is advisory (the entries are the truth) but every approval-path float check reads
    // it, so it is updated inside the same transaction and under the same row lock.
    const cachedAt = new Date();
    for (const [accountId, balance] of finalBalances) {
      await tx.ledgerAccount.update({
        where: { id: accountId },
        data: { cachedBalanceMinor: balance, cachedAt },
      });
    }

    await tx.idempotencyKey.create({
      data: {
        scope: LEDGER_IDEMPOTENCY_SCOPE,
        key: posting.idempotencyKey,
        requestHash,
        state: 'COMPLETED',
        resultRef: created.id,
        completedAt: cachedAt,
        expiresAt: new Date(cachedAt.getTime() + LEDGER_IDEMPOTENCY_TTL_DAYS * MS_PER_DAY),
      },
    });

    this.logger.log(
      `posted ${posting.kind} ${created.id} (${posting.idempotencyKey}) ` +
        `${posting.entries.length} entries ${posting.currency}`,
    );

    return {
      transactionId: created.id,
      kind: posting.kind,
      currency: posting.currency,
      occurredAt,
      postedAt: created.postedAt,
      deduplicated: false,
      entries: posting.entries.map((entry, index) => {
        const snapshot = snapshots[index];
        return {
          sequence: index,
          accountId: snapshot?.accountId ?? '',
          accountCode: snapshot?.accountCode ?? '',
          amountMinor: entry.amountMinor,
          memo: entry.memo ?? null,
          previousBalanceMinor: snapshot?.previousBalanceMinor ?? null,
          currentBalanceMinor: snapshot?.currentBalanceMinor ?? null,
        };
      }),
    };
  }

  /**
   * Serialise everyone replaying the same key. Released automatically at COMMIT or ROLLBACK, so a
   * crashed worker cannot leave the key locked.
   */
  private async acquireIdempotencyLock(tx: Tx, idempotencyKey: string): Promise<void> {
    const key = advisoryLockKey(`${LEDGER_IDEMPOTENCY_SCOPE}:${idempotencyKey}`);
    // The lock function is called in FROM position and a real boolean is selected instead of its
    // return value: pg_advisory_xact_lock() returns `void`, and the Prisma driver adapter cannot
    // deserialize a void column ("UnsupportedNativeDataType").
    await tx.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(${key}::bigint)`;
  }

  /** Return the original transaction when this exact posting already ran; null when it is new. */
  private async findReplay(
    tx: Tx,
    posting: Posting,
    requestHash: string,
  ): Promise<PostedTransaction | null> {
    const existing = await tx.idempotencyKey.findUnique({
      where: { scope_key: { scope: LEDGER_IDEMPOTENCY_SCOPE, key: posting.idempotencyKey } },
      select: { requestHash: true, resultRef: true },
    });
    if (existing === null) return null;

    if (existing.requestHash !== requestHash) {
      throw new LedgerError(
        'LEDGER_IDEMPOTENCY_KEY_REUSED',
        `Idempotency key ${posting.idempotencyKey} was already used for a different posting`,
        { idempotencyKey: posting.idempotencyKey },
      );
    }
    if (existing.resultRef === null) {
      throw new LedgerError(
        'LEDGER_IDEMPOTENCY_IN_FLIGHT',
        `Idempotency key ${posting.idempotencyKey} exists but references no transaction`,
        { idempotencyKey: posting.idempotencyKey },
      );
    }

    const original = await tx.ledgerTransaction.findUnique({
      where: { id: existing.resultRef },
      select: {
        id: true,
        kind: true,
        currencyCode: true,
        occurredAt: true,
        postedAt: true,
        metadata: true,
        entries: {
          orderBy: { sequence: 'asc' },
          select: {
            sequence: true,
            amountMinor: true,
            memo: true,
            ledgerAccountId: true,
            account: { select: { code: true } },
          },
        },
      },
    });
    if (original === null) {
      throw new LedgerError(
        'LEDGER_REPLAY_TARGET_MISSING',
        `Idempotency key ${posting.idempotencyKey} points at missing transaction ${existing.resultRef}`,
        { idempotencyKey: posting.idempotencyKey, transactionId: existing.resultRef },
      );
    }

    const snapshots = readBalanceSnapshots(original.metadata);
    const entries: PostedEntry[] = original.entries.map((entry) => {
      const snapshot = snapshots.get(entry.sequence);
      return {
        sequence: entry.sequence,
        accountId: entry.ledgerAccountId,
        accountCode: entry.account.code,
        amountMinor: entry.amountMinor,
        memo: entry.memo,
        previousBalanceMinor: snapshot?.previousBalanceMinor ?? null,
        currentBalanceMinor: snapshot?.currentBalanceMinor ?? null,
      };
    });

    this.logger.log(
      `replayed ${posting.idempotencyKey} -> existing transaction ${original.id} (no rows written)`,
    );

    return {
      transactionId: original.id,
      kind: original.kind,
      currency: original.currencyCode,
      occurredAt: original.occurredAt,
      postedAt: original.postedAt,
      entries,
      deduplicated: true,
    };
  }

  /**
   * Map every entry's account ref (id or code) to an account id, creating coded accounts on demand.
   * Only the id is needed downstream — the authoritative code, currency and kind all come from the
   * locked row, so there is never a second, staler copy of an account's identity in flight.
   */
  private async resolveAccounts(tx: Tx, posting: Posting): Promise<Map<string, string>> {
    const refToAccountId = new Map<string, string>();

    const codes = posting.entries
      .map((entry) => entry.accountCode)
      .filter((code): code is string => typeof code === 'string');
    for (const [code, account] of await this.accounts.resolveManyOrCreate(tx, codes)) {
      refToAccountId.set(code, account.id);
    }

    // An entry that already knows its account id needs no lookup: lockAccounts() is what proves the
    // id exists, and it has to run anyway.
    for (const entry of posting.entries) {
      if (typeof entry.accountId === 'string') refToAccountId.set(entry.accountId, entry.accountId);
    }

    return refToAccountId;
  }

  /**
   * Lock every touched account. `ORDER BY id` on a pre-sorted id list is the deadlock-avoidance
   * contract: all writers acquire the same accounts in the same total order.
   */
  private async lockAccounts(
    tx: Tx,
    orderedIds: readonly string[],
  ): Promise<Map<string, LockedAccountRow>> {
    const rows = await tx.$queryRaw<LockedAccountRow[]>`
      SELECT id, code, kind::text AS kind, currency_code,
             is_debit_normal, is_active, cached_balance_minor
      FROM ledger_accounts
      WHERE id = ANY(${orderedIds}::uuid[])
      ORDER BY id
      FOR UPDATE
    `;
    const locked = new Map(rows.map((row) => [row.id, row]));
    for (const id of orderedIds) {
      if (!locked.has(id)) {
        throw new LedgerError('LEDGER_ACCOUNT_NOT_FOUND', `Ledger account ${id} does not exist`, {
          accountId: id,
        });
      }
    }
    return locked;
  }

  /**
   * Walk the entries in order, chaining the running balance per account, and refuse anything that
   * ends on the wrong side of zero. Running (not per-account-netted) balances mean two entries on
   * one account produce two honest snapshots.
   */
  private computeBalances(
    posting: Posting,
    refToAccountId: Map<string, string>,
    locked: Map<string, LockedAccountRow>,
  ): { snapshots: EntryBalanceSnapshot[]; finalBalances: Map<string, bigint> } {
    const running = new Map<string, bigint>();
    const snapshots: EntryBalanceSnapshot[] = [];

    posting.entries.forEach((entry, index) => {
      const ref = entry.accountId ?? entry.accountCode ?? '';
      const accountId = refToAccountId.get(ref);
      if (accountId === undefined) {
        throw new LedgerError('LEDGER_ACCOUNT_NOT_FOUND', `Entry ${index} names unknown account`, {
          ref,
        });
      }
      const row = locked.get(accountId);
      if (row === undefined) {
        throw new LedgerError('LEDGER_ACCOUNT_NOT_FOUND', `Account ${accountId} was not locked`, {
          accountId,
        });
      }
      if (!row.is_active) {
        throw new LedgerError('LEDGER_ACCOUNT_INACTIVE', `Account ${row.code} is deactivated`, {
          accountId,
          code: row.code,
        });
      }
      if (row.currency_code !== posting.currency) {
        throw new LedgerError(
          'LEDGER_CURRENCY_MISMATCH',
          `Account ${row.code} holds ${row.currency_code}, posting is ${posting.currency}`,
          { accountId, accountCurrency: row.currency_code, posting: posting.currency },
        );
      }

      const previous = running.get(accountId) ?? row.cached_balance_minor;
      const current = previous + entry.amountMinor;
      running.set(accountId, current);
      snapshots.push({
        sequence: index,
        accountId,
        accountCode: row.code,
        previousBalanceMinor: previous,
        currentBalanceMinor: current,
      });
    });

    if (posting.allowNegative !== true) {
      for (const [accountId, balance] of running) {
        const row = locked.get(accountId);
        if (row === undefined) continue;
        const spec = ACCOUNT_KIND_SPECS[parseAccountCode(row.code).kind];
        if (!satisfiesSignPolicy(balance, spec.signPolicy)) {
          throw new LedgerError(
            'LEDGER_SIGN_VIOLATION',
            `Posting would leave ${row.code} at ${balance.toString()}, violating ${spec.signPolicy}`,
            {
              accountId,
              code: row.code,
              balanceMinor: balance.toString(),
              signPolicy: spec.signPolicy,
            },
          );
        }
      }
    }

    return { snapshots, finalBalances: running };
  }
}
