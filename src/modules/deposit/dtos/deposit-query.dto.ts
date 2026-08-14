/**
 * WHY the admin queue extends CursorQueryDto and the player list extends PaginationQueryDto: the
 * admin queue is written to while it is read (every new deposit lands at the top), so OFFSET paging
 * would let an unreviewed payment slip across a page boundary unseen. A player's own history is
 * small and append-only from their point of view, so offset paging is honest there and gives them a
 * total.
 *
 * Amount filters arrive as DECIMAL STRINGS and are converted to bigint minor units by the
 * controller. A query parameter is a string on the wire anyway; turning it into a JS number on the
 * way past would be the one place in this codebase where money touches a float.
 */
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { DepositStatus } from '@prisma/client';

import { CursorQueryDto } from '@common/dtos/cursor-query.dto';
import { PaginationQueryDto } from '@common/dtos/pagination-query.dto';
import { MONEY_STRING_REGEX } from '@common/dtos/money.dto';

import type { DepositSort } from '../utils/deposit-filter.util';

/** `?status=SUBMITTED,UNDER_REVIEW` — a comma list is friendlier than repeated query keys. */
const toStatusArray = ({ value }: { value: unknown }): unknown => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;
  return value
    .split(',')
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => entry.length > 0);
};

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const toBoolean = ({ value }: { value: unknown }): unknown =>
  value === undefined ? undefined : value === true || value === 'true' || value === '1';

const MONEY_MESSAGE = 'amount must be a decimal string such as "1500.00"';

export class ListDepositsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Transform(toStatusArray)
  @IsArray()
  @IsEnum(DepositStatus, { each: true, message: 'status contains an unknown deposit status' })
  status?: DepositStatus[];
}

export class AdminDepositQueueQueryDto extends CursorQueryDto {
  @IsOptional()
  @Transform(toStatusArray)
  @IsArray()
  @IsEnum(DepositStatus, { each: true, message: 'status contains an unknown deposit status' })
  status?: DepositStatus[];

  @IsOptional()
  @IsUUID('4')
  playerId?: string;

  @IsOptional()
  @IsUUID('4')
  paymentMethodId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  shortId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  externalReference?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'createdFrom must be an ISO-8601 timestamp' })
  createdFrom?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'createdTo must be an ISO-8601 timestamp' })
  createdTo?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @Matches(MONEY_STRING_REGEX, { message: MONEY_MESSAGE })
  minAmount?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @Matches(MONEY_STRING_REGEX, { message: MONEY_MESSAGE })
  maxAmount?: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  unclaimedOnly?: boolean;

  @IsOptional()
  @IsIn(['newest', 'oldest', 'amount_desc', 'amount_asc'])
  sort?: DepositSort;
}
