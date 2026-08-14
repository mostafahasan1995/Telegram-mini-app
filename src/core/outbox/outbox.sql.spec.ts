/**
 * WHY assert the SQL text: every clause in the claim query is load-bearing and each one fails
 * SILENTLY if it is dropped. Without SKIP LOCKED two relays block on each other; without FOR UPDATE
 * they claim the same rows and every message is published twice; without the status predicate a
 * SENT row is republished; without LIMIT one tick can lock the whole table. None of that shows up
 * in a normal unit test because a single-threaded test never contends.
 *
 * The queries themselves were additionally executed against a real PostgreSQL 17 (including a
 * two-session SKIP LOCKED contention check) while this file was written; this spec is what stops
 * the shape from regressing afterwards.
 */
import {
  OUTBOX_CLAIM_BATCH_SIZE,
  OUTBOX_MAX_PUBLISH_ATTEMPTS,
  OUTBOX_PUBLISH_BACKOFF_MAX_MS,
  outboxJobId,
  publishBackoffMs,
} from './outbox.constants';
import { buildClaimQuery, buildReaperQuery, buildStatusCountQuery } from './outbox.sql';

/** Collapse whitespace so the assertions describe structure, not indentation. */
const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

describe('buildClaimQuery', () => {
  const query = buildClaimQuery(OUTBOX_CLAIM_BATCH_SIZE, 'relay-1');
  const text = flat(query.text);

  it('claims through a CTE that both locks and skips locked rows', () => {
    expect(text).toContain('WITH claimed AS');
    expect(text).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('only considers PENDING rows whose backoff has elapsed', () => {
    expect(text).toContain("status = 'PENDING'::outbox_status");
    expect(text).toContain('available_at <= now()');
  });

  it('is FIFO and bounded', () => {
    expect(text).toContain('ORDER BY id');
    expect(text).toContain('LIMIT $1');
    expect(query.values[0]).toBe(OUTBOX_CLAIM_BATCH_SIZE);
  });

  it('flips the status and stamps the owner in the same statement', () => {
    expect(text).toContain("SET status = 'IN_FLIGHT'::outbox_status");
    expect(text).toContain('locked_at = now()');
    expect(text).toContain('locked_by = $2');
    expect(query.values[1]).toBe('relay-1');
  });

  it('burns an attempt at claim time, not at failure time', () => {
    // A process that dies mid-publish must still consume an attempt, otherwise a crash loop
    // retries the same row forever and never reaches DEAD.
    expect(text).toContain('attempts = m.attempts + 1');
  });

  it('returns an explicit, camelCase-aliased column list rather than m.*', () => {
    expect(text).toContain('RETURNING m.id');
    expect(text).toContain('m.aggregate_type AS "aggregateType"');
    expect(text).toContain('m.aggregate_id AS "aggregateId"');
    expect(text).toContain('m.available_at AS "availableAt"');
    expect(text).toContain('m.created_at AS "createdAt"');
    expect(text).not.toContain('m.*');
  });

  it('parameterises everything a caller controls', () => {
    expect(query.values).toEqual([OUTBOX_CLAIM_BATCH_SIZE, 'relay-1']);
  });
});

describe('buildReaperQuery', () => {
  const staleBefore = new Date('2026-01-01T00:00:00.000Z');
  const query = buildReaperQuery(staleBefore, OUTBOX_MAX_PUBLISH_ATTEMPTS, 'RECLAIMED');
  const text = flat(query.text);

  it('only touches rows abandoned in flight', () => {
    expect(text).toContain("WHERE status = 'IN_FLIGHT'::outbox_status");
    expect(text).toContain('locked_at < $3::timestamptz');
    expect(query.values[2]).toBe(staleBefore);
  });

  it('does not hand an exhausted row a second retry budget', () => {
    expect(text).toContain("WHEN attempts >= $1 THEN 'DEAD'::outbox_status");
    expect(text).toContain("ELSE 'PENDING'::outbox_status");
    expect(query.values[0]).toBe(OUTBOX_MAX_PUBLISH_ATTEMPTS);
  });

  it('clears the lock so another relay can pick the row up', () => {
    expect(text).toContain('locked_at = NULL');
    expect(text).toContain('locked_by = NULL');
  });
});

describe('buildStatusCountQuery', () => {
  it('casts the count so the driver returns a number, not a bigint string', () => {
    expect(flat(buildStatusCountQuery().text)).toContain('count(*)::int AS count');
  });
});

describe('outboxJobId', () => {
  it('is derived only from the row id, which is what makes republishing a no-op', () => {
    expect(outboxJobId('abc')).toBe('outbox-abc');
    expect(outboxJobId('abc')).toBe(outboxJobId('abc'));
  });
});

describe('publishBackoffMs', () => {
  it('grows exponentially and stays inside the window', () => {
    const first = publishBackoffMs(1, () => 0);
    const second = publishBackoffMs(2, () => 0);
    expect(second).toBe(first * 2);
    expect(publishBackoffMs(1, () => 0.999)).toBeLessThan(publishBackoffMs(2, () => 0));
  });

  it('is capped so a long outage cannot park a row for hours', () => {
    expect(publishBackoffMs(50, () => 0.999)).toBeLessThanOrEqual(OUTBOX_PUBLISH_BACKOFF_MAX_MS);
  });

  it('jitters, so a fleet of relays does not retry in lockstep', () => {
    expect(publishBackoffMs(3, () => 0)).not.toBe(publishBackoffMs(3, () => 0.9));
  });

  it('never returns zero for the first failure', () => {
    expect(publishBackoffMs(0, () => 0)).toBeGreaterThan(0);
    expect(publishBackoffMs(1, () => 0)).toBeGreaterThan(0);
  });
});
