/**
 * WHY `$meta` exists: the audit_logs table has columns for who/what/when and two JSON snapshots,
 * but no column for "how much money was involved" and no free-form metadata bag — and the table is
 * protected by an append-only trigger, so a migration cannot be walked back. Rather than lose that
 * context (or overload `before`), the service folds `amountMinor` and `metadata` into a single
 * reserved key inside `after`.
 *
 * The `$` prefix is what makes it safe: no Prisma field and no domain snapshot key can start with
 * one, so the reserved key can never collide with a real column being snapshotted. Read it back
 * with readAuditContext() and get a clean snapshot with stripAuditContext().
 */
import type { Prisma } from '@prisma/client';

import { fromDbJson, isJsonObject, type JsonObject } from '@core/queue/json.util';
import type { Actor } from '@common/types/actor.type';

export const AUDIT_CONTEXT_KEY = '$meta';
/** Key inside `$meta` that carries the money amount, as a decimal string of minor units. */
export const AUDIT_AMOUNT_KEY = 'amountMinor';

export interface AuditWriteInput {
  /** Stable verb, `<entity>.<action>`: "deposit.approve", "admin.limit.update". Never translated. */
  action: string;
  actor: Actor;
  /** Prisma model name of the thing that changed, e.g. "DepositRequest". */
  subjectType: string;
  subjectId: string;
  /** State before the change. Omit (do not pass null) when there was no prior state. */
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  /** Money involved, in minor units. Stored as a string inside `$meta`. */
  amountMinor?: bigint;
  /** Anything else that explains the decision (rejection code, ichancy error, matched reference). */
  metadata?: Record<string, unknown>;
  /**
   * Leave these out to inherit the ambient request context — the Prisma actor-stamp extension fills
   * them from AsyncLocalStorage. Pass them only when you know better than the request does.
   */
  ip?: string;
  userAgent?: string;
  correlationId?: string;
}

/** Everything folded into the reserved key. */
export type AuditContext = JsonObject;

export function readAuditContext(after: Prisma.JsonValue | null | undefined): AuditContext | null {
  const value = fromDbJson(after);
  if (!isJsonObject(value)) return null;
  const context = value[AUDIT_CONTEXT_KEY];
  return isJsonObject(context) ? context : null;
}

/** The snapshot as the caller passed it, with the reserved key removed. */
export function stripAuditContext(after: Prisma.JsonValue | null | undefined): JsonObject | null {
  const value = fromDbJson(after);
  if (!isJsonObject(value)) return null;
  const clean: JsonObject = {};
  for (const [key, member] of Object.entries(value)) {
    if (key !== AUDIT_CONTEXT_KEY) clean[key] = member;
  }
  return clean;
}

export function readAuditAmountMinor(after: Prisma.JsonValue | null | undefined): bigint | null {
  const context = readAuditContext(after);
  const raw = context?.[AUDIT_AMOUNT_KEY];
  if (typeof raw !== 'string') return null;
  try {
    return BigInt(raw);
  } catch {
    // A malformed amount in an old row must not break a report that is reading history.
    return null;
  }
}
