/**
 * WHY: this is the ONLY file in the process that is allowed to look at a float, and the only place
 * that knows the Ichancy wire scale. Everything above it speaks `bigint` minor units.
 *
 * The Ichancy API is inconsistent about money on purpose-built endpoints:
 *   - getAgentAllWallets returns every amount as a STRING  ("1234.56", sometimes "1234.5600")
 *   - getPlayerBalanceById returns `balance` as a JSON NUMBER (a double)
 *   - depositToPlayer / withdrawFromPlayer WANT a JSON number ("Float"), negative for withdrawals
 *
 * A double cannot hold every 2-decimal amount exactly, so the rule here is: decode/encode only when
 * it is provably lossless, otherwise THROW. A silently truncated amount is a ledger break that
 * nobody notices for weeks; a thrown error is an ambiguous call that reconciliation will look at
 * today. The adapter turns these throws into `ambiguous`, never into `ok`.
 *
 * eslint re-enables parseFloat/Math.round for this file only (see eslint.config.mjs). We still do
 * not use them: every conversion goes through the strict decimal-string parser in
 * @common/helpers/money.util, because `String(double)` is the shortest round-trip representation
 * and therefore the honest one.
 */
import {
  DEFAULT_MONEY_SCALE,
  formatMinorToDecimal,
  fromUnsafeNumber,
  MoneyError,
  parseDecimalToMinor,
} from '@common/helpers/money.util';

/** NSP has 2 minor digits. Frozen at seed time; passed explicitly so a second currency is a param. */
export const ICHANCY_MONEY_SCALE = DEFAULT_MONEY_SCALE;

export type IchancyMoneyCodecErrorCode =
  | 'ICHANCY_MONEY_MISSING'
  | 'ICHANCY_MONEY_MALFORMED'
  | 'ICHANCY_MONEY_PRECISION_LOSS'
  | 'ICHANCY_MONEY_OUT_OF_RANGE';

/** Stable codes, never translated messages — they end up in ichancy_calls.error_code. */
export class IchancyMoneyCodecError extends Error {
  constructor(
    readonly code: IchancyMoneyCodecErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IchancyMoneyCodecError';
  }
}

/** What the API is allowed to send us for a money field. Anything else is malformed. */
export type WireMoney = string | number;

/** Plain decimal only: no exponents, no thousands separators, no currency symbols, no bare ".5". */
const WIRE_DECIMAL_RE = /^[+-]?\d+(?:\.\d+)?$/;

function assertScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > 8) {
    throw new IchancyMoneyCodecError(
      'ICHANCY_MONEY_MALFORMED',
      `Unsupported money scale ${String(scale)}`,
    );
  }
}

/**
 * Drop fraction digits beyond `scale` ONLY when every dropped digit is a zero.
 * "1234.5600" at scale 2 -> "1234.56" (lossless), "1234.567" -> throws (would lose 0.007).
 */
function trimLosslessFraction(decimal: string, scale: number, field: string): string {
  const dot = decimal.indexOf('.');
  if (dot < 0) return decimal;
  const whole = decimal.slice(0, dot);
  const fraction = decimal.slice(dot + 1);
  if (fraction.length <= scale) return decimal;

  const kept = fraction.slice(0, scale);
  const dropped = fraction.slice(scale);
  if (/[^0]/.test(dropped)) {
    throw new IchancyMoneyCodecError(
      'ICHANCY_MONEY_PRECISION_LOSS',
      `${field}="${decimal}" carries more precision than the currency scale ${scale} can hold`,
    );
  }
  return scale === 0 ? whole : `${whole}.${kept}`;
}

function decodeDecimalString(raw: string, field: string, scale: number): bigint {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new IchancyMoneyCodecError('ICHANCY_MONEY_MISSING', `${field} is an empty string`);
  }
  if (!WIRE_DECIMAL_RE.test(trimmed)) {
    throw new IchancyMoneyCodecError(
      'ICHANCY_MONEY_MALFORMED',
      `${field}="${raw}" is not a plain decimal amount`,
    );
  }
  const normalized = trimLosslessFraction(trimmed, scale, field);
  try {
    return parseDecimalToMinor(normalized, scale);
  } catch (error) {
    const message = error instanceof MoneyError ? error.message : String(error);
    throw new IchancyMoneyCodecError('ICHANCY_MONEY_MALFORMED', `${field}: ${message}`);
  }
}

