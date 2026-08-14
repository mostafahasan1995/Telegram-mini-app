/**
 * WHY: the entire system stores and moves money as `bigint` minor units (NSP, scale 2). No float,
 * no Prisma.Decimal, no JS number ever reaches the write path. This file is the ONLY place that
 * knows how to turn a human/wire decimal string into minor units and back, so rounding behaviour is
 * reviewable in one diff instead of re-derived at every call site.
 *
 * Conventions:
 *  - "minor" = integer amount in the currency's smallest unit (12.34 NSP -> 1234n at scale 2).
 *  - Signs are meaningful: a ledger entry is negative on the credit side, and the Ichancy API wants
 *    a NEGATIVE amount for withdrawals. Nothing here silently takes an absolute value.
 *  - Every failure throws MoneyError with a STABLE code (never a translated message).
 */

/** NSP scale, frozen at seed time. Passed explicitly by callers that hold a Currency row. */
export const DEFAULT_MONEY_SCALE = 2;

/** Largest scale we accept; keeps padEnd/padStart and the number guards sane. */
const MAX_MONEY_SCALE = 8;

export type MoneyErrorCode =
  | 'MONEY_INVALID_SCALE'
  | 'MONEY_INVALID_DECIMAL'
  | 'MONEY_TOO_MANY_DECIMALS'
  | 'MONEY_NOT_FINITE'
  | 'MONEY_UNSAFE_NUMBER'
  | 'MONEY_DIVIDE_BY_ZERO'
  | 'MONEY_NEGATIVE'
  | 'MONEY_NOT_POSITIVE'
  | 'MONEY_UNKNOWN_ROUNDING';

export class MoneyError extends Error {
  constructor(
    readonly code: MoneyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Remainder/tie handling for any division of money. Callers must choose deliberately. */
export type Rounding = 'TRUNC' | 'FLOOR' | 'CEIL' | 'HALF_UP' | 'HALF_EVEN';

const DECIMAL_RE = /^([+-]?)(\d+)(?:\.(\d+))?$/;

function assertScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_MONEY_SCALE) {
    throw new MoneyError(
      'MONEY_INVALID_SCALE',
      `Scale must be an integer between 0 and ${MAX_MONEY_SCALE}, got ${String(scale)}`,
    );
  }
}

/**
 * Parse a decimal STRING ("1234.56", "-8", "+0.05") into minor units.
 * Rejects anything a float would have quietly mangled: exponents, thousands separators, empty
 * strings, and — importantly — more fraction digits than the currency has, because truncating a
 * player's amount without saying so is how ledgers drift.
 */
export function parseDecimalToMinor(input: string, scale: number = DEFAULT_MONEY_SCALE): bigint {
  assertScale(scale);
  const trimmed = input.trim();
  const match = DECIMAL_RE.exec(trimmed);
  if (!match) {
    throw new MoneyError('MONEY_INVALID_DECIMAL', `Not a plain decimal amount: "${input}"`);
  }
  const sign = match[1] ?? '';
  const whole = match[2] ?? '0';
  const fraction = match[3] ?? '';
  if (fraction.length > scale) {
    throw new MoneyError(
      'MONEY_TOO_MANY_DECIMALS',
      `"${input}" has ${fraction.length} decimals but the currency scale is ${scale}`,
    );
  }
  const magnitude = BigInt(whole + fraction.padEnd(scale, '0'));
  return sign === '-' ? -magnitude : magnitude;
}

