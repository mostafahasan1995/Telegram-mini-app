import { DepositStatus } from '@prisma/client';

import { RiskFlags } from '../enums/risk-flag.enum';
import {
  buildCursorWhere,
  buildOrderBy,
  buildWhere,
  combineWhere,
  decodeDepositCursor,
  encodeDepositCursor,
  readRiskFlags,
} from './deposit-filter.util';

const UUID = '3f6b2c1e-9a44-4f2b-8f0e-1d2c3b4a5e6f';

describe('buildWhere', () => {
  it('returns an empty clause for an empty filter rather than inventing defaults', () => {
    expect(buildWhere({})).toEqual({});
  });

  it('maps scalar filters one to one', () => {
    expect(buildWhere({ playerId: UUID, currencyCode: 'NSP', shortId: 'K7Q2ZP9V3M' })).toEqual({
      playerId: UUID,
      currencyCode: 'NSP',
      shortId: 'K7Q2ZP9V3M',
    });
  });

  it('ignores an empty status list instead of producing `in: []`, which matches nothing', () => {
    expect(buildWhere({ status: [] })).toEqual({});
    expect(buildWhere({ status: [DepositStatus.SUBMITTED] })).toEqual({
      status: { in: [DepositStatus.SUBMITTED] },
    });
  });

  it('builds a half-open createdAt range (gte, lt)', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2026-02-01T00:00:00.000Z');
    expect(buildWhere({ createdFrom: from, createdTo: to })).toEqual({
      createdAt: { gte: from, lt: to },
    });
    expect(buildWhere({ createdFrom: from })).toEqual({ createdAt: { gte: from } });
  });

  it('bounds the amount with bigints on both ends', () => {
    expect(buildWhere({ minAmountMinor: 100n, maxAmountMinor: 900n })).toEqual({
      claimedAmountMinor: { gte: 100n, lte: 900n },
    });
  });

  it('distinguishes "unclaimed" (null) from "claim went stale" (lt)', () => {
    expect(buildWhere({ unclaimedOnly: true })).toEqual({ reviewStartedAt: null });
    const cutoff = new Date('2026-08-12T10:00:00.000Z');
    expect(buildWhere({ claimExpiredBefore: cutoff })).toEqual({
      reviewStartedAt: { lt: cutoff },
    });
  });
});

describe('buildOrderBy', () => {
  it('always ends on id so the ordering is total', () => {
    for (const sort of ['newest', 'oldest', 'amount_desc', 'amount_asc'] as const) {
      const order = buildOrderBy(sort);
      expect(Object.keys(order[order.length - 1] ?? {})).toEqual(['id']);
    }
  });

  it('defaults to newest first', () => {
    expect(buildOrderBy()).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });
});

describe('cursor codec', () => {
  const cursor = { createdAt: new Date('2026-08-12T09:30:00.000Z'), id: UUID };

  it('round-trips', () => {
    const decoded = decodeDepositCursor(encodeDepositCursor(cursor));
    expect(decoded?.id).toBe(UUID);
    expect(decoded?.createdAt.toISOString()).toBe(cursor.createdAt.toISOString());
  });

  it('only produces characters CursorQueryDto accepts', () => {
    expect(encodeDepositCursor(cursor)).toMatch(/^[A-Za-z0-9._:~-]+$/);
  });

  it('returns null for anything malformed instead of throwing', () => {
    expect(decodeDepositCursor(undefined)).toBeNull();
    expect(decodeDepositCursor('')).toBeNull();
    expect(decodeDepositCursor('notanumber~' + UUID)).toBeNull();
    expect(decodeDepositCursor('123~not-a-uuid')).toBeNull();
    expect(decodeDepositCursor(`123~${UUID}~extra`)).toBeNull();
  });
});

describe('buildCursorWhere', () => {
  const cursor = { createdAt: new Date('2026-08-12T09:30:00.000Z'), id: UUID };

  it('compares the (createdAt, id) tuple downwards for newest-first', () => {
    expect(buildCursorWhere(cursor, 'newest')).toEqual({
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: UUID } },
      ],
    });
  });

  it('flips the comparison for oldest-first', () => {
    expect(buildCursorWhere(cursor, 'oldest')).toEqual({
      OR: [
        { createdAt: { gt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { gt: UUID } },
      ],
    });
  });

  it('refuses to keyset-page an amount sort, because the cursor carries no amount', () => {
    expect(buildCursorWhere(cursor, 'amount_desc')).toBeNull();
    expect(buildCursorWhere(null, 'newest')).toBeNull();
  });
});

describe('combineWhere', () => {
  it('drops empties and does not wrap a single clause', () => {
    expect(combineWhere(null, { playerId: UUID }, undefined)).toEqual({ playerId: UUID });
    expect(combineWhere()).toEqual({});
  });

  it('ANDs rather than merging, so two clauses cannot overwrite the same key', () => {
    const a = { createdAt: { gte: new Date(0) } };
    const b = { createdAt: { lt: new Date(1) } };
    expect(combineWhere(a, b)).toEqual({ AND: [a, b] });
  });
});

describe('readRiskFlags', () => {
  it('reads known flags and drops anything it does not recognise', () => {
    expect(
      readRiskFlags({ riskFlags: [RiskFlags.DUPLICATE_PROOF_EXACT, 'NOT_A_FLAG', 42] }),
    ).toEqual([RiskFlags.DUPLICATE_PROOF_EXACT]);
  });

  it('de-duplicates', () => {
    expect(readRiskFlags({ riskFlags: [RiskFlags.NEW_PLAYER, RiskFlags.NEW_PLAYER] })).toEqual([
      RiskFlags.NEW_PLAYER,
    ]);
  });

  it('is total over junk metadata', () => {
    expect(readRiskFlags(null)).toEqual([]);
    expect(readRiskFlags('nope')).toEqual([]);
    expect(readRiskFlags([1, 2])).toEqual([]);
    expect(readRiskFlags({ riskFlags: 'DUPLICATE_PROOF_EXACT' })).toEqual([]);
  });
});
