/**
 * WHY explicit result classes instead of returning `{ items, total }` and hoping the interceptor
 * recognises it: the transform interceptor must know whether a returned object IS the payload or
 * DESCRIBES a page. Structural sniffing ("has an `items` key") would misfire the day a domain
 * object legitimately has one. An `instanceof` check cannot.
 *
 * Handlers return `new PaginatedResult(rows, meta)`; the interceptor unwraps `data` into the
 * envelope's `data` and merges `meta` into the envelope's `meta`.
 */

export interface PageMeta {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface CursorMeta {
  limit: number;
  /** Opaque; pass back as `cursor` to fetch the next page. Null when the list is exhausted. */
  nextCursor: string | null;
  hasMore: boolean;
}

export class PaginatedResult<T> {
  constructor(
    readonly data: readonly T[],
    readonly meta: PageMeta,
  ) {}
}

export class CursorResult<T> {
  constructor(
    readonly data: readonly T[],
    readonly meta: CursorMeta,
  ) {}
}

/** Offset paging: `total` comes from a COUNT, `hasMore` is derived so callers cannot get it wrong. */
export function paginate<T>(
  rows: readonly T[],
  total: number,
  limit: number,
  offset: number,
): PaginatedResult<T> {
  return new PaginatedResult(rows, {
    total,
    limit,
    offset,
    hasMore: offset + rows.length < total,
  });
}

/**
 * Cursor paging: fetch `limit + 1` rows, hand them here, and this trims the probe row and derives
 * `hasMore` from its presence. Doing it in one place is what keeps "off by one extra row" bugs out
 * of every repository.
 */
export function cursorPage<T>(
  rowsPlusOne: readonly T[],
  limit: number,
  toCursor: (row: T) => string,
): CursorResult<T> {
  const hasMore = rowsPlusOne.length > limit;
  const rows = hasMore ? rowsPlusOne.slice(0, limit) : rowsPlusOne.slice();
  const last = rows[rows.length - 1];
  return new CursorResult(rows, {
    limit,
    nextCursor: hasMore && last !== undefined ? toCursor(last) : null,
    hasMore,
  });
}
