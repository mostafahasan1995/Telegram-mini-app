/**
 * POST /v1/admin/tenants, with exactly the fields the dashboard's create form can send
 * (manager-account-dashboard src/types/tenant.ts `CreateTenantBody`, rules from
 * tenant-form-dialog.tsx `createSchemaFor` and `toCreateBody`).
 *
 * FOUR ARE REQUIRED: displayName, botToken, ichancyUsername, ichancyPassword. Everything else has a
 * server-side default and is validated only when the key is PRESENT.
 *
 * ABSENT, NOT EMPTY. The contract: "an omitted one must be absent from the JSON rather than `""` or
 * `null`, or the backend stores the empty value instead of resolving the default". Storing the empty
 * value is the failure it describes, so a present `""` or `null` is refused here with a 400 naming
 * the field, never stored and never quietly read as "use the default". The one exception is
 * `miniAppUrl`, where the API documents null as "no URL".
 *
 * NOTHING SECRET IS TRIMMED BUT THE TOKEN: the console trims the bot token before sending it (a
 * pasted token carries a newline more often than not), and a token never contains whitespace. The
 * Ichancy password is taken exactly as typed, because a space is a legitimate password character.
 *
 * Money and ids arrive as strings for the reason they leave as strings: a JSON number loses the last
 * digits of a 64-bit value before any validator runs.
 */
import { Transform } from 'class-transformer';
import {
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
  AGENT_ID_PATTERN,
  BOT_TOKEN_PATTERN,
  CURRENCY_CODE_PATTERN,
  HTTPS_URL_PATTERN,
  IsMinorUnits,
  IsTelegramChatId,
  SLUG_PATTERN,
  isDefined,
  trimString,
  upperCaseTrimmed,
} from './field-validators';

/** The mock's own sentence for a token of the wrong shape, so both backends read the same. */
export const BOT_TOKEN_SHAPE_MESSAGE =
  'botToken must look like 123456789:AA... — the token BotFather gave you';

const EXPIRY_MESSAGE =
  `depositExpiryMinutes must be whole minutes between ${MIN_DEPOSIT_EXPIRY_MINUTES} ` +
  `and ${MAX_DEPOSIT_EXPIRY_MINUTES}`;

const SLUG_MESSAGE =
  'slug must be 3 to 32 lowercase letters, digits and hyphens, starting with a letter and not ' +
  'ending with a hyphen';

export class CreateTenantDto {
  @Transform(trimString)
  @IsString({ message: 'displayName must be a string' })
  @MinLength(1, { message: 'displayName must not be empty' })
  @MaxLength(MAX_DISPLAY_NAME_LENGTH, {
    message: `displayName must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`,
  })
  displayName!: string;

  @Transform(trimString)
  @IsString({ message: BOT_TOKEN_SHAPE_MESSAGE })
  @Matches(BOT_TOKEN_PATTERN, { message: BOT_TOKEN_SHAPE_MESSAGE })
  botToken!: string;

  @Transform(trimString)
  @IsString({ message: 'ichancyUsername must be a string' })
  @MinLength(1, { message: 'ichancyUsername must not be empty' })
  ichancyUsername!: string;

  @IsString({ message: 'ichancyPassword must be a string' })
  @MinLength(1, { message: 'ichancyPassword must not be empty' })
  ichancyPassword!: string;

  @ValidateIf(isDefined)
  @Transform(trimString)
  @IsString({ message: SLUG_MESSAGE })
  @Matches(SLUG_PATTERN, { message: SLUG_MESSAGE })
  slug?: string;

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
  @IsString({ message: 'ichancyBaseUrl must be an https URL' })
  @MaxLength(MAX_URL_LENGTH, {
    message: `ichancyBaseUrl must be ${MAX_URL_LENGTH} characters or fewer`,
  })
  @Matches(HTTPS_URL_PATTERN, { message: 'ichancyBaseUrl must be an https URL' })
  ichancyBaseUrl?: string;

  @ValidateIf(isDefined)
  @Transform(trimString)
  @IsString({ message: 'ichancyAgentId must be digits only' })
  @Matches(AGENT_ID_PATTERN, { message: 'ichancyAgentId must be digits only' })
  ichancyAgentId?: string;

  @ValidateIf(isDefined)
  @Transform(upperCaseTrimmed)
  @IsString({ message: 'currencyCode must be three letters, such as NSP' })
  @Matches(CURRENCY_CODE_PATTERN, { message: 'currencyCode must be three letters, such as NSP' })
  currencyCode?: string;

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

  /** `null` means no URL; absent means the same. An https URL otherwise. */
  @ValidateIf((_object: object, value: unknown) => value !== undefined && value !== null)
  @Transform(trimString)
  @IsString({ message: 'miniAppUrl must be an https URL, or null' })
  @MaxLength(MAX_URL_LENGTH, {
    message: `miniAppUrl must be ${MAX_URL_LENGTH} characters or fewer`,
  })
  @Matches(HTTPS_URL_PATTERN, { message: 'miniAppUrl must be an https URL, or null' })
  miniAppUrl?: string | null;
}
