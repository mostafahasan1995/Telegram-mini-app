/**
 * CROSS-MODULE CONTRACTS THE DEPOSIT SPINE CONSUMES.
 *
 * `eslint-plugin-boundaries` forbids modules/A -> modules/B, and it is right to: a deposit handler
 * reaching into another feature's internals is exactly the coupling this project exists to prevent.
 * But the deposit flow genuinely needs three things that other modules own — the Ichancy player
 * mirror, the payment-method/destination rules, and an admin's approval authority.
 *
 * The owning modules publish each of them behind a PLAIN STRING TOKEN precisely so no import is
 * needed. This file restates the interfaces STRUCTURALLY, which is the mechanism their authors
 * documented (see src/modules/player/player-link.port.ts). The binding is made in the root module,
 * which is allowed to see everything.
 *
 * THESE DECLARATIONS MUST STAY STRUCTURALLY IDENTICAL to their originals:
 *   PLAYER_LINK_PORT     src/modules/player/player-link.port.ts
 *   PAYMENT_METHOD_PORT  src/modules/payment-method/payment-method.port.ts
 *   APPROVAL_LIMIT_PORT  src/modules/admin/approval-limit.port.ts
 *
 * A drift is caught at the composition root: Nest injects the real implementation, and any shape
 * mismatch shows up the first time it is called. `src/modules/modules.int.spec.ts` boots the graph
 * for exactly this reason.
 *
 * PROPER FIX (whoever owns src/core): promote all three into `src/core/*` next to ICHANCY_PORT, and
 * this file becomes three re-exports.
 */
import type { AdminRole, PaymentRail, VerificationMode } from '@prisma/client';

import type { Tx } from '@core/prisma/tx.type';

// ── player ──────────────────────────────────────────────────────────────────────────────────────

export const PLAYER_LINK_PORT = 'PLAYER_LINK_PORT';

export interface LinkedIchancyAccount {
  readonly playerId: string;
  readonly ichancyPlayerId: string;
  readonly ichancyLogin: string;
  /** True only when THIS call created the mirror. */
  readonly created: boolean;
}

export interface PlayerLinkPort {
  /**
   * Idempotent. Either returns a fully linked account or throws:
   *  422 ICHANCY_LINK_REJECTED   — definitive refusal; do not retry unchanged.
   *  503 ICHANCY_LINK_AMBIGUOUS  — unknown; retryable (the login is deterministic, so a retry is a
   *                                lookup rather than a second registration).
   *  409 ICHANCY_LINK_IN_PROGRESS— another call holds the per-player lock; retryable.
   */
  ensureLinked(playerId: string, correlationId?: string | null): Promise<LinkedIchancyAccount>;
}

// ── payment methods ─────────────────────────────────────────────────────────────────────────────

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

/**
 * Structural restatement of the payment module's RailStage (src/modules/payment-method/rails/
 * rail.interface.ts). Two stages, because the rules for "may this intent be opened?" and "is this
 * proof complete?" are different rules:
 *
 *   CREATE — amount bounds, a destination, and the FORMAT of whatever was supplied.
 *   SUBMIT — all of the above PLUS every proof field the rail can check (reference, sender account,
 *            receipt image; SENDER_NAME/TX_HASH/NETWORK are for the human reviewer — see the LIMIT
 *            note on the original).
 *
 * Fail closed: only a literal 'CREATE' selects the permissive question. Omitting the stage — or
 * sending anything else — gets SUBMIT.
 */
export type RailStage = 'CREATE' | 'SUBMIT';

export interface SubmissionCheckInput {
  readonly paymentMethodId: string;
  readonly destinationId: string | null;
  readonly amountMinor: bigint;
  readonly externalReference?: string | null;
  readonly senderAccount?: string | null;
  readonly proofCount: number;
  /** Omitting this asks the STRICT question. See RailStage. */
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
  getActiveByCode(code: string): Promise<ResolvedPaymentMethod>;
  getActiveById(id: string): Promise<ResolvedPaymentMethod>;
  /** Sticky per player for 24h, weighted rotation otherwise. Throws when none is active. */
  pickDestination(paymentMethodId: string, playerId: string): Promise<ResolvedDestination>;
  /** Rail-specific field checks, including the amount bounds and the reference pattern. */
  checkSubmission(input: SubmissionCheckInput): Promise<SubmissionCheck>;
  renderInstructions(
    paymentMethodId: string,
    destinationId: string | null,
    amountMinor: bigint,
    shortId: string,
  ): Promise<string>;
}

// ── admin approval authority ────────────────────────────────────────────────────────────────────

export const APPROVAL_LIMIT_PORT = 'APPROVAL_LIMIT_PORT';

export type ApprovalDecisionValue = 'ALLOWED' | 'NEEDS_SECOND' | 'DENIED';

export interface ApprovalLimitPort {
  /**
   * `tx` is FIRST and mandatory: the ceiling must be evaluated against the same snapshot as the
   * approval it authorizes, or two concurrent approvals can both pass one daily budget.
   */
  evaluate(
    tx: Tx,
    admin: { readonly adminUserId: string; readonly role: AdminRole },
    amountMinor: bigint,
    currencyCode: string,
  ): Promise<ApprovalDecisionValue>;
}
