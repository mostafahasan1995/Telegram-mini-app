/**
 * PATCH /v1/admin/tenants/:id/ichancy: `{ ichancyBaseUrl?, ichancyUsername?, ichancyPassword?,
 * ichancyAgentId? }` (dashboard src/types/tenant.ts `UpdateTenantIchancyBody`, rules from
 * tenant-ichancy-dialog.tsx `schemaFor`).
 *
 * ABSENT MEANS "LEAVE IT ALONE", and the console sends only what changed: the password field starts
 * empty and an empty field is left out, and re-sending the agent id it already holds is avoided
 * because the server refuses that field once players exist. So every key is validated only when
 * present, and an explicit `null` is refused: none of these columns can be unset.
 *
 * The password is write-only in both directions. It is not trimmed (a space can be part of a
 * password) and it is never echoed in an error.
 */
import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

import { MAX_URL_LENGTH } from '../tenant-admin.constants';

import { AGENT_ID_PATTERN, HTTPS_URL_PATTERN, isDefined, trimString } from './field-validators';

/** Generous for a login; the column is text, and nothing longer is a real Ichancy username. */
const MAX_USERNAME_LENGTH = 200;
/** Generous for a password, and short enough that nobody pastes a document into it. */
const MAX_PASSWORD_LENGTH = 512;

export class UpdateTenantIchancyDto {
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
  @IsString({ message: 'ichancyUsername must be a string' })
  @MinLength(1, { message: 'ichancyUsername must not be empty' })
  @MaxLength(MAX_USERNAME_LENGTH, {
    message: `ichancyUsername must be ${MAX_USERNAME_LENGTH} characters or fewer`,
  })
  ichancyUsername?: string;

  @ValidateIf(isDefined)
  @IsString({ message: 'ichancyPassword must be a string' })
  @MinLength(1, { message: 'ichancyPassword must not be empty; leave it out to keep the stored one' })
  @MaxLength(MAX_PASSWORD_LENGTH, {
    message: `ichancyPassword must be ${MAX_PASSWORD_LENGTH} characters or fewer`,
  })
  ichancyPassword?: string;

  @ValidateIf(isDefined)
  @Transform(trimString)
  @IsString({ message: 'ichancyAgentId must be digits only' })
  @Matches(AGENT_ID_PATTERN, { message: 'ichancyAgentId must be digits only' })
  ichancyAgentId?: string;
}