function decodeWireNumber(value: number, field: string, scale: number): bigint {
  if (!Number.isFinite(value)) {
    throw new IchancyMoneyCodecError(
      'ICHANCY_MONEY_MALFORMED',
      `${field}=${String(value)} is not a finite number`,
    );
  }
  // String(double) is the SHORTEST representation that round-trips back to the same double, so it
  // is the only representation that tells the truth about how much precision the value really has.
  const repr = String(value);
  if (repr.includes('e') || repr.includes('E')) {
    throw new IchancyMoneyCodecError(
      'ICHANCY_MONEY_OUT_OF_RANGE',
      `${field}=${repr} is outside the plain-decimal range we are willing to decode`,
    );
  }
  const dot = repr.indexOf('.');
  if (dot >= 0 && repr.length - dot - 1 > scale) {
    throw new IchancyMoneyCodecError(
      'ICHANCY_MONEY_PRECISION_LOSS',
      `${field}=${repr} has more decimals than the currency scale ${scale}; refusing to round money`,
    );
  }
  try {
    // Sanctioned float decoder. By now we have proved the double really is a <= `scale` decimal.
    return fromUnsafeNumber(value, scale);
  } catch (error) {
    const message = error instanceof MoneyError ? error.message : String(error);
    throw new IchancyMoneyCodecError('ICHANCY_MONEY_OUT_OF_RANGE', `${field}: ${message}`);
  }
}

/**
 * Decode a money field exactly as it arrived (string or number) into bigint minor units.
 * Throws IchancyMoneyCodecError on anything lossy, malformed or missing.
 */
export function parseWireMoney(
  value: unknown,
  field = 'amount',
  scale: number = ICHANCY_MONEY_SCALE,
): bigint {
  assertScale(scale);
  if (value === null || value === undefined) {
    throw new IchancyMoneyCodecError('ICHANCY_MONEY_MISSING', `${field} is missing`);
  }
  if (typeof value === 'number') return decodeWireNumber(value, field, scale);
  if (typeof value === 'string') return decodeDecimalString(value, field, scale);
  throw new IchancyMoneyCodecError(
    'ICHANCY_MONEY_MALFORMED',
    `${field} has type ${typeof value}, expected a money string or number`,
  );
}

/**
 * Same as parseWireMoney but returns null instead of throwing.
 * Used for OPTIONAL fields only — e.g. depositToPlayer sometimes answers `result: []`, which is a
 * success with an unknown resulting balance. Never use this to swallow a required amount.
 */
export function tryParseWireMoney(
  value: unknown,
  scale: number = ICHANCY_MONEY_SCALE,
): bigint | null {
  try {
    return parseWireMoney(value, 'amount', scale);
  } catch {
    return null;
  }
}

/**
 * bigint minor units -> the JSON number the API calls "Float".
 * Guarded by a full round-trip: if decoding the produced double does not give back the exact same
 * minor amount, we refuse to send it rather than move a slightly different sum of money.
 */
export function minorToWireAmount(minor: bigint, scale: number = ICHANCY_MONEY_SCALE): number {
  assertScale(scale);
  const decimal = formatMinorToDecimal(minor, scale);
  const encoded = Number(decimal);
  if (!Number.isFinite(encoded)) {
    throw new IchancyMoneyCodecError(
      'ICHANCY_MONEY_OUT_OF_RANGE',
      `${decimal} cannot be represented as a JSON number`,
    );
  }
  const roundTrip = parseWireMoney(encoded, 'amount', scale);
  if (roundTrip !== minor) {
    throw new IchancyMoneyCodecError(
      'ICHANCY_MONEY_PRECISION_LOSS',
      `${decimal} does not survive a float round trip (${String(encoded)} -> ${roundTrip.toString()})`,
    );
  }
  return encoded;
}

/** Deposit endpoints take a POSITIVE float. Callers always pass a positive minor amount. */
export function minorToCreditWireAmount(
  minor: bigint,
  scale: number = ICHANCY_MONEY_SCALE,
): number {
  if (minor <= 0n) {
    throw new IchancyMoneyCodecError(
      'ICHANCY_MONEY_MALFORMED',
      `A credit must be strictly positive, got ${minor.toString()}`,
    );
  }
  return minorToWireAmount(minor, scale);
}

/**
 * Withdraw endpoints take a NEGATIVE float. Callers pass the POSITIVE amount they want to remove
 * and the sign flip happens exactly once, here — so "negate it twice" can never become a deposit.
 */
export function minorToDebitWireAmount(minor: bigint, scale: number = ICHANCY_MONEY_SCALE): number {
  if (minor <= 0n) {
    throw new IchancyMoneyCodecError(
      'ICHANCY_MONEY_MALFORMED',
      `A debit must be given as a strictly positive amount, got ${minor.toString()}`,
    );
  }
  return minorToWireAmount(-minor, scale);
}

/** Human/log rendering. Never parse this back from a log line — parse the ledger instead. */
export function minorToDecimalString(minor: bigint, scale: number = ICHANCY_MONEY_SCALE): string {
  return formatMinorToDecimal(minor, scale);
}

export const IchancyMoneyCodec = Object.freeze({
  SCALE: ICHANCY_MONEY_SCALE,
  parse: parseWireMoney,
  tryParse: tryParseWireMoney,
  toWire: minorToWireAmount,
  toCreditWire: minorToCreditWireAmount,
  toDebitWire: minorToDebitWireAmount,
  format: minorToDecimalString,
});
