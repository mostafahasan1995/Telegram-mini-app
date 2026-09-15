/**
 * TenantView: the one shape every `/v1/admin/tenants` route answers, field for field the dashboard's
 * `tenantSchema` (manager-account-dashboard src/types/tenant.ts).
 *
 * WHAT IS NEVER HERE: the bot token, the webhook secret, the Ichancy password, the Sham Cash key and
 * the webhook path token. The contract makes them write-only. The path token is reported only as
 * `hasWebhookPath`, because it is half of a webhook's credentials: anyone holding it can post
 * updates at the operator's route.
 *
 * WHY THE SELECT IS A CONSTANT: a query that loads the whole row puts every sealed column into memory
 * and one spread away from a response. Selecting the view's columns by name means a new secret
 * column never reaches this mapper by accident. `webhookPathToken` is the single exception, loaded
 * only so the mapper can say whether one exists. It is read into a boolean and dropped.
 *
 * WHY EVERY BIGINT BECOMES A STRING HERE: chat ids are signed 64-bit Telegram ids and a channel id
 * such as -1001234567890 is already past what a JS number holds exactly. Minor units have the same
 * problem, so they cross the wire as decimal strings too. The global BigInt.toJSON would also emit
 * a string, but the view type says `string`, and that is what the console's schema parses.
 */
import type { DepositMode, Prisma, TenantStatus, WithdrawalMode } from '@prisma/client';

import { boundChatOf } from '@core/telegram/utils/chat-membership.util';

export const TENANT_VIEW_SELECT = {
  id: true,
  slug: true,
  displayName: true,
  status: true,
  webhookPathToken: true,
  adminChatId: true,
  feedChatId: true,
  botUsername: true,
  ichancyBaseUrl: true,
  ichancyUsername: true,
  ichancyAgentId: true,
  currencyCode: true,
  dualApprovalThresholdMinor: true,
  agentFloatLowWatermarkMinor: true,
  depositExpiryMinutes: true,
  depositMode: true,
  withdrawalMode: true,
  miniAppUrl: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.TenantSelect;

export type TenantViewRow = Prisma.TenantGetPayload<{ select: typeof TENANT_VIEW_SELECT }>;

/** `counts` is optional on the wire. When the server has not counted, it omits the object. */
export interface TenantCounts {
  players: number;
  deposits: number;
}

export interface TenantView {
  id: string;
  slug: string;
  displayName: string;
  status: TenantStatus;
  hasWebhookPath: boolean;
  /**
   * The staff group, or null while none is bound (stored as 0). An operator with null here cannot be
   * activated, and nothing it would send to staff (review cards, alerts, reports) reaches Telegram.
   */
  adminChatId: string | null;
  feedChatId: string | null;
  botUsername: string | null;
  ichancyBaseUrl: string;
  ichancyUsername: string;
  ichancyAgentId: string;
  currencyCode: string;
  dualApprovalThresholdMinor: string;
  agentFloatLowWatermarkMinor: string;
  depositExpiryMinutes: number;
  depositMode: DepositMode;
  withdrawalMode: WithdrawalMode;
  miniAppUrl: string | null;
  /**
   * True when this deployment runs with ICHANCY_FAKE. Deployment-wide, repeated on every operator
   * because the console reads operators, not deployments: an ACTIVE status reached under the fake was
   * "verified" by a fixture, and the screen showing that status is where it has to be said.
   */
  ichancyFake: boolean;
  createdAt: string;
  updatedAt: string;
  counts?: TenantCounts;
}

/** What the mapper needs beyond the row. `ichancyFake` is required so no caller can forget it. */
export interface TenantViewContext {
  ichancyFake: boolean;
  counts?: TenantCounts;
}

export function toTenantView(row: TenantViewRow, context: TenantViewContext): TenantView {
  const { counts } = context;
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    status: row.status,
    // Existence only. An empty string is not a token either; nothing writes one, but a hand-edited
    // row must not read as routable.
    hasWebhookPath: row.webhookPathToken !== null && row.webhookPathToken.length > 0,
    adminChatId: boundChatOf(row.adminChatId)?.toString() ?? null,
    feedChatId: boundChatOf(row.feedChatId)?.toString() ?? null,
    botUsername: row.botUsername,
    ichancyBaseUrl: row.ichancyBaseUrl,
    ichancyUsername: row.ichancyUsername,
    ichancyAgentId: row.ichancyAgentId,
    currencyCode: row.currencyCode,
    dualApprovalThresholdMinor: row.dualApprovalThresholdMinor.toString(),
    agentFloatLowWatermarkMinor: row.agentFloatLowWatermarkMinor.toString(),
    depositExpiryMinutes: row.depositExpiryMinutes,
    depositMode: row.depositMode,
    withdrawalMode: row.withdrawalMode,
    miniAppUrl: row.miniAppUrl,
    ichancyFake: context.ichancyFake,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(counts === undefined ? {} : { counts: { players: counts.players, deposits: counts.deposits } }),
  };
}
