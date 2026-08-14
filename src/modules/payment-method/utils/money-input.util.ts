/**
 * Module-local decimal-string -> bigint-minor converter. Duplicated per module because
 * eslint-plugin-boundaries forbids modules/A -> modules/B and @common must not grow a converter per
 * feature. The parsing itself is NOT duplicated — it delegates to @common/helpers/money.util.
 */
import { MoneyError, parseDecimalToMinor } from '@common/helpers/money.util';
import { ValidationError } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';

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

export function toMinorOrNull(
  value: string | null | undefined,
  field: string,
  scale?: number,
): bigint | null {
  if (value === null || value === undefined) return null;
  return toMinorOrThrow(value, field, scale);
}
