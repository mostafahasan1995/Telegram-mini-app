/**
 * The staff-facing player DTOs. Separate from auth.dto.ts and player.view.ts because these describe
 * an ADMIN surface: what a human operator may search by, and what they are told after asking us to
 * open an Ichancy account for somebody.
 */
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PlayerStatus } from '@prisma/client';

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@common/dtos/pagination-query.dto';

/**
 * WHY telegramUserId is a STRING and not a number: Telegram ids are 64-bit and exceed
 * Number.MAX_SAFE_INTEGER. `@Type(() => Number)` on one would silently round it — turning a search
 * for one person into a search for a person who does not exist.
 */
export class ListPlayersQueryDto {
  @IsOptional()
  @IsEnum(PlayerStatus, { message: 'status must be a valid player status' })
  status?: PlayerStatus;

  @IsOptional()
  @Matches(/^\d{1,19}$/, { message: 'telegramUserId must be a positive integer' })
  telegramUserId?: string;

  /** true = only players WITH an Ichancy account, false = only those still missing one. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean({ message: 'linked must be true or false' })
  linked?: boolean;

  /** Free text over username, first/last name and the Ichancy login. */
  @IsOptional()
  @IsString()
  @MaxLength(64, { message: 'search is too long' })
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be an integer' })
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit: number = DEFAULT_PAGE_SIZE;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'offset must be an integer' })
  @Min(0)
  offset: number = 0;
}

/**
 * What POST /v1/admin/players/:id/ichancy-account answers.
 *
 * `created` is the whole point of the response: false means the account already existed (either we
 * had linked it before, or Ichancy answered "Duplicate login" and we resolved the id by lookup), so
 * an operator who clicked twice learns that nothing new was minted rather than wondering.
 */
export interface IchancyAccountView {
  readonly playerId: string;
  readonly ichancyPlayerId: string;
  readonly ichancyLogin: string;
  readonly created: boolean;
  /** The agent this account hangs off — `parentId` on registerPlayer, from ICHANCY_AGENT_ID. */
  readonly agentId: string;
}
