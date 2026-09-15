/**
 * The staff directory's bodies and view (API-CONTRACT.md "Admin directory"; the console's
 * CreateAdminBody / UpdateAdminBody in manager-account-dashboard src/types/admin.ts).
 *
 * WHY THERE IS NO `telegramUserId` ANY MORE: a staff account IS a username and a password
 * (2026-09-05). The contract refuses the field outright rather than ignoring it, and leaving it
 * undeclared is how: the global ValidationPipe runs `forbidNonWhitelisted`, so a client still sending
 * it gets a 400 naming the property.
 *
 * WHY THE USERNAME IS LOWER-CASED BEFORE IT IS VALIDATED: "unique per tenant, lower-cased on write".
 * `@@unique([tenantId, username])` is case-sensitive in Postgres, so the fold has to happen before the
 * row is written, and validating the folded value means the rule checked is the rule stored.
 *
 * WHY THE PASSWORD IS NEVER TRIMMED: a leading or trailing space is a real character in a password.
 * Its 8–72 bound is counted in code points by the same function the hasher uses, so a password this
 * DTO accepts can never reach `PasswordHasherService.hash()` and throw.
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
  ValidateBy,
  ValidateIf,
  type ValidationOptions,
} from 'class-validator';
import { AdminRole } from '@prisma/client';

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordLengthIsAcceptable,
} from '@core/auth/services/password-hasher.service';

import {
  ADMIN_USERNAME_MAX_LENGTH,
  ADMIN_USERNAME_MIN_LENGTH,
  ADMIN_USERNAME_PATTERN,
  normalizeAdminUsername,
} from '../admin-username';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const foldUsername = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? normalizeAdminUsername(value) : value;

/** One sentence for every way a username can be wrong, the same one the console mock answers. */
const USERNAME_RULE = `username may contain letters, digits and . _ @ + - only, and is ${ADMIN_USERNAME_MIN_LENGTH} to ${ADMIN_USERNAME_MAX_LENGTH} characters`;
const PASSWORD_RULE = `password must be ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters`;

/** A console password the hasher will accept. The message never echoes the value. */
function IsConsolePassword(validationOptions?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isConsolePassword',
      validator: {
        validate: (value: unknown): boolean =>
          typeof value === 'string' && passwordLengthIsAcceptable(value),
        defaultMessage: (): string => PASSWORD_RULE,
      },
    },
    validationOptions,
  );
}

export class CreateAdminUserDto {
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(120)
  displayName: string;

  @IsEnum(AdminRole, { message: 'role must be a valid AdminRole' })
  role: AdminRole;

  @IsString({ message: USERNAME_RULE })
  @Transform(foldUsername)
  @MinLength(ADMIN_USERNAME_MIN_LENGTH, { message: USERNAME_RULE })
  @MaxLength(ADMIN_USERNAME_MAX_LENGTH, { message: USERNAME_RULE })
  @Matches(ADMIN_USERNAME_PATTERN, { message: USERNAME_RULE })
  username: string;

  @IsConsolePassword()
  password: string;
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
  @IsString({ message: USERNAME_RULE })
  @Transform(foldUsername)
  @MinLength(ADMIN_USERNAME_MIN_LENGTH, { message: USERNAME_RULE })
  @MaxLength(ADMIN_USERNAME_MAX_LENGTH, { message: USERNAME_RULE })
  @Matches(ADMIN_USERNAME_PATTERN, { message: USERNAME_RULE })
  username?: string;

  /**
   * Blank means unchanged: absent or `""` leaves the stored hash alone, because the console cannot
   * read the password back to prefill the field. Anything else must be a whole valid password.
   */
  @ValidateIf((_object: object, value: unknown) => value !== undefined && value !== '')
  @IsConsolePassword()
  password?: string;
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

/**
 * Never exposes `passwordHash` or `totpSecretEnc`. Mirrors the dashboard's `adminUserSchema`:
 * `telegramUserId` is null for a console-only admin (and "0" for an operator's agent principal), and
 * `hasPassword` is the only thing the view says about the password.
 */
export interface AdminUserView {
  id: string;
  telegramUserId: string | null;
  username: string | null;
  hasPassword: boolean;
  displayName: string;
  role: AdminRole;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}
