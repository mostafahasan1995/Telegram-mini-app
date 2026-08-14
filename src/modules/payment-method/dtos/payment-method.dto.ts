/**
 * WHY the wire field names drop the `Minor` suffix (`minAmount`, not `minAmountMinor`): the client
 * sends MAJOR units as decimal strings ("50.00") and the service converts. A field literally named
 * `...Minor` that accepted major units would mislead whoever builds the admin panel into sending
 * 5000 when they meant 50 — a hundredfold error in a limit that gates real money.
 *
 * `feeBps` is an integer and stays one: basis points are already the whole-number representation of
 * a fraction, which is exactly why fees are expressed in them rather than as a float percentage.
 */
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaymentRail, VerificationMode } from '@prisma/client';

import { MONEY_STRING_REGEX } from '@common/dtos/money.dto';

import type { RailProofField } from '../rails/rail.interface';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const upper = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

const MONEY_MESSAGE = 'must be a decimal amount such as "1500.00"';

/** Machine code used by seeds and the mini app: SCREAMING_SNAKE, stable forever. */
const METHOD_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,47}$/;

export class CreatePaymentMethodDto {
  @IsString()
  @Transform(upper)
  @Matches(METHOD_CODE_PATTERN, {
    message: 'code must be SCREAMING_SNAKE_CASE, 2-48 characters, starting with a letter',
  })
  code: string;

  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(120)
  displayName: string;

  @IsEnum(PaymentRail, { message: 'rail must be a valid PaymentRail' })
  rail: PaymentRail;

  @IsString()
  @Transform(upper)
  @Matches(/^[A-Z]{3}$/, { message: 'currencyCode must be a 3-letter code' })
  currencyCode: string;

  @IsEnum(VerificationMode, { message: 'verificationMode must be a valid VerificationMode' })
  verificationMode: VerificationMode;

  @IsString()
  @Transform(trim)
  @Matches(MONEY_STRING_REGEX, { message: `minAmount ${MONEY_MESSAGE}` })
  minAmount: string;

  @IsString()
  @Transform(trim)
  @Matches(MONEY_STRING_REGEX, { message: `maxAmount ${MONEY_MESSAGE}` })
  maxAmount: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @Matches(MONEY_STRING_REGEX, { message: `feeFixed ${MONEY_MESSAGE}` })
  feeFixed?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  // 10000 bps = 100%. Anything above is certainly a typo, and it would consume the whole deposit.
  @Max(10_000)
  feeBps?: number;

  @IsOptional()
  @IsBoolean()
  requiresReference?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  referencePattern?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  instructions?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

/** Every field optional; `code`, `rail` and `currencyCode` are immutable and absent by design. */
export class UpdatePaymentMethodDto {
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(120)
  displayName?: string;

  @IsOptional()
  @IsEnum(VerificationMode)
  verificationMode?: VerificationMode;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @Matches(MONEY_STRING_REGEX, { message: `minAmount ${MONEY_MESSAGE}` })
  minAmount?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @Matches(MONEY_STRING_REGEX, { message: `maxAmount ${MONEY_MESSAGE}` })
  maxAmount?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @Matches(MONEY_STRING_REGEX, { message: `feeFixed ${MONEY_MESSAGE}` })
  feeFixed?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  feeBps?: number;

  @IsOptional()
  @IsBoolean()
  requiresReference?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  referencePattern?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  instructions?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

export class ListPaymentMethodsQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsEnum(PaymentRail)
  rail?: PaymentRail;
}

/** What a player sees. No `isActive` (they only ever see active ones) and no `referencePattern`. */
export interface PaymentMethodView {
  id: string;
  code: string;
  displayName: string;
  rail: PaymentRail;
  currencyCode: string;
  verificationMode: VerificationMode;
  minAmount: string;
  maxAmount: string;
  feeFixed: string;
  feeBps: number;
  requiresReference: boolean;
  instructions: string | null;
  /** From the rail driver, so the mini app renders the right form without hardcoding rails. */
  requiredProofFields: readonly RailProofField[];
}

export interface AdminPaymentMethodView extends PaymentMethodView {
  isActive: boolean;
  sortOrder: number;
  referencePattern: string | null;
  createdAt: string;
  updatedAt: string;
}
