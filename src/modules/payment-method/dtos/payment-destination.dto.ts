/**
 * WHY `accountIdentifier` is not normalized by this DTO beyond trimming: it is an IBAN, an MSISDN,
 * a crypto address or an office code depending on the rail, and each has different rules about
 * case and spacing. Silently "cleaning" a Base58 address by uppercasing it would produce a valid
 * -looking string that is a different address — and the money would be gone. Operators paste the
 * exact value; we store the exact value.
 */
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { MONEY_STRING_REGEX } from '@common/dtos/money.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreatePaymentDestinationDto {
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(120)
  label: string;

  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(256)
  accountIdentifier: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(160)
  accountHolder?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** Lower is offered first; the picker turns this into a rotation weight. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priority?: number;

  /** Soft cap used to spread volume. Omit for "no cap". */
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Matches(MONEY_STRING_REGEX, { message: 'dailyCap must be a decimal amount such as "1500.00"' })
  dailyCap?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  notes?: string;
}

export class UpdatePaymentDestinationDto {
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(120)
  label?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(160)
  accountHolder?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priority?: number;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @Matches(MONEY_STRING_REGEX, { message: 'dailyCap must be a decimal amount such as "1500.00"' })
  dailyCap?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  notes?: string;
}

/**
 * What a player sees: where to pay, and nothing about how we route volume. `priority` and
 * `dailyCapMinor` are operational and would leak our capacity per account.
 */
export interface PaymentDestinationView {
  id: string;
  label: string;
  accountIdentifier: string;
  accountHolder: string | null;
  notes: string | null;
}

export interface AdminPaymentDestinationView extends PaymentDestinationView {
  paymentMethodId: string;
  isActive: boolean;
  priority: number;
  dailyCap: string | null;
  createdAt: string;
  updatedAt: string;
}
