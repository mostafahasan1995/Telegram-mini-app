/**
 * WHY dedupe keys are constructed here and shared by the detector and the resolver: a break is
 * written by a cron that runs every fifteen minutes. Without a stable natural key, the same finding
 * becomes 96 rows a day and the queue of "things a human must look at" becomes noise. With one, the
 * cron UPDATES the existing row and an operator sees a single, ageing item.
 *
 * The keys deliberately do NOT include a timestamp: "account X's cache disagrees with its entries"
 * is the same finding at 09:00 and at 09:15, and its delta changing does not make it a new problem.
 * The only exception is the agent-float drift, which is keyed by the day so a drift that is fixed
 * and returns tomorrow is a new item rather than a re-opened one.
 */

/** Invariant sweep cadence. Fifteen minutes bounds how long a broken ledger can go unnoticed. */
export const INVARIANT_CHECK_INTERVAL_MS = 15 * 60_000;

/** Agent-float comparison. More often than the invariants: it is the number that stops credits. */
export const AGENT_FLOAT_SYNC_INTERVAL_MS = 5 * 60_000;

/** Rail ageing is a report, not an alarm; hourly is enough. */
export const RAIL_AGEING_INTERVAL_MS = 60 * 60_000;

/** Only one replica sweeps per tick. Slightly under the interval so a tick is never skipped. */
export const RECON_LOCK_TTL_MS = 4 * 60_000;

/** Row cap per invariant check, so a broken ledger cannot produce an unbounded alert. */
export const INVARIANT_ROW_LIMIT = 100;

/**
 * Below this the agent float mismatch is treated as a rounding artefact rather than a break. Zero,
 * on purpose: both sides are exact integers in minor units, so any difference at all is real. The
 * constant exists to make that a stated decision rather than an absent one.
 */
export const AGENT_FLOAT_TOLERANCE_MINOR = 0n;

/** Ageing buckets for RAIL_CLEARING, in days. Anything past the last bucket is "stale". */
export const RAIL_AGEING_BUCKET_DAYS: readonly number[] = Object.freeze([1, 3, 7, 30]);

export const breakKeys = {
  invariant: (invariant: string, subject: string): string => `invariant:${invariant}:${subject}`,
  /** Keyed by UTC day: a drift that recurs tomorrow is a new finding, not the same one ageing. */
  agentFloat: (currencyCode: string, day: string): string => `agent-float:${currencyCode}:${day}`,
  stuckDeposit: (depositRequestId: string): string => `stuck-deposit:${depositRequestId}`,
  railAgeing: (accountCode: string, day: string): string => `rail-ageing:${accountCode}:${day}`,
} as const;

export const utcDay = (date: Date = new Date()): string => date.toISOString().slice(0, 10);
