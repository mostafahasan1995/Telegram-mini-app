/**
 * WHY a hard MAX_PAGE_SIZE: an admin list endpoint over deposit_requests with `limit=100000` is a
 * trivial way to stall the pool. The cap is enforced by the validator, not by the repository, so
 * every list endpoint inherits it for free.
 *
 * `@Type(() => Number)` is mandatory: query strings arrive as strings and @IsInt() would reject
 * "20". ValidationPipe must run with `transform: true` for this to apply.
 */
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export class PaginationQueryDto {
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

  /** Prisma-shaped alias, so repositories do not re-derive it. */
  get take(): number {
    return this.limit;
  }

  get skip(): number {
    return this.offset;
  }
}
