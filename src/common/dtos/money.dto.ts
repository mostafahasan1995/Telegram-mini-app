/**
 * WHY money crosses the wire as a STRING and never as a JSON number: `{"amount": 10.07}` is already
 * 10.069999999999999 by the time JSON.parse is done, and there is no way to recover the intent. A
 * decimal string is exact, and `toMinor()` is the single sanctioned door into bigint minor units.
 *
 * The regex rejects what `parseDecimalToMinor` would throw on anyway (exponents, "+1", ".5", "1.")
 * so the caller gets a 400 with field context instead of a 500 from a MoneyError deeper in.
 */
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches } from 'class-validator';
import { DEFAULT_MONEY_SCALE, MoneyError, parseDecimalToMinor } from '../helpers/money.util';
import { ValidationError } from '../exceptions/app.exception';
import { CommonErrorCodes } from '../exceptions/error-codes';

/** Optional leading '-', at least one digit, optionally a '.' followed by at least one digit. */
export const MONEY_STRING_REGEX = /^-?\d{1,18}(\.\d{1,6})?$/;

export class MoneyDto {
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @Matches(MONEY_STRING_REGEX, {
    message:
      'amount must be a decimal string such as "1500.00" (no exponent, no thousands separator)',
  })
  amount: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z]{3}$/, { message: 'currencyCode must be a 3-letter ISO-style code' })
  currencyCode: string = 'NSP';

  /**
   * The ONLY conversion allowed on the write path. Throws a client-safe ValidationError rather
   * than the raw MoneyError, whose codes are internal.
   */
  toMinor(scale: number = DEFAULT_MONEY_SCALE): bigint {
    try {
      return parseDecimalToMinor(this.amount, scale);
    } catch (error) {
      if (error instanceof MoneyError) {
        throw new ValidationError(
          `amount "${this.amount}" is not a valid ${this.currencyCode} value`,
          { field: 'amount', reason: error.code },
          CommonErrorCodes.INVALID_AMOUNT,
        );
      }
      throw error;
    }
  }
}