/** Render minor units as a plain decimal string. Round-trips exactly with parseDecimalToMinor. */
export function formatMinorToDecimal(minor: bigint, scale: number = DEFAULT_MONEY_SCALE): string {
  assertScale(scale);
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(scale + 1, '0');
  const cut = digits.length - scale;
  const whole = digits.slice(0, cut);
  const fraction = scale > 0 ? `.${digits.slice(cut)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/**
 * Decode a JSON float that a third party sent us (the Ichancy API returns money as Float/string).
 * Deliberately ugly to call: it is only legitimate at the HTTP boundary, inside
 * core/ichancy/money-codec.ts. It validates that the double is even capable of representing the
 * amount before trusting it.
 */
export function fromUnsafeNumber(value: number, scale: number = DEFAULT_MONEY_SCALE): bigint {
  assertScale(scale);
  if (!Number.isFinite(value)) {
    throw new MoneyError(
      'MONEY_NOT_FINITE',
      `Wire amount is not a finite number: ${String(value)}`,
    );
  }
  const limit = Number.MAX_SAFE_INTEGER / 10 ** scale;
  if (Math.abs(value) > limit) {
    throw new MoneyError(
      'MONEY_UNSAFE_NUMBER',
      `Wire amount ${String(value)} exceeds the safe-integer range at scale ${scale}`,
    );
  }
  // toFixed rounds the double's nearest decimal representation, which is exactly what we want
  // before handing the string to the strict parser.
  return parseDecimalToMinor(value.toFixed(scale), scale);
}

/** Divide with an explicit rounding mode. All money division in the app funnels through here. */
export function divideMinor(
  numerator: bigint,
  denominator: bigint,
  rounding: Rounding = 'HALF_UP',
): bigint {
  if (denominator === 0n) {
    throw new MoneyError('MONEY_DIVIDE_BY_ZERO', 'Refusing to divide a money amount by zero');
  }
  const n = denominator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const remainder = n % d;
  if (remainder === 0n) return quotient;

  const negative = n < 0n;
  const twiceRemainder = (remainder < 0n ? -remainder : remainder) * 2n;
  const away = negative ? quotient - 1n : quotient + 1n;

  switch (rounding) {
    case 'TRUNC':
      return quotient;
    case 'FLOOR':
      return negative ? quotient - 1n : quotient;
    case 'CEIL':
      return negative ? quotient : quotient + 1n;
    case 'HALF_UP':
      return twiceRemainder >= d ? away : quotient;
    case 'HALF_EVEN':
      if (twiceRemainder > d) return away;
      if (twiceRemainder < d) return quotient;
      return quotient % 2n === 0n ? quotient : away;
    default: {
      const exhaustive: never = rounding;
      throw new MoneyError(
        'MONEY_UNKNOWN_ROUNDING',
        `Unknown rounding mode: ${String(exhaustive)}`,
      );
    }
  }
}

/** value * numerator / denominator, rounded once at the end (no intermediate precision loss). */
export function mulDivMinor(
  value: bigint,
  numerator: bigint,
  denominator: bigint,
  rounding: Rounding = 'HALF_UP',
): bigint {
  return divideMinor(value * numerator, denominator, rounding);
}

/** Percentage fee in basis points (1 bps = 0.01%). 250 bps of 100.00 = 2.50. */
export function applyBps(minor: bigint, bps: number, rounding: Rounding = 'HALF_UP'): bigint {
  if (!Number.isInteger(bps)) {
    throw new MoneyError('MONEY_INVALID_DECIMAL', `Basis points must be an integer, got ${bps}`);
  }
  return mulDivMinor(minor, BigInt(bps), 10_000n, rounding);
}

export const addMinor = (a: bigint, b: bigint): bigint => a + b;
export const subMinor = (a: bigint, b: bigint): bigint => a - b;
export const negateMinor = (a: bigint): bigint => -a;
export const absMinor = (a: bigint): bigint => (a < 0n ? -a : a);
export const minMinor = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const maxMinor = (a: bigint, b: bigint): bigint => (a > b ? a : b);
export const isZero = (a: bigint): boolean => a === 0n;
export const isPositive = (a: bigint): boolean => a > 0n;
export const isNegative = (a: bigint): boolean => a < 0n;

/** -1 | 0 | 1, so sorts and comparisons never go through Number(). */
export function compareMinor(a: bigint, b: bigint): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function sumMinor(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}

/** Guard for amounts that must never be negative (claimed amounts, balances, caps). */
export function assertNonNegative(minor: bigint, label = 'amount'): bigint {
  if (minor < 0n) {
    throw new MoneyError(
      'MONEY_NEGATIVE',
      `${label} must not be negative (got ${minor.toString()})`,
    );
  }
  return minor;
}

/** Guard for amounts that must be strictly positive (a deposit of 0 is not a deposit). */
export function assertPositive(minor: bigint, label = 'amount'): bigint {
  if (minor <= 0n) {
    throw new MoneyError(
      'MONEY_NOT_POSITIVE',
      `${label} must be greater than zero (got ${minor.toString()})`,
    );
  }
  return minor;
}

/** Convenience namespace so call sites read as `Money.parse(...)` / `Money.format(...)`. */
export const Money = Object.freeze({
  DEFAULT_SCALE: DEFAULT_MONEY_SCALE,
  parse: parseDecimalToMinor,
  format: formatMinorToDecimal,
  fromUnsafeNumber,
  divide: divideMinor,
  mulDiv: mulDivMinor,
  applyBps,
  add: addMinor,
  sub: subMinor,
  negate: negateMinor,
  abs: absMinor,
  min: minMinor,
  max: maxMinor,
  sum: sumMinor,
  compare: compareMinor,
  isZero,
  isPositive,
  isNegative,
  assertNonNegative,
  assertPositive,
});
