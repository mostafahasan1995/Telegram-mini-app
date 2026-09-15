/**
 * PlatformDefaultsView, as the dashboard's `platformDefaultsSchema` parses it
 * (manager-account-dashboard src/types/tenant.ts).
 *
 * `appliesToNewOperatorsOnly` is always true and is sent anyway, because it is the assumption most
 * likely to be wrong: editing a default changes what the NEXT operator inherits and does not reach
 * back into the ones already created. Their values were copied onto their own rows.
 *
 * `seededFromEnvAt` is bookkeeping for PlatformDefaultsService and stays off the wire.
 */
import type { PlatformDefaults } from '@prisma/client';

export interface PlatformDefaultsView {
  ichancyBaseUrl: string;
  ichancyAgentId: string | null;
  currencyCode: string;
  dualApprovalThresholdMinor: string;
  agentFloatLowWatermarkMinor: string;
  depositExpiryMinutes: number;
  updatedAt: string;
  appliesToNewOperatorsOnly: true;
}

export function toPlatformDefaultsView(row: PlatformDefaults): PlatformDefaultsView {
  return {
    ichancyBaseUrl: row.ichancyBaseUrl,
    ichancyAgentId: row.ichancyAgentId,
    currencyCode: row.currencyCode,
    dualApprovalThresholdMinor: row.dualApprovalThresholdMinor.toString(),
    agentFloatLowWatermarkMinor: row.agentFloatLowWatermarkMinor.toString(),
    depositExpiryMinutes: row.depositExpiryMinutes,
    updatedAt: row.updatedAt.toISOString(),
    appliesToNewOperatorsOnly: true,
  };
}
