/**
 * WHY pure builders instead of a lookup table: an account must be addressable from a posting rule
 * that has never touched the database. `playerLiabilityCode(playerId, 'NSP')` is a total function —
 * given the same player you always get the same account, so a posting rule stays unit-testable and
 * two concurrent workers cannot invent two accounts for one player.
 *
 * Code grammar (`:` separated, currency always last):
 *   scoped     <KIND>:<scopeId>:<CURRENCY>     e.g. PLAYER_LIABILITY:9f3…:NSP
 *   singleton  <KIND>:<CURRENCY>               e.g. ICHANCY_AGENT_FLOAT:NSP
 *
 * The scope id is a UUID that also lands in ledger_accounts.player_id / .payment_method_id, so the
 * code is a human-readable mirror of columns the database already constrains with foreign keys.
 */
import { LedgerAccountKind } from '@prisma/client';

import { LedgerError } from './ledger.errors';

/** Which real-world column the middle segment of a scoped code maps onto. */
export type AccountScope = 'PLAYER' | 'PAYMENT_METHOD' | 'NONE';

/**
 * Which side of zero an account is allowed to rest on once a posting commits.
 *  - NON_NEGATIVE: debit-normal (assets). You cannot hold minus-500 of real cash.
 *  - NON_POSITIVE: credit-normal (liabilities). Owing a player is stored as a negative balance;
 *    a positive one would mean the player owes US, which this product cannot express.
 *  - ANY: the rounding sink, which exists precisely to absorb both directions.
 */
export type SignPolicy = 'NON_NEGATIVE' | 'NON_POSITIVE' | 'ANY';

export interface AccountKindSpec {
  readonly kind: LedgerAccountKind;
  readonly scope: AccountScope;
  readonly isDebitNormal: boolean;
  readonly signPolicy: SignPolicy;
  /** Human label written to ledger_accounts.name; the scope id is appended when there is one. */
  readonly label: string;
}

/**
 * The single source of truth for account semantics. `isDebitNormal` drives reporting, `signPolicy`
 * drives the runtime guard in the repository — they are stated separately because HOUSE_ROUNDING is
 * debit-normal for reporting yet deliberately unguarded.
 */
export const ACCOUNT_KIND_SPECS: Readonly<Record<LedgerAccountKind, AccountKindSpec>> =
  Object.freeze({
    [LedgerAccountKind.RAIL_CLEARING]: {
      kind: LedgerAccountKind.RAIL_CLEARING,
      scope: 'PAYMENT_METHOD',
      isDebitNormal: true,
      signPolicy: 'NON_NEGATIVE',
      label: 'Rail clearing',
    },
    [LedgerAccountKind.HOUSE_CASH]: {
      kind: LedgerAccountKind.HOUSE_CASH,
      scope: 'PAYMENT_METHOD',
      isDebitNormal: true,
      signPolicy: 'NON_NEGATIVE',
      label: 'House cash',
    },
    [LedgerAccountKind.PLAYER_LIABILITY]: {
      kind: LedgerAccountKind.PLAYER_LIABILITY,
      scope: 'PLAYER',
      isDebitNormal: false,
      signPolicy: 'NON_POSITIVE',
      label: 'Player liability',
    },
    [LedgerAccountKind.ICHANCY_AGENT_FLOAT]: {
      kind: LedgerAccountKind.ICHANCY_AGENT_FLOAT,
      scope: 'NONE',
      isDebitNormal: true,
      // The float is finite and cannot be overdrawn: this guard is what turns "Ichancy said no"
      // into "we refused before calling Ichancy at all".
      signPolicy: 'NON_NEGATIVE',
      label: 'Ichancy agent float',
    },
    [LedgerAccountKind.CASINO_MIRROR]: {
      kind: LedgerAccountKind.CASINO_MIRROR,
      scope: 'PLAYER',
      isDebitNormal: true,
      signPolicy: 'NON_NEGATIVE',
      label: 'Casino mirror',
    },
    [LedgerAccountKind.SUSPENSE_UNIDENTIFIED]: {
      kind: LedgerAccountKind.SUSPENSE_UNIDENTIFIED,
      scope: 'PAYMENT_METHOD',
      isDebitNormal: false,
      signPolicy: 'NON_POSITIVE',
      label: 'Unidentified receipts',
    },
    [LedgerAccountKind.HOUSE_ROUNDING]: {
      kind: LedgerAccountKind.HOUSE_ROUNDING,
      scope: 'NONE',
      isDebitNormal: true,
      // Deliberately unguarded: a sink that could refuse a posting would defeat its own purpose.
      signPolicy: 'ANY',
      label: 'House rounding',
    },
  });

export interface ParsedAccountCode {
  readonly code: string;
  readonly kind: LedgerAccountKind;
  readonly spec: AccountKindSpec;
  readonly currencyCode: string;
  /** Set when spec.scope === 'PLAYER'. */
  readonly playerId: string | null;
  /** Set when spec.scope === 'PAYMENT_METHOD'. */
  readonly paymentMethodId: string | null;
  readonly name: string;
}

