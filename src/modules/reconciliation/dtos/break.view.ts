/**
 * WHY a view mapper: `reconciliation_breaks` carries bigints (which would reach the wire as raw
 * minor units through BigInt.prototype.toJSON) and a `detail` JSON blob that may hold anything a
 * detector put there. Mapping in one place makes the response a reviewable shape and keeps money as
 * an explicit pair of exact-and-formatted values, exactly like the deposit views.
 */
import type { Prisma, ReconciliationBreak } from '@prisma/client';

import { formatMinorToDecimal } from '@common/helpers/money.util';

export interface BreakMoney {
  minor: string;
  amount: string;
}

const money = (minor: bigint | null): BreakMoney | null =>
  minor === null ? null : { minor: minor.toString(), amount: formatMinorToDecimal(minor) };

export interface BreakView {
  id: string;
  category: string;
  status: string;
  severity: number;
  currencyCode: string;
  expected: BreakMoney | null;
  actual: BreakMoney | null;
  delta: BreakMoney | null;
  depositRequestId: string | null;
  playerId: string | null;
  ledgerAccountId: string | null;
  ichancyCallId: string | null;
  detail: Prisma.JsonValue | null;
  dedupeKey: string | null;
  detectedAt: string;
  assignedToAdminId: string | null;
  resolvedAt: string | null;
  resolvedByAdminId: string | null;
  resolutionNote: string | null;
  resolutionTxId: string | null;
}

export function toBreakView(row: ReconciliationBreak): BreakView {
  return {
    id: row.id,
    category: row.category,
    status: row.status,
    severity: row.severity,
    currencyCode: row.currencyCode,
    expected: money(row.expectedMinor),
    actual: money(row.actualMinor),
    delta: money(row.deltaMinor),
    depositRequestId: row.depositRequestId,
    playerId: row.playerId,
    ledgerAccountId: row.ledgerAccountId,
    ichancyCallId: row.ichancyCallId,
    detail: row.detail,
    dedupeKey: row.dedupeKey,
    detectedAt: row.detectedAt.toISOString(),
    assignedToAdminId: row.assignedToAdminId,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedByAdminId: row.resolvedByAdminId,
    resolutionNote: row.resolutionNote,
    resolutionTxId: row.resolutionTxId,
  };
}
