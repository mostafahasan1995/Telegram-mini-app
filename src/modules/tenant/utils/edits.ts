/**
 * Validated PATCH bodies turned into column values: decimal strings become bigints, and an absent key
 * stays absent so `changedFields` can tell "leave it alone" from a real edit.
 *
 * Kept apart from the services so the conversions, which decide what an operator's money rules become,
 * are testable without a database.
 */
import type { DepositMode, WithdrawalMode } from '@prisma/client';

import type { UpdatePlatformDefaultsDto } from '../dtos/update-platform-defaults.dto';
import type { UpdateTenantDto } from '../dtos/update-tenant.dto';

import type { PlatformDefaultsValues } from './platform-defaults.resolve';

/** The columns PATCH /v1/admin/tenants/:id may write, in their Prisma types. */
export type TenantEditableFields = {
  displayName: string;
  adminChatId: bigint;
  feedChatId: bigint | null;
  dualApprovalThresholdMinor: bigint;
  agentFloatLowWatermarkMinor: bigint;
  depositExpiryMinutes: number;
  depositMode: DepositMode;
  withdrawalMode: WithdrawalMode;
  miniAppUrl: string | null;
};

/** Fixed at creation. See UpdateTenantDto for why they are admitted and then refused by name. */
export const IMMUTABLE_TENANT_FIELDS = ['slug', 'currencyCode'] as const;

/** Which frozen fields the body tried to set. Any value counts, `null` included. */
export function immutableFieldsIn(dto: UpdateTenantDto): string[] {
  return IMMUTABLE_TENANT_FIELDS.filter((field) => dto[field] !== undefined);
}

export function tenantEditsFromDto(dto: UpdateTenantDto): Partial<TenantEditableFields> {
  const edits: Partial<TenantEditableFields> = {};
  if (dto.displayName !== undefined) edits.displayName = dto.displayName;
  if (dto.adminChatId !== undefined) edits.adminChatId = BigInt(dto.adminChatId);
  if (dto.feedChatId !== undefined) edits.feedChatId = BigInt(dto.feedChatId);
  if (dto.dualApprovalThresholdMinor !== undefined) {
    edits.dualApprovalThresholdMinor = BigInt(dto.dualApprovalThresholdMinor);
  }
  if (dto.agentFloatLowWatermarkMinor !== undefined) {
    edits.agentFloatLowWatermarkMinor = BigInt(dto.agentFloatLowWatermarkMinor);
  }
  if (dto.depositExpiryMinutes !== undefined) edits.depositExpiryMinutes = dto.depositExpiryMinutes;
  if (dto.depositMode !== undefined) edits.depositMode = dto.depositMode;
  if (dto.withdrawalMode !== undefined) edits.withdrawalMode = dto.withdrawalMode;
  // `null` is kept: it is the API's spelling of "remove the stored URL".
  if (dto.miniAppUrl !== undefined) edits.miniAppUrl = dto.miniAppUrl;
  return edits;
}

export function platformDefaultsEditsFromDto(
  dto: UpdatePlatformDefaultsDto,
): Partial<PlatformDefaultsValues> {
  const edits: Partial<PlatformDefaultsValues> = {};
  if (dto.ichancyBaseUrl !== undefined) edits.ichancyBaseUrl = dto.ichancyBaseUrl;
  if (dto.ichancyAgentId !== undefined) edits.ichancyAgentId = dto.ichancyAgentId;
  if (dto.currencyCode !== undefined) edits.currencyCode = dto.currencyCode;
  if (dto.dualApprovalThresholdMinor !== undefined) {
    edits.dualApprovalThresholdMinor = BigInt(dto.dualApprovalThresholdMinor);
  }
  if (dto.agentFloatLowWatermarkMinor !== undefined) {
    edits.agentFloatLowWatermarkMinor = BigInt(dto.agentFloatLowWatermarkMinor);
  }
  if (dto.depositExpiryMinutes !== undefined) edits.depositExpiryMinutes = dto.depositExpiryMinutes;
  return edits;
}
