/**
 * WHY a Posting is a value, not a sequence of repository calls: a money movement must be reviewable
 * as ONE object before anything touches the database. Posting rules build it, validation checks it,
 * the repository writes it. Nothing in between can add a side to a transaction the reviewer of the
 * rule never saw.
 *
 * SIGN CONVENTION (the one rule everything else follows)
 *   positive amountMinor = DEBIT   negative amountMinor = CREDIT
 *   assets (cash, rail clearing, agent float) rest POSITIVE
 *   liabilities (what we owe a player) rest NEGATIVE
 *   the entries of one posting always sum to exactly 0n
 * See ./README.md for the four canonical postings drawn out.
 */
import type { LedgerAccountKind, LedgerTxKind, Prisma } from '@prisma/client';

import type { Actor } from '@common/types/actor.type';

/** Free-form JSON we attach to a transaction. Prisma's input type, so no cast at the call site. */
export type LedgerMetadata = Prisma.InputJsonObject;

/**
 * What this posting is *about*. `DEPOSIT` is special-cased: its refId is written to
 * ledger_transactions.deposit_request_id, where two partial unique indexes then enforce "at most one
 * DEPOSIT_CLAIM and one DEPOSIT_CREDIT per deposit, ever". Everything else is recorded in metadata.
 */
export type LedgerRefType =
  'DEPOSIT' | 'AGENT_FLOAT' | 'RAIL_SETTLEMENT' | 'RECONCILIATION' | 'REVERSAL' | 'MANUAL';

interface PostingEntryBase {
  /** Signed minor units. Positive debits the account, negative credits it. Never 0n. */
  readonly amountMinor: bigint;
  readonly memo?: string;
}

/**
 * An entry names its account either by id (already resolved) or by deterministic code (resolved and
 * created on demand). `?: never` on the other branch makes "both at once" a compile error rather
 * than a runtime surprise.
 */
export type PostingEntry =
  | (PostingEntryBase & { readonly accountId: string; readonly accountCode?: never })
  | (PostingEntryBase & { readonly accountCode: string; readonly accountId?: never });

export interface Posting {
  /**
   * Stable natural key of this movement, e.g. `ledger:deposit:<id>:credit`. Replaying it returns the
   * original transaction instead of posting a second one. The Ichancy API has no idempotency key of
   * its own, so this is the only thing standing between a retried worker and a double credit.
   */
  readonly idempotencyKey: string;
  readonly kind: LedgerTxKind;
  readonly refType: LedgerRefType;
  readonly refId: string;
  /** ISO 4217 code. A posting is single-currency by construction; the DB groups per currency too. */
  readonly currency: string;
  readonly entries: readonly PostingEntry[];
  /** Written verbatim to ledger_transactions.description; shown in admin tooling. */
  readonly description: string;
  readonly actor: Actor;
  /** When the money moved in the real world. Defaults to now() at write time. */
  readonly occurredAt?: Date;
  /** Forensic anchor searchable in the Ichancy panel or a bank statement (usually the shortId). */
  readonly externalRef?: string;
  /** Set only by reversal(); ledger_transactions.reverses_tx_id is UNIQUE, so a tx reverses once. */
  readonly reversesTxId?: string;
  readonly metadata?: LedgerMetadata;
  /**
   * Skip the per-kind sign guard. Corrections must always be postable — a reversal blocked by the
   * guard would freeze a bad posting in place forever — so reversal() sets this by default.
   */
  readonly allowNegative?: boolean;
}

/** Balance either side of one entry, in entry order (two entries on one account chain correctly). */
export interface EntryBalanceSnapshot {
  readonly sequence: number;
  readonly accountId: string;
  readonly accountCode: string;
  readonly previousBalanceMinor: bigint;
  readonly currentBalanceMinor: bigint;
}

export interface PostedEntry {
  readonly sequence: number;
  readonly accountId: string;
  readonly accountCode: string;
  readonly amountMinor: bigint;
  readonly memo: string | null;
  /** Null only when replaying an older transaction whose snapshots could not be recovered. */
  readonly previousBalanceMinor: bigint | null;
  readonly currentBalanceMinor: bigint | null;
}

export interface PostedTransaction {
  readonly transactionId: string;
  readonly kind: LedgerTxKind;
  readonly currency: string;
  readonly occurredAt: Date;
  readonly postedAt: Date;
  readonly entries: readonly PostedEntry[];
  /** True when the idempotency key matched an existing transaction and nothing new was written. */
  readonly deduplicated: boolean;
}

/** The resolved shape of a ledger account, as returned by the registry and the locking read. */
export interface LedgerAccountRef {
  readonly id: string;
  readonly code: string;
  readonly kind: LedgerAccountKind;
  readonly currencyCode: string;
  readonly isDebitNormal: boolean;
  readonly isActive: boolean;
  readonly cachedBalanceMinor: bigint;
}

/**
 * Anything with `$transaction`. Typing it structurally means core/ledger never has to import a
 * PrismaService owned by another module, and a test can pass a fake without a database.
 */
export interface LedgerTxRunner {
  $transaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: {
      maxWait?: number;
      timeout?: number;
      isolationLevel?: Prisma.TransactionIsolationLevel;
    },
  ): Promise<T>;
}

/** Scope used in the shared idempotency_keys table so ledger keys cannot collide with API keys. */
export const LEDGER_IDEMPOTENCY_SCOPE = 'ledger.post';

/** Ledger idempotency rows outlive any retry window; they are the proof a posting already ran. */
export const LEDGER_IDEMPOTENCY_TTL_DAYS = 90;

/** Reserved metadata key holding EntryBalanceSnapshot[] — see the deviation note in README.md. */
export const BALANCE_SNAPSHOT_METADATA_KEY = 'balanceSnapshots';
