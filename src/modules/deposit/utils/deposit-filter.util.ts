/**
 * WHY these are pure functions and not methods on the repository: the admin queue's filter is the
 * one piece of this module a support engineer will change under pressure ("show me everything from
 * this player on this rail since Tuesday"). A pure `buildWhere` can be unit-tested exhaustively in
 * milliseconds; the same logic embedded in a repository method can only be tested with a database.
 *
 * WHY the cursor is `<epochMillis>~<uuid>` and not an offset: the review queue is append-heavy and
 * is read WHILE it is written. With OFFSET, a deposit that arrives between page 1 and page 2 shifts
 * every later row down by one — the reviewer never sees the row that got pushed across the page
 * boundary. A keyset cursor on (createdAt, id) cannot skip a row, and (createdAt, id) is total
 * because id is unique. The `~` separator is inside the character class CursorQueryDto allows, so
 * the cursor survives validation without base64 padding games.
 */
import type { DepositStatus, Prisma } from '@prisma/client';

import { isRiskFlag, type RiskFlag } from '../enums/risk-flag.enum';

export type DepositSort = 'newest' | 'oldest' | 'amount_desc' | 'amount_asc';

export interface DepositFilter {
  playerId?: string;
  status?: readonly DepositStatus[];
  paymentMethodId?: string;
  currencyCode?: string;
  shortId?: string;
  externalReference?: string;
  decidedByAdminId?: string;
  /** Inclusive lower bound on createdAt. */
  createdFrom?: Date;
  /** Exclusive upper bound on createdAt. */
  createdTo?: Date;
  minAmountMinor?: bigint;
  maxAmountMinor?: bigint;
  /** Only rows whose review claim has gone stale (reviewStartedAt older than this). */
  claimExpiredBefore?: Date;
  /** Only rows nobody is currently reviewing. */
  unclaimedOnly?: boolean;
}

/**
 * Compose the WHERE clause. Every branch is additive — there is no "if nothing is set, return
 * everything except…" shortcut, because a filter that silently widens is how an admin ends up
 * looking at a queue that is missing rows.
 */
export function buildWhere(filter: DepositFilter): Prisma.DepositRequestWhereInput {
  const where: Prisma.DepositRequestWhereInput = {};

  if (filter.playerId !== undefined) where.playerId = filter.playerId;
  if (filter.paymentMethodId !== undefined) where.paymentMethodId = filter.paymentMethodId;
  if (filter.currencyCode !== undefined) where.currencyCode = filter.currencyCode;
  if (filter.shortId !== undefined) where.shortId = filter.shortId;
  if (filter.decidedByAdminId !== undefined) where.decidedByAdminId = filter.decidedByAdminId;
  if (filter.externalReference !== undefined) {
    where.externalReference = filter.externalReference;
  }

  if (filter.status !== undefined && filter.status.length > 0) {
    where.status = { in: [...filter.status] };
  }

  if (filter.createdFrom !== undefined || filter.createdTo !== undefined) {
    where.createdAt = {
      ...(filter.createdFrom === undefined ? {} : { gte: filter.createdFrom }),
      ...(filter.createdTo === undefined ? {} : { lt: filter.createdTo }),
    };
  }

  if (filter.minAmountMinor !== undefined || filter.maxAmountMinor !== undefined) {
    where.claimedAmountMinor = {
      ...(filter.minAmountMinor === undefined ? {} : { gte: filter.minAmountMinor }),
      ...(filter.maxAmountMinor === undefined ? {} : { lte: filter.maxAmountMinor }),
    };
  }

  if (filter.unclaimedOnly === true) where.reviewStartedAt = null;

  // A stale claim is "started before X" — a null reviewStartedAt is NOT stale, it is unclaimed, and
  // conflating the two would let the release sweep steal a deposit nobody had claimed.
  if (filter.claimExpiredBefore !== undefined) {
    where.reviewStartedAt = { lt: filter.claimExpiredBefore };
  }

  return where;
}

/**
 * Ordering. `id` is always the last key: without it the sort is not total, and a keyset cursor over
 * a non-total order can loop or skip when two rows share a timestamp to the microsecond.
 */
export function buildOrderBy(
  sort: DepositSort = 'newest',
): Prisma.DepositRequestOrderByWithRelationInput[] {
  switch (sort) {
    case 'oldest':
      return [{ createdAt: 'asc' }, { id: 'asc' }];
    case 'amount_desc':
      return [{ claimedAmountMinor: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }];
    case 'amount_asc':
      return [{ claimedAmountMinor: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }];
    case 'newest':
    default:
      return [{ createdAt: 'desc' }, { id: 'desc' }];
  }
}

export interface DepositCursor {
  createdAt: Date;
  id: string;
}

const CURSOR_SEPARATOR = '~';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeDepositCursor(row: DepositCursor): string {
  return `${row.createdAt.getTime()}${CURSOR_SEPARATOR}${row.id}`;
}

/** Null for anything malformed: a cursor is client input and an old one may outlive a deploy. */
export function decodeDepositCursor(raw: string | undefined | null): DepositCursor | null {
  if (typeof raw !== 'string') return null;
  const [millis, id, ...rest] = raw.split(CURSOR_SEPARATOR);
  if (rest.length > 0 || millis === undefined || id === undefined) return null;
  if (!/^\d{1,15}$/.test(millis) || !UUID_PATTERN.test(id)) return null;
  const createdAt = new Date(Number(millis));
  return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
}

/**
 * Keyset predicate for the next page. Expressed as the tuple comparison
 * `(createdAt, id) < (cursor.createdAt, cursor.id)` — written out as an OR because SQL row-value
 * comparison is not available through Prisma's query builder.
 *
 * Only the two createdAt-ordered sorts are keyset-pageable; amount sorts are not (two rows can share
 * an amount AND the cursor carries no amount), so they fall back to no cursor and the caller must
 * not offer "load more" on them.
 */
export function buildCursorWhere(
  cursor: DepositCursor | null,
  sort: DepositSort = 'newest',
): Prisma.DepositRequestWhereInput | null {
  if (cursor === null) return null;
  if (sort !== 'newest' && sort !== 'oldest') return null;

  return sort === 'newest'
    ? {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      }
    : {
        OR: [
          { createdAt: { gt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { gt: cursor.id } },
        ],
      };
}

/** AND the filter and the cursor without either being able to overwrite the other's keys. */
export function combineWhere(
  ...parts: (Prisma.DepositRequestWhereInput | null | undefined)[]
): Prisma.DepositRequestWhereInput {
  const present = parts.filter(
    (part): part is Prisma.DepositRequestWhereInput => part !== null && part !== undefined,
  );
  if (present.length === 0) return {};
  if (present.length === 1) return present[0] as Prisma.DepositRequestWhereInput;
  return { AND: present };
}

/**
 * Read risk flags back out of a DepositTransition's metadata.
 *
 * SCHEMA-FORCED (see enums/risk-flag.enum.ts): deposit_requests has no riskFlags column, so the
 * flags live in the append-only transition row that recorded the submission. Unknown strings are
 * dropped rather than trusted — the metadata is JSON and may have been written by an older deploy.
 */
export function readRiskFlags(metadata: unknown): RiskFlag[] {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return [];
  const raw = (metadata as Record<string, unknown>)['riskFlags'];
  if (!Array.isArray(raw)) return [];
  const flags: RiskFlag[] = [];
  for (const entry of raw) {
    if (isRiskFlag(entry) && !flags.includes(entry)) flags.push(entry);
  }
  return flags;
}
