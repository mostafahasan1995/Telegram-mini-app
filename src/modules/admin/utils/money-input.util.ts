/**
 * WHY this tiny helper is duplicated per module rather than shared: `eslint-plugin-boundaries`
 * forbids modules/A -> modules/B, and @common may not grow a module-specific converter for every
 * feature. Ten lines of duplication is the honest price of the layering rule; the CONVERSION itself
 * is not duplicated — it delegates to the single sanctioned parser in @common/helpers/money.util.
 */
import { MoneyError, parseDecimalToMinor } from '@common/helpers/money.util';
import { ValidationError } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';

/**
 * Decimal string -> bigint minor units, or a client-safe 400.
 * The raw MoneyError never escapes: its codes are internal and its message names our helpers.
 */
export function toMinorOrThrow(value: string, field: string, scale?: number): bigint {
  try {
    return parseDecimalToMinor(value, scale);
  } catch (error) {
    if (error instanceof MoneyError) {
      throw new ValidationError(
        `${field} must be a decimal amount such as "1500.00"`,
        { field, reason: error.code },
        CommonErrorCodes.INVALID_AMOUNT,
      );
    }
    throw error;
  }
}

/** Same, for optional fields. `undefined`/`null` pass through untouched. */
export function toMinorOrNull(
  value: string | null | undefined,
  field: string,
  scale?: number,
): bigint | null {
  if (value === null || value === undefined) return null;
  return toMinorOrThrow(value, field, scale);
}
