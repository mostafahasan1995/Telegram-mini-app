/**
 * WHY money arrives as decimal STRINGS here too: an approval ceiling is money, and money is never a
 * JSON number anywhere in this codebase. `{"maxSingleApprovalMinor": 10000000.01}` is already
 * imprecise by the time it is parsed — and this particular number decides how much a person may
 * release without a second pair of eyes.
 *
 * The field names carry no `Minor` suffix on the wire on purpose: the client sends major units
 * ("15000.00"), and the service converts. A wire field called `...Minor` that accepted major units
 * would be a trap for whoever writes the admin panel.
 */
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches } from 'class-validator';
import { MONEY_STRING_REGEX } from '@common/dtos/money.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const MONEY_MESSAGE = 'must be a decimal amount such as "1500.00" (no exponent, no separators)';

export class SetApprovalLimitDto {
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z]{3}$/, { message: 'currencyCode must be a 3-letter code' })
  currencyCode: string;

  @IsString()
  @Transform(trim)
  @Matches(MONEY_STRING_REGEX, { message: `maxSingleApproval ${MONEY_MESSAGE}` })
  maxSingleApproval: string;

  @IsString()
  @Transform(trim)
  @Matches(MONEY_STRING_REGEX, { message: `maxDailyApproval ${MONEY_MESSAGE}` })
  maxDailyApproval: string;

  /**
   * Per-admin override of DUAL_APPROVAL_THRESHOLD_MINOR. Omitted (not null) means "inherit the
   * global threshold" — the two are different intentions and the service treats them differently.
   */
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Matches(MONEY_STRING_REGEX, { message: `secondApprovalAbove ${MONEY_MESSAGE}` })
  secondApprovalAbove?: string;
}

export interface ApprovalLimitView {
  id: string;
  adminUserId: string;
  currencyCode: string;
  /** Decimal strings in MAJOR units, mirroring the input contract. */
  maxSingleApproval: string;
  maxDailyApproval: string;
  secondApprovalAbove: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
}
