/**
 * PATCH /v1/admin/tenants/:id, with exactly the fields the dashboard's edit form can send
 * (manager-account-dashboard src/types/tenant.ts `UpdateTenantBody`, rules from
 * tenant-form-dialog.tsx `editSchemaFor`).
 *
 * ABSENT MEANS "LEAVE IT ALONE". Every field is validated only when the key is present, and an
 * explicit `null` is refused everywhere except `miniAppUrl`, where the API documents null as "clear
 * it". A null chat id or threshold is not a way to reset anything: the columns are NOT NULL (or, for
 * the feed chat, the console says "the API has no way to unset a feed chat").
 *
 * WHY `slug` AND `currencyCode` ARE DECLARED AT ALL: without them `forbidNonWhitelisted` would refuse
 * them with "property slug should not exist", a sentence that suggests a typo. They are real fields
 * that are deliberately frozen (the slug is in every log line and audit record, the currency
 * denominates every recorded amount), so the service refuses them by name with
 * TENANT_FIELD_IMMUTABLE instead. `@Allow()` only admits the key; nothing is ever written from it.
 *
 * Money and ids arrive as strings for the reason they leave as strings: a JSON number loses the last
 * digits of a 64-bit value before any validator runs.
 */
import { Transform } from 'class-transformer';
import {
  Allow,
  IsEnum,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { DepositMode, WithdrawalMode } from '@prisma/client';

import {
  MAX_DEPOSIT_EXPIRY_MINUTES,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_URL_LENGTH,
  MIN_DEPOSIT_EXPIRY_MINUTES,
} from '../tenant-admin.constants';

import {
  HTTPS_URL_PATTERN,
  IsMinorUnits,
  IsTelegramChatId,
  isDefined,
  trimString,
} from './field-validators';

const EXPIRY_MESSAGE =
  `depositExpiryMinutes must be whole minutes between ${MIN_DEPOSIT_EXPIRY_MINUTES} ` +
  `and ${MAX_DEPOSIT_EXPIRY_MINUTES}`;

export class UpdateTenantDto {
  @ValidateIf(isDefined)
  @Transform(trimString)
  @IsString({ message: 'displayName must be a string' })
  @MinLength(1, { message: 'displayName must not be empty' })
  @MaxLength(MAX_DISPLAY_NAME_LENGTH, {
    message: `displayName must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`,
  })
  displayName?: string;

  @ValidateIf(isDefined)
  @Transform(trimString)
  @IsTelegramChatId()
  adminChatId?: string;

  @ValidateIf(isDefined)
  @Transform(trimString)
  @IsTelegramChatId()
  feedChatId?: string;

  @ValidateIf(isDefined)
  @Transform(trimString)
  @IsMinorUnits()
  dualApprovalThresholdMinor?: string;

  @ValidateIf(isDefined)
  @Transform(trimString)
  @IsMinorUnits()
  agentFloatLowWatermarkMinor?: string;

  @ValidateIf(isDefined)
  @IsInt({ message: EXPIRY_MESSAGE })
  @Min(MIN_DEPOSIT_EXPIRY_MINUTES, { message: EXPIRY_MESSAGE })
  @Max(MAX_DEPOSIT_EXPIRY_MINUTES, { message: EXPIRY_MESSAGE })
  depositExpiryMinutes?: number;

  @ValidateIf(isDefined)
  @IsEnum(DepositMode, { message: 'depositMode must be AUTO or MANUAL' })
  depositMode?: DepositMode;

  @ValidateIf(isDefined)
  @IsEnum(WithdrawalMode, { message: 'withdrawalMode must be AUTO or MANUAL' })
  withdrawalMode?: WithdrawalMode;

  /** `null` clears it; absent leaves it alone. */
  @ValidateIf((_object: object, value: unknown) => value !== undefined && value !== null)
  @Transform(trimString)
  @IsString({ message: 'miniAppUrl must be an https URL, or null to clear it' })
  @MaxLength(MAX_URL_LENGTH, {
    message: `miniAppUrl must be ${MAX_URL_LENGTH} characters or fewer`,
  })
  @Matches(HTTPS_URL_PATTERN, { message: 'miniAppUrl must be an https URL, or null to clear it' })
  miniAppUrl?: string | null;

  /** Frozen after creation. Admitted only so the service can refuse it by name. */
  @Allow()
  slug?: unknown;

  /** Frozen after creation. Admitted only so the service can refuse it by name. */
  @Allow()
  currencyCode?: unknown;
}
