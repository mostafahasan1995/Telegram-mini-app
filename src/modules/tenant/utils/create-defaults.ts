/**
 * Every value a new operator's row gets, resolved from the request and its defaults. Pure, so each
 * rule is tested without a database or Telegram.
 *
 * THE RULES (dashboard docs/API-CONTRACT.md, "What fills them in", as changed by the owner's
 * 2026-09-15 decisions on staff groups):
 *  - `adminChatId` <- the request, else NOTHING: the operator is created with no staff group (stored as
 *    0, answered as null) and stays SUSPENDED until one is bound from Telegram. It is no longer the
 *    creating admin's own Telegram id: that is a person's private chat, which is never a staff group,
 *    and it was never verified. A chat named in the request is verified with Telegram before the row
 *    is written (TenantTelegramService.verifyChatsForNewBot). An explicit 0 is refused: it is no chat.
 *  - `feedChatId` <- the request, else nothing: it has no default.
 *  - `ichancyAgentId` <- the request, then PlatformDefaults, then tenant zero's, each skipped when it
 *    holds a placeholder (tenant zero's migration literal is `unused`), else VALIDATION_FAILED naming
 *    the field with the mock's own sentence.
 *  - everything else <- PlatformDefaults, and the modes and mini app URL <- the column defaults
 *    (MANUAL, MANUAL, no URL), which is what the create form's blank choice means.
 *
 * Every refusal is collected, so the admin fixes the form once rather than once per field.
 */
import { DepositMode, WithdrawalMode } from '@prisma/client';

import { UNBOUND_CHAT_ID } from '@core/telegram/utils/chat-membership.util';

import type { CreateTenantDto } from '../dtos/create-tenant.dto';

import { resolveIchancyAgentId, type PlatformDefaultsValues } from './platform-defaults.resolve';

export const AGENT_ID_UNRESOLVED_MESSAGE =
  'ichancyAgentId is required: no platform default and no tenant zero to fall back to';

export const ADMIN_CHAT_ZERO_MESSAGE =
  'adminChatId must be a real Telegram chat id: 0 is no chat, and nothing sent there arrives';

/** The non-secret columns of a new operator's row, in their Prisma types. */
export interface ResolvedTenantValues {
  displayName: string;
  /** UNBOUND_CHAT_ID (0) when the request named no staff group. */
  adminChatId: bigint;
  feedChatId: bigint | null;
  ichancyBaseUrl: string;
  ichancyUsername: string;
  ichancyAgentId: string;
  currencyCode: string;
  dualApprovalThresholdMinor: bigint;
  agentFloatLowWatermarkMinor: bigint;
  depositExpiryMinutes: number;
  depositMode: DepositMode;
  withdrawalMode: WithdrawalMode;
  miniAppUrl: string | null;
}

export interface CreateDefaultsInput {
  dto: CreateTenantDto;
  platformDefaults: PlatformDefaultsValues;
  tenantZeroAgentId: string | null;
}

export type CreateDefaultsResult =
  | {
      ok: true;
      values: ResolvedTenantValues;
      /** Which optional fields came from a default rather than the request, for the audit row. */
      defaulted: string[];
    }
  | { ok: false; fields: string[] };

export function resolveCreateDefaults(input: CreateDefaultsInput): CreateDefaultsResult {
  const { dto, platformDefaults: defaults } = input;
  const fields: string[] = [];
  const defaulted: string[] = [];

  const pick = <T>(field: string, supplied: T | undefined, fallback: T): T => {
    if (supplied !== undefined) return supplied;
    defaulted.push(field);
    return fallback;
  };

  const agentId = resolveIchancyAgentId(
    dto.ichancyAgentId,
    defaults.ichancyAgentId,
    input.tenantZeroAgentId,
  );
  if (agentId === null) fields.push(AGENT_ID_UNRESOLVED_MESSAGE);
  if (dto.ichancyAgentId === undefined) defaulted.push('ichancyAgentId');

  // Absent is "no staff group yet", which is not a default: nothing was filled in.
  let adminChatId: bigint | null = UNBOUND_CHAT_ID;
  if (dto.adminChatId !== undefined) {
    adminChatId = BigInt(dto.adminChatId);
    if (adminChatId === UNBOUND_CHAT_ID) {
      adminChatId = null;
      fields.push(ADMIN_CHAT_ZERO_MESSAGE);
    }
  }

  if (agentId === null || adminChatId === null) return { ok: false, fields };

  const values: ResolvedTenantValues = {
    displayName: dto.displayName,
    adminChatId,
    feedChatId: dto.feedChatId === undefined ? null : BigInt(dto.feedChatId),
    ichancyBaseUrl: pick('ichancyBaseUrl', dto.ichancyBaseUrl, defaults.ichancyBaseUrl),
    ichancyUsername: dto.ichancyUsername,
    ichancyAgentId: agentId,
    currencyCode: pick('currencyCode', dto.currencyCode, defaults.currencyCode),
    dualApprovalThresholdMinor: pick(
      'dualApprovalThresholdMinor',
      dto.dualApprovalThresholdMinor === undefined
        ? undefined
        : BigInt(dto.dualApprovalThresholdMinor),
      defaults.dualApprovalThresholdMinor,
    ),
    agentFloatLowWatermarkMinor: pick(
      'agentFloatLowWatermarkMinor',
      dto.agentFloatLowWatermarkMinor === undefined
        ? undefined
        : BigInt(dto.agentFloatLowWatermarkMinor),
      defaults.agentFloatLowWatermarkMinor,
    ),
    depositExpiryMinutes: pick(
      'depositExpiryMinutes',
      dto.depositExpiryMinutes,
      defaults.depositExpiryMinutes,
    ),
    depositMode: dto.depositMode ?? DepositMode.MANUAL,
    withdrawalMode: dto.withdrawalMode ?? WithdrawalMode.MANUAL,
    miniAppUrl: dto.miniAppUrl ?? null,
  };

  return { ok: true, values, defaulted };
}