const CODE_SEPARATOR = ':';
/** Currency codes are ISO-4217-shaped; the column is varchar(3). */
const CURRENCY_RE = /^[A-Z]{3}$/;
/** Scope ids are database UUIDs. Rejecting anything else keeps a typo from creating a real row. */
const SCOPE_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const isAccountKind = (value: string): value is LedgerAccountKind =>
  Object.prototype.hasOwnProperty.call(ACCOUNT_KIND_SPECS, value);

function assertCurrency(currency: string): string {
  if (!CURRENCY_RE.test(currency)) {
    throw new LedgerError(
      'LEDGER_INVALID_ACCOUNT_CODE',
      `"${currency}" is not a 3-letter currency code`,
      { currency },
    );
  }
  return currency;
}

function assertScopeId(scopeId: string, kind: LedgerAccountKind): string {
  if (!SCOPE_ID_RE.test(scopeId)) {
    throw new LedgerError(
      'LEDGER_INVALID_ACCOUNT_CODE',
      `${kind} account scope must be a UUID, got "${scopeId}"`,
      { kind, scopeId },
    );
  }
  return scopeId;
}

/** Build a scoped code. Not exported directly — the named builders below document intent better. */
function scopedCode(kind: LedgerAccountKind, scopeId: string, currency: string): string {
  return [kind, assertScopeId(scopeId, kind), assertCurrency(currency)].join(CODE_SEPARATOR);
}

function singletonCode(kind: LedgerAccountKind, currency: string): string {
  return [kind, assertCurrency(currency)].join(CODE_SEPARATOR);
}

export const playerLiabilityCode = (playerId: string, currency: string): string =>
  scopedCode(LedgerAccountKind.PLAYER_LIABILITY, playerId, currency);

export const casinoMirrorCode = (playerId: string, currency: string): string =>
  scopedCode(LedgerAccountKind.CASINO_MIRROR, playerId, currency);

export const railClearingCode = (paymentMethodId: string, currency: string): string =>
  scopedCode(LedgerAccountKind.RAIL_CLEARING, paymentMethodId, currency);

export const houseCashCode = (paymentMethodId: string, currency: string): string =>
  scopedCode(LedgerAccountKind.HOUSE_CASH, paymentMethodId, currency);

export const suspenseUnidentifiedCode = (paymentMethodId: string, currency: string): string =>
  scopedCode(LedgerAccountKind.SUSPENSE_UNIDENTIFIED, paymentMethodId, currency);

export const ichancyAgentFloatCode = (currency: string): string =>
  singletonCode(LedgerAccountKind.ICHANCY_AGENT_FLOAT, currency);

export const houseRoundingCode = (currency: string): string =>
  singletonCode(LedgerAccountKind.HOUSE_ROUNDING, currency);

/**
 * Turn a code back into everything the database row needs. This is what makes `resolveOrCreate`
 * possible with a single unique index on `code`: the code IS the account definition, so there is no
 * second place where "what kind of account is this?" could disagree.
 */
export function parseAccountCode(code: string): ParsedAccountCode {
  const segments = code.split(CODE_SEPARATOR);
  const rawKind = segments[0];
  if (rawKind === undefined || !isAccountKind(rawKind)) {
    throw new LedgerError(
      'LEDGER_INVALID_ACCOUNT_CODE',
      `"${code}" does not start with a known ledger account kind`,
      { code },
    );
  }
  const spec = ACCOUNT_KIND_SPECS[rawKind];
  const expectedSegments = spec.scope === 'NONE' ? 2 : 3;
  if (segments.length !== expectedSegments) {
    throw new LedgerError(
      'LEDGER_INVALID_ACCOUNT_CODE',
      `${rawKind} codes have ${expectedSegments} segments, "${code}" has ${segments.length}`,
      { code, kind: rawKind },
    );
  }

  if (spec.scope === 'NONE') {
    const currencyCode = assertCurrency(segments[1] ?? '');
    return {
      code,
      kind: rawKind,
      spec,
      currencyCode,
      playerId: null,
      paymentMethodId: null,
      name: `${spec.label} (${currencyCode})`,
    };
  }

  const scopeId = assertScopeId(segments[1] ?? '', rawKind);
  const currencyCode = assertCurrency(segments[2] ?? '');
  return {
    code,
    kind: rawKind,
    spec,
    currencyCode,
    playerId: spec.scope === 'PLAYER' ? scopeId : null,
    paymentMethodId: spec.scope === 'PAYMENT_METHOD' ? scopeId : null,
    name: `${spec.label} ${scopeId} (${currencyCode})`,
  };
}

/** Does `balance` rest on a side this account kind is allowed to be on? */
export function satisfiesSignPolicy(balance: bigint, policy: SignPolicy): boolean {
  switch (policy) {
    case 'NON_NEGATIVE':
      return balance >= 0n;
    case 'NON_POSITIVE':
      return balance <= 0n;
    case 'ANY':
      return true;
    default: {
      const exhaustive: never = policy;
      throw new LedgerError(
        'LEDGER_INVALID_ACCOUNT_CODE',
        `Unknown sign policy ${String(exhaustive)}`,
      );
    }
  }
}
