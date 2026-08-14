/**
 * WHY the break list is cursor paged like the deposit queue: breaks are appended by three crons and
 * read by a human working through them. Offset paging would let a finding slip across a page
 * boundary while somebody is triaging — the same failure as the deposit queue, with the same cost.
 */
import { Transform } from 'class-transformer';
import { IsArray, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { BreakCategory, BreakStatus } from '@prisma/client';

import { CursorQueryDto } from '@common/dtos/cursor-query.dto';

const toArray = ({ value }: { value: unknown }): unknown => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;
  return value
    .split(',')
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => entry.length > 0);
};

export class ListBreaksQueryDto extends CursorQueryDto {
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsEnum(BreakStatus, { each: true, message: 'status contains an unknown break status' })
  status?: BreakStatus[];

  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsEnum(BreakCategory, { each: true, message: 'category contains an unknown break category' })
  category?: BreakCategory[];

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(5)
  minSeverity?: number;
}

export class ResolveBreakDto {
  @IsEnum(BreakStatus, { message: 'status must be RESOLVED, WRITTEN_OFF or FALSE_POSITIVE' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  status: BreakStatus;

  /**
   * Required, and required to be substantial: "ok" is not a resolution. This note is what a future
   * auditor reads when they ask why a difference stopped being a problem.
   */
  @IsString()
  @MaxLength(2000)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  note: string;
}

export class CorrectFloatDto {
  @IsString()
  @MaxLength(2000)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  note: string;
}
