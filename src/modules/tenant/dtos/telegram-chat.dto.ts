/**
 * The bodies and path of the staff/feed group routes under /v1/admin/tenants/:id/telegram.
 *
 * `purpose` is `STAFF` (the staff group, `adminChatId`) or `FEED` (the feed group, `feedChatId`),
 * spelled as the TelegramChatPurpose enum. A chat id arrives as a string for the reason every id on
 * this surface does: a JSON number loses the last digits of a 64-bit value before validation runs.
 */
import { TelegramChatPurpose } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum } from 'class-validator';

import { IsTelegramChatId, trimString } from './field-validators';
import { TenantIdParamDto } from './tenant-id-param.dto';

const PURPOSE_MESSAGE = 'purpose must be STAFF or FEED';

/** `/:id/telegram/chats/:purpose`. */
export class TenantChatPurposeParamDto extends TenantIdParamDto {
  @IsEnum(TelegramChatPurpose, { message: PURPOSE_MESSAGE })
  purpose: TelegramChatPurpose;
}

/** POST /:id/telegram/bind-links. */
export class IssueBindLinkDto {
  @IsEnum(TelegramChatPurpose, { message: PURPOSE_MESSAGE })
  purpose: TelegramChatPurpose;
}

/** PUT /:id/telegram/chats/:purpose: a discovered chat's id, or one typed on the laptop. */
export class BindTelegramChatDto {
  @Transform(trimString)
  @IsTelegramChatId()
  chatId: string;
}
