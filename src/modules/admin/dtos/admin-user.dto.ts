/**
 * WHY `telegramUserId` arrives as a STRING: Telegram ids are 64-bit and `admin_users
 * .telegram_user_id` is a BigInt column. A JSON number would be rounded by `JSON.parse` before any
 * validator ever ran — and the admin created would be a DIFFERENT person than the one typed in.
 * The regex therefore validates digits, and the service does the BigInt conversion.
 */
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { AdminRole } from '@prisma/client';

/** 1–19 digits: the widest a signed 64-bit id can be, with no sign and no separators. */
const TELEGRAM_ID_PATTERN = /^\d{1,19}$/;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateAdminUserDto {
  @IsString()
  @Transform(trim)
  @Matches(TELEGRAM_ID_PATTERN, {
    message: 'telegramUserId must be a positive integer sent as a string',
  })
  telegramUserId: string;

  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(120)
  displayName: string;

  @IsEnum(AdminRole, { message: 'role must be a valid AdminRole' })
  role: AdminRole;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(64)
  username?: string;
}

export class UpdateAdminUserDto {
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(120)
  displayName?: string;

  @IsOptional()
  @IsEnum(AdminRole, { message: 'role must be a valid AdminRole' })
  role?: AdminRole;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(64)
  username?: string;
}

export class ListAdminUsersQueryDto {
  @IsOptional()
  @IsEnum(AdminRole)
  role?: AdminRole;

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
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit: number = 20;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

/** Never exposes `passwordHash` or `totpSecretEnc`. */
export interface AdminUserView {
  id: string;
  telegramUserId: string;
  username: string | null;
  displayName: string;
  role: AdminRole;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}
