/**
 * Cross-module contract for the deposit flow — same reasoning as PLAYER_LINK_PORT and
 * APPROVAL_LIMIT_PORT: the module that creates deposits cannot import this one, so the surface it
 * needs is published behind a plain string token that requires no import at all.
 *
 * The types below are intentionally free of Prisma row types: a consumer can restate this interface
 * locally using only the generated ENUMS (which every module may import from @prisma/client) and
 * plain data. Anything richer would force the consumer to reach into this module for a type.
 *
 * PROPER FIX (for whoever owns src/core): move this port into `src/core/payments/`.
 */
import type { PaymentRail, VerificationMode } from '@prisma/client';

// The one import in this file, and it costs a consumer nothing: RailStage is a plain string union,
// so restating it locally as `type RailStage = 'CREATE' | 'SUBMIT'` is structurally identical.
import type { RailStage } from './rails/rail.interface';

export const PAYMENT_METHOD_PORT = 'PAYMENT_METHOD_PORT';

export interface ResolvedPaymentMethod {
  readonly id: string;
  readonly code: string;
  readonly displayName: string;
  readonly rail: PaymentRail;
  readonly currencyCode: string;
  readonly verificationMode: VerificationMode;
  readonly minAmountMinor: bigint;
  readonly maxAmountMinor: bigint;
  readonly feeFixedMinor: bigint;
  readonly feeBps: number;
  readonly requiresReference: boolean;
  readonly isActive: boolean;
}

export interface ResolvedDestination {
  readonly id: string;
  readonly label: string;
  readonly accountIdentifier: string;
  readonly accountHolder: string | null;
  readonly notes: string | null;
}

export interface SubmissionCheckInput {
  readonly paymentMethodId: string;
  readonly destinationId: string | null;
  readonly amountMinor: bigint;
  readonly externalReference?: string | null;
  readonly senderAccount?: string | null;
  readonly proofCount: number;
  /**
   * 'CREATE' asks whether the intent may be opened; 'SUBMIT' asks whether the proof is complete.
   * OPTIONAL, and omitting it means 'SUBMIT' — the strict answer. See RailStage.
   */
  readonly stage?: RailStage;
}

export interface SubmissionIssue {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export type SubmissionCheck =
  { readonly ok: true } | { readonly ok: false; readonly issues: readonly SubmissionIssue[] };

export interface PaymentMethodPort {
  /** Active method by its stable code, or a 404/422. Never returns an inactive one. */
  getActiveByCode(code: string): Promise<ResolvedPaymentMethod>;

  getActiveById(id: string): Promise<ResolvedPaymentMethod>;

  /**
   * The destination this player should pay into: sticky for 24h, weighted rotation otherwise.
   * Throws 422 NO_DESTINATION_AVAILABLE when the method has none active.
   */
  pickDestination(paymentMethodId: string, playerId: string): Promise<ResolvedDestination>;

  /**
   * Rail-specific field checks. Pure; safe to call on a form preview.
   * `input.stage` picks the question; leaving it out asks the strict one.
   */
  checkSubmission(input: SubmissionCheckInput): Promise<SubmissionCheck>;

  /** Player-facing payment instructions, with the deposit shortId embedded as the reference. */
  renderInstructions(
    paymentMethodId: string,
    destinationId: string | null,
    amountMinor: bigint,
    shortId: string,
  ): Promise<string>;
}
