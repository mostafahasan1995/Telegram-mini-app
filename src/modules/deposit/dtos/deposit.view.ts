/**
 * WHY explicit view mappers instead of returning Prisma rows: a DepositRequest row carries columns
 * no client may see (ipAddress, userAgent, adminChatId, idempotencyKey) and money as bigint, which
 * would reach the wire as raw MINOR units through BigInt.prototype.toJSON — "150000" where the
 * client expects "1500.00". Both mistakes are silent. Mapping in one place makes the response shape
 * a reviewable object rather than an accident of the schema.
 *
 * Every money field appears TWICE: `*Minor` (exact, for arithmetic) and `*` (formatted, for
 * display). The client never has to divide by 100 and never has to parse a float.
 */
import type { DepositProof, DepositRequest, DepositStatus } from '@prisma/client';

import { formatMinorToDecimal } from '@common/helpers/money.util';

import type { RiskFlag } from '../enums/risk-flag.enum';

export interface MoneyView {
  minor: string;
  amount: string;
  currency: string;
}

export const moneyView = (minor: bigint, currency: string): MoneyView => ({
  minor: minor.toString(),
  amount: formatMinorToDecimal(minor),
  currency,
});

export interface DepositDestinationView {
  methodCode: string;
  methodName: string;
  instructions: string | null;
  requiresReference: boolean;
  label: string | null;
  accountIdentifier: string | null;
  accountHolder: string | null;
}

export interface DepositView {
  shortId: string;
  status: DepositStatus;
  claimed: MoneyView;
  verified: MoneyView | null;
  credited: MoneyView | null;
  fee: MoneyView;
  externalReference: string | null;
  senderAccount: string | null;
  proofCount: number;
  createdAt: string;
  expiresAt: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  creditedAt: string | null;
  rejectionCode: string | null;
  rejectionNote: string | null;
  destination: DepositDestinationView | null;
}

export interface AdminDepositView extends DepositView {
  /** The uuid, which admin endpoints address rows by. Never exposed to players. */
  id: string;
  playerId: string;
  playerTelegramUserId: string | null;
  playerTelegramUsername: string | null;
  paymentMethodId: string;
  reviewStartedAt: string | null;
  decidedByAdminId: string | null;
  secondApproverAdminId: string | null;
  creditVerifiedBy: string | null;
  creditAttempts: number;
  creditKeyEpoch: number;
  riskFlags: RiskFlag[];
  requiresSecondApproval: boolean;
  proofs: DepositProofView[];
}

export interface DepositProofView {
  id: string;
  source: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  createdAt: string;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** Shape the mappers below need beyond the bare row. Assembled by the repository's `include`. */
export interface DepositViewContext {
  proofCount?: number;
  destination?: DepositDestinationView | null;
  riskFlags?: RiskFlag[];
  requiresSecondApproval?: boolean;
  proofs?: readonly DepositProof[];
  player?: {
    telegramUserId: bigint;
    telegramUsername: string | null;
  } | null;
}

export function toDepositView(
  deposit: DepositRequest,
  context: DepositViewContext = {},
): DepositView {
  const currency = deposit.currencyCode;
  return {
    shortId: deposit.shortId,
    status: deposit.status,
    claimed: moneyView(deposit.claimedAmountMinor, currency),
    verified:
      deposit.verifiedAmountMinor === null
        ? null
        : moneyView(deposit.verifiedAmountMinor, currency),
    credited:
      deposit.creditedAmountMinor === null
        ? null
        : moneyView(deposit.creditedAmountMinor, currency),
    fee: moneyView(deposit.feeMinor, currency),
    externalReference: deposit.externalReference,
    senderAccount: deposit.senderAccount,
    proofCount: context.proofCount ?? context.proofs?.length ?? 0,
    createdAt: deposit.createdAt.toISOString(),
    expiresAt: iso(deposit.expiresAt),
    submittedAt: iso(deposit.submittedAt),
    decidedAt: iso(deposit.decidedAt),
    creditedAt: iso(deposit.creditedAt),
    rejectionCode: deposit.rejectionCode,
    rejectionNote: deposit.rejectionNote,
    destination: context.destination ?? null,
  };
}

export function toAdminDepositView(
  deposit: DepositRequest,
  context: DepositViewContext = {},
): AdminDepositView {
  return {
    ...toDepositView(deposit, context),
    id: deposit.id,
    playerId: deposit.playerId,
    // Telegram ids exceed 2^53; they leave as strings or not at all.
    playerTelegramUserId: context.player?.telegramUserId.toString() ?? null,
    playerTelegramUsername: context.player?.telegramUsername ?? null,
    paymentMethodId: deposit.paymentMethodId,
    reviewStartedAt: iso(deposit.reviewStartedAt),
    decidedByAdminId: deposit.decidedByAdminId,
    secondApproverAdminId: deposit.secondApproverAdminId,
    creditVerifiedBy: deposit.creditVerifiedBy,
    creditAttempts: deposit.creditAttempts,
    creditKeyEpoch: deposit.creditKeyEpoch,
    riskFlags: context.riskFlags ?? [],
    requiresSecondApproval: context.requiresSecondApproval ?? false,
    proofs: (context.proofs ?? []).map(toDepositProofView),
  };
}

export function toDepositProofView(proof: DepositProof): DepositProofView {
  return {
    id: proof.id,
    source: proof.source,
    mimeType: proof.mimeType,
    sizeBytes: proof.sizeBytes,
    sha256: proof.sha256,
    width: proof.width,
    height: proof.height,
    createdAt: proof.createdAt.toISOString(),
  };
}
