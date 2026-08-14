/**
 * WHY `verifiedAmount` is a separate, optional field on approval rather than a default of "whatever
 * the player claimed": the claim and the verification are different facts about the world, stored in
 * different columns, and conflating them destroys the only evidence that anyone checked. Leaving it
 * out means "the claim is what I verified" — which is a decision the admin makes explicitly by
 * omitting it, and which the audit row records as such.
 *
 * WHY `rejectionCode` is required and `rejectionNote` is not: the code is what a report can count.
 * A free-text note nobody can aggregate is not a reason, it is a comment.
 */
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { RejectionCode } from '@prisma/client';

import { MoneyDto } from '@common/dtos/money.dto';

export class ApproveDepositDto {
  /** Amount the admin actually confirmed. Omit to accept the player's claim verbatim. */
  @IsOptional()
  @ValidateNested()
  @Type(() => MoneyDto)
  verifiedAmount?: MoneyDto;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class RejectDepositDto {
  @IsEnum(RejectionCode, { message: 'rejectionCode must be one of the defined rejection codes' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  rejectionCode: RejectionCode;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  rejectionNote?: string;
}

export class RetryCreditDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
