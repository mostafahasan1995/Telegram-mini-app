/**
 * WHY cursor paging exists alongside offset paging: the admin deposit queue is written to while it
 * is being read. OFFSET-based paging silently skips or repeats rows when new deposits arrive between
 * page 1 and page 2 — unacceptable in a review queue where a skipped row is an unreviewed payment.
 * Anything ordered by (createdAt, id) should use this DTO.
 *
 * The cursor is opaque on purpose: it is produced by `cursorPage()` and must never be parsed or
 * constructed by the client. Length is capped so it cannot be used as a payload smuggling channel.
 */
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, MaxLength, Min, Max } from 'class-validator';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './pagination-query.dto';

export class CursorQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  // base64url / hex / uuid / ISO timestamps only — never arbitrary text.
  @Matches(/^[A-Za-z0-9._:~-]+$/, { message: 'cursor is malformed' })
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be an integer' })
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit: number = DEFAULT_PAGE_SIZE;

  /**
   * Repositories must fetch one row MORE than the page size so `cursorPage()` can tell whether a
   * next page exists without a second COUNT query.
   */
  get takePlusOne(): number {
    return this.limit + 1;
  }
}
