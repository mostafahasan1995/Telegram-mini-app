/**
 * WHERE-clause construction for the staff player directory, kept out of both the controller and the
 * service for the same reason deposit-filter.util.ts exists: a controller that hand-builds Prisma
 * filters is one careless spread away from widening an access scope, and a service that parses query
 * strings cannot be called from anywhere else.
 *
 * Everything here NARROWS. `PlayerAccessService.restrict()` combines the result with the viewer's
 * scope using AND, so nothing built here can ever widen what a caller is allowed to see.
 */
import type { Prisma } from '@prisma/client';

import type { ListPlayersQueryDto } from '../dtos/player-admin.dto';

/**
 * Turns the validated query into a Prisma filter.
 *
 * `search` is matched against the Telegram username and the two name fields, case-insensitively —
 * NOT against the Telegram id, which is numeric and gets its own exact-match field. A "contains"
 * search over an id column would be both slow and surprising ("123" matching 91234567).
 */
export function toPlayerWhere(query: ListPlayersQueryDto): Prisma.PlayerWhereInput {
  const where: Prisma.PlayerWhereInput = {};

  if (query.status !== undefined) where.status = query.status;

  if (query.telegramUserId !== undefined) {
    // Validated as a numeric string by the DTO, so the BigInt cast cannot throw here.
    where.telegramUserId = BigInt(query.telegramUserId);
  }

  // `linked` is the operational question this directory exists to answer: who has no Ichancy
  // account yet? Expressed as null / not-null on the id, which is the column that decides it.
  if (query.linked === true) where.ichancyPlayerId = { not: null };
  if (query.linked === false) where.ichancyPlayerId = null;

  const search = query.search?.trim();
  if (search !== undefined && search.length > 0) {
    where.OR = [
      { telegramUsername: { contains: search, mode: 'insensitive' } },
      { firstName: { contains: search, mode: 'insensitive' } },
      { lastName: { contains: search, mode: 'insensitive' } },
      { ichancyLogin: { contains: search, mode: 'insensitive' } },
    ];
  }

  return where;
}
