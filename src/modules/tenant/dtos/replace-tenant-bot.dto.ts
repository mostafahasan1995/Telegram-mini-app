/**
 * PATCH /v1/admin/tenants/:id/bot: `{ botToken }` (dashboard src/types/tenant.ts
 * `UpdateTenantBotBody`). The shape is checked here, before anything asks Telegram, so a typo fails
 * as a field error in the dialog rather than as a getMe round trip. Whether Telegram accepts the
 * token is the service's job, with the same field name in the answer.
 */
import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';

import { BOT_TOKEN_SHAPE_MESSAGE } from './create-tenant.dto';
import { BOT_TOKEN_PATTERN, trimString } from './field-validators';

export class ReplaceTenantBotDto {
  @Transform(trimString)
  @IsString({ message: BOT_TOKEN_SHAPE_MESSAGE })
  @Matches(BOT_TOKEN_PATTERN, { message: BOT_TOKEN_SHAPE_MESSAGE })
  botToken!: string;
}
