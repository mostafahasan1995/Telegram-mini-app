/**
 * These tests are the reason the codec exists: every case below is a way a float would have silently
 * changed how much money moved.
 */
import {
  ICHANCY_MONEY_SCALE,
  IchancyMoneyCodecError,
  minorToCreditWireAmount,
  minorToDebitWireAmount,
  minorToDecimalString,
  minorToWireAmount,
  parseWireMoney,
  tryParseWireMoney,
} from './money-codec';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof IchancyMoneyCodecError) return error.code;
    return `UNEXPECTED:${String(error)}`;
  }
  return 'NO_THROW';
}

describe('money-codec', () => {
  it('uses NSP scale 2', () => {
    expect(ICHANCY_MONEY_SCALE).toBe(2);
  });

  describe('parseWireMoney — string fields (getAgentAllWallets sends strings)', () => {
    it.each([
      ['0', 0n],
      ['0.00', 0n],
      ['1234.56', 123456n],
      ['-12.30', -1230n],
      ['+5', 500n],
      ['  12.5  ', 1250n],
      ['1234.5600', 123456n], // trailing zeros are not precision
      ['999999999999999999.99', 99999999999999999999n], // far beyond a double, still exact
    ])('decodes %s', (input, expected) => {
      expect(parseWireMoney(input, 'balance')).toBe(expected);
    });

    it.each([
      ['1234.567', 'ICHANCY_MONEY_PRECISION_LOSS'],
      ['0.001', 'ICHANCY_MONEY_PRECISION_LOSS'],
      ['1e3', 'ICHANCY_MONEY_MALFORMED'],
      ['1,234.56', 'ICHANCY_MONEY_MALFORMED'],
      ['12.', 'ICHANCY_MONEY_MALFORMED'],
      ['abc', 'ICHANCY_MONEY_MALFORMED'],
      ['', 'ICHANCY_MONEY_MISSING'],
    ])('refuses %s', (input, expected) => {
      expect(codeOf(() => parseWireMoney(input, 'balance'))).toBe(expected);
    });
  });

  describe('parseWireMoney — numeric fields (getPlayerBalanceById sends a double)', () => {
    it.each([
      [0, 0n],
      [12.34, 1234n],
      [-12.34, -1234n],
      [1000, 100000n],
      [0.05, 5n],
    ])('decodes %s', (input, expected) => {
      expect(parseWireMoney(input, 'balance')).toBe(expected);
    });

    it('refuses a double that carries more precision than the currency has', () => {
      // 12.345 is a real amount of money we cannot store; rounding it here is how ledgers drift.
      expect(codeOf(() => parseWireMoney(12.345))).toBe('ICHANCY_MONEY_PRECISION_LOSS');
    });

    it('refuses doubles outside the exactly-representable range', () => {
      expect(codeOf(() => parseWireMoney(1e21))).toBe('ICHANCY_MONEY_OUT_OF_RANGE');
      expect(codeOf(() => parseWireMoney(1e16))).toBe('ICHANCY_MONEY_OUT_OF_RANGE');
      expect(codeOf(() => parseWireMoney(Number.NaN))).toBe('ICHANCY_MONEY_MALFORMED');
      expect(codeOf(() => parseWireMoney(Number.POSITIVE_INFINITY))).toBe(
        'ICHANCY_MONEY_MALFORMED',
      );
    });

    it.each([
      [null, 'ICHANCY_MONEY_MISSING'],
      [undefined, 'ICHANCY_MONEY_MISSING'],
      [true, 'ICHANCY_MONEY_MALFORMED'],
      [{}, 'ICHANCY_MONEY_MALFORMED'],
      [[], 'ICHANCY_MONEY_MALFORMED'],
    ])('refuses %p', (input, expected) => {
      expect(codeOf(() => parseWireMoney(input))).toBe(expected);
    });
  });

  describe('tryParseWireMoney', () => {
    it('returns null instead of throwing for optional fields', () => {
      expect(tryParseWireMoney(undefined)).toBeNull();
      expect(tryParseWireMoney('nonsense')).toBeNull();
      expect(tryParseWireMoney('7.50')).toBe(750n);
    });
  });

  describe('encoding to the wire', () => {
    it('round-trips every minor value in a representative range', () => {
      for (let minor = 0; minor <= 2_000; minor += 1) {
        const value = BigInt(minor);
        expect(parseWireMoney(minorToWireAmount(value))).toBe(value);
      }
    });

    it.each([
      [123456n, 1234.56],
      [1n, 0.01],
      [-1n, -0.01],
      [100n, 1],
      [0n, 0],
    ])('encodes %s as %s', (minor, expected) => {
      expect(minorToWireAmount(minor)).toBe(expected);
    });

    it('refuses to encode an amount a double cannot carry', () => {
      expect(codeOf(() => minorToWireAmount(999_999_999_999_999_999n))).toBe(
        'ICHANCY_MONEY_OUT_OF_RANGE',
      );
    });

    it('sends a POSITIVE float for credits and refuses non-positive amounts', () => {
      expect(minorToCreditWireAmount(5000n)).toBe(50);
      expect(codeOf(() => minorToCreditWireAmount(0n))).toBe('ICHANCY_MONEY_MALFORMED');
      expect(codeOf(() => minorToCreditWireAmount(-500n))).toBe('ICHANCY_MONEY_MALFORMED');
    });

    it('flips the sign exactly once for debits (the API wants a NEGATIVE float)', () => {
      expect(minorToDebitWireAmount(5000n)).toBe(-50);
      expect(minorToDebitWireAmount(1234n)).toBe(-12.34);
      // A caller must never pre-negate: that is how a withdrawal becomes a deposit.
      expect(codeOf(() => minorToDebitWireAmount(-5000n))).toBe('ICHANCY_MONEY_MALFORMED');
      expect(codeOf(() => minorToDebitWireAmount(0n))).toBe('ICHANCY_MONEY_MALFORMED');
    });
  });

  describe('minorToDecimalString', () => {
    it.each([
      [0n, '0.00'],
      [5n, '0.05'],
      [123456n, '1234.56'],
      [-1230n, '-12.30'],
    ])('renders %s as %s', (minor, expected) => {
      expect(minorToDecimalString(minor)).toBe(expected);
      expect(parseWireMoney(expected)).toBe(minor);
    });
  });
});
