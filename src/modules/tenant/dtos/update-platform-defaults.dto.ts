/**
 * PATCH /v1/admin/platform-defaults (manager-account-dashboard src/types/tenant.ts
 * `UpdatePlatformDefaultsBody`). The rules match the create form's advanced fields, because each
 * value here is what that form's blank field turns into.
 *
 * AN ABSENT KEY LEAVES THE STORED VALUE ALONE, and an explicit null is refused, for every field. It
 * matters most for `ichancyAgentId`: it is the one value tenant creation cannot derive from anything
 * else, so clearing it by accident would break the next creation with a 400 naming a field nobody
 * touched. The contract documents no way to clear it, so none is offered.
 *
 * The currency is checked against the Currency table by the service, not here: it is a foreign key
 * on `tenants`, so an unchecked code would fail later, on somebody else's tenant creation.
 */
import { Transform } from 'class-transformer';
import { IsInt, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';

import {
  MAX_DEPOSIT_EXPIRY_MINUTES,
  MAX_URL_LENGTH,
  MIN_DEPOSIT_EXPIRY_MINUTES,
} from '../tenant-admin.constants';

import {
  AGENT_ID_PATTERN,
  CURRENCY_CODE_PATTERN,
  HTTPS_URL_PATTERN,
  IsMinorUnits,
  isDefined,
  trimString,
} from './field-validators';

const EXPIRY_MESSAGE =
  `depositExpiryMinutes must be whole minutes between ${MIN_DEPOSIT_EXPIRY_MINUTES} ` +
  `and ${MAX_DEPOSIT_EXPIRY_MINUTES}`;

/** Upper-cased before validation, as the create form does: "nsp" is a typing accident, not a code. */
const upperCaseTrimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class UpdatePlatformDefaultsDto {
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
}
