/**
 * The contract every payment rail implements.
 *
 * WHY a driver per rail instead of `if (rail === 'CRYPTO')` inside the deposit service: the rails
 * differ in what a player must supply (a bank needs a transfer reference, a cash office needs the
 * agent's receipt number, crypto needs a tx hash), and those differences show up in three places —
 * validation, the instructions we print, and how a proof is later verified. Spread across the
 * deposit flow as conditionals, adding a rail means editing code that moves money. Behind this
 * interface, adding a rail is a new file.
 *
 * WHY `tryAutoVerify` exists in v1 even though every driver returns null: the alternative is that
 * the deposit flow has no place to put automation later, and the first rail that gains statement
 * ingestion has to re-open the credit path to add one. Returning null is the honest encoding of
 * "this rail is verified by a human" — and it is a value the caller must handle, not a silent
 * absence.
 *
 * IMPORTANT: `tryAutoVerify` returning a result is NOT permission to credit. It is evidence. The
 * deposit service still owns the decision, the ledger posting and the four-eyes rule.
 */
import type { PaymentRail, VerificationMode } from '@prisma/client';

/** What a player has to give us for this rail. Drives the mini-app form and the review checklist. */
export type RailProofField =
  /** The rail's own transaction id / receipt number. */
  | 'REFERENCE'
  /** The account, wallet number or address the money came FROM. */
  | 'SENDER_ACCOUNT'
  /** Name on the sending account, for rails where it is checkable. */
  | 'SENDER_NAME'
  /** A photo/screenshot of the receipt. */
  | 'RECEIPT_IMAGE'
  /** On-chain transaction hash. */
  | 'TX_HASH'
  /** Which chain the transfer was made on. */
  | 'NETWORK';

/**
 * WHICH QUESTION the driver is being asked. The two are not the same question, and collapsing them
 * into one is what made opening a deposit impossible: proof is uploaded AFTER the intent exists
 * (DRAFT -> AWAITING_PROOF -> SUBMITTED), so "attach a receipt" can never be satisfiable at create.
 *
 *   CREATE  — "may this player open a deposit intent for this amount on this rail?"
 *             Amount bounds, a destination, and the FORMAT of anything that was actually supplied.
 *             Absence of a proof field is not an issue yet.
 *   SUBMIT  — "is this proof complete?"  Everything CREATE checks, PLUS every proof field the
 *             shared driver can see (see the LIMIT below). This is the gate that stops a player
 *             claiming money arrived with no evidence, so it is never relaxed.
 *
 * LIMIT, stated honestly: `RailSubmission` carries a reference, a sender account and a proof count,
 * so those are the only entries of `requiredProofFields` any driver can enforce. `SENDER_NAME`,
 * `TX_HASH` and `NETWORK` are declared by rails to drive the mini-app form and the reviewer's
 * checklist, and are checked by the HUMAN who approves the deposit — nothing in this file validates
 * them, at either stage. That is pre-existing and unchanged by the staging split; closing it means
 * adding fields here and columns to carry them, not loosening anything below.
 *
 * WHY every optional occurrence defaults to 'SUBMIT': a caller that forgets to say which question
 * it is asking must get the STRICT answer. Failing open here would mean a forgotten argument
 * silently disables the evidence gate. Implementations must therefore test for the PERMISSIVE
 * stage (`stage === 'CREATE'`) and treat everything else as strict, so that a value smuggled past
 * the type system cannot turn the gate off.
 */
export type RailStage = 'CREATE' | 'SUBMIT';

/** The slice of a PaymentMethod row a driver is allowed to see. */
export interface RailMethodConfig {
  readonly code: string;
  readonly rail: PaymentRail;
  readonly displayName: string;
  readonly currencyCode: string;
  readonly verificationMode: VerificationMode;
  readonly minAmountMinor: bigint;
  readonly maxAmountMinor: bigint;
  readonly requiresReference: boolean;
  readonly referencePattern: string | null;
  readonly instructions: string | null;
}

/** Where the player is being told to pay. */
export interface RailDestinationInfo {
  readonly label: string;
  readonly accountIdentifier: string;
  readonly accountHolder: string | null;
  readonly notes: string | null;
}

export interface RailSubmission {
  readonly method: RailMethodConfig;
  /** Null when no destination was assigned (misconfiguration, or a rail that needs none). */
  readonly destination: RailDestinationInfo | null;
  /** What the player claims they sent, in minor units. Always positive. */
  readonly amountMinor: bigint;
  readonly externalReference?: string | null;
  readonly senderAccount?: string | null;
  /** How many proof files are attached. Zero is a valid state before upload. */
  readonly proofCount: number;
  /**
   * Which question to answer. OPTIONAL, and absence means 'SUBMIT' — see RailStage. Never default
   * this to 'CREATE' anywhere: the permissive stage must always be asked for explicitly.
   */
  readonly stage?: RailStage;
}

export interface RailValidationIssue {
  /** Field name as the mini-app knows it, so the error can be rendered inline. */
  readonly field: string;
  /** Stable code — never a translated message. */
  readonly code: string;
  readonly message: string;
}

export type RailValidation =
  { readonly ok: true } | { readonly ok: false; readonly issues: readonly RailValidationIssue[] };

/**
 * Evidence that a submission matches a real incoming payment.
 * Deliberately does NOT include a "credit it" flag — see the file header.
 */
export interface RailAutoVerification {
  readonly verifiedAmountMinor: bigint;
  readonly matchedReference: string;
  /** Whatever the source produced, for the audit row. Must be JSON-serializable. */
  readonly evidence: Record<string, unknown>;
}

export interface RailInstructionInput {
  readonly method: RailMethodConfig;
  readonly destination: RailDestinationInfo | null;
  readonly amountMinor: bigint;
  /**
   * The deposit's shortId. It goes in the payment reference AND is what we send Ichancy as the
   * comment, so a human can tie the two together in a back-office they do not control.
   */
  readonly shortId: string;
}

export interface RailDriver {
  /** One driver per PaymentRail. The registry keys on this. */
  readonly key: PaymentRail;

  /** What the player must supply. Order is the order the mini-app should render. */
  readonly requiredProofFields: readonly RailProofField[];

  /**
   * Pure and synchronous: no IO, so it can run on every keystroke in a form preview.
   * `submission.stage` selects which question is answered; omitting it answers the strict one.
   */
  validateSubmission(submission: RailSubmission): RailValidation;

  /**
   * Returns null for "a human must look at this" — which is every rail in v1.
   * A non-null result is evidence only; the deposit service still decides.
   */
  tryAutoVerify(submission: RailSubmission): Promise<RailAutoVerification | null>;

  /** Player-facing payment instructions. Plain text with minimal HTML, safe for Telegram. */
  renderInstructions(input: RailInstructionInput): string;
}

/** Stable validation codes shared by the drivers. */
export const RailIssueCodes = {
  AMOUNT_BELOW_MINIMUM: 'AMOUNT_BELOW_MINIMUM',
  AMOUNT_ABOVE_MAXIMUM: 'AMOUNT_ABOVE_MAXIMUM',
  AMOUNT_NOT_POSITIVE: 'AMOUNT_NOT_POSITIVE',
  REFERENCE_REQUIRED: 'REFERENCE_REQUIRED',
  REFERENCE_MALFORMED: 'REFERENCE_MALFORMED',
  SENDER_ACCOUNT_REQUIRED: 'SENDER_ACCOUNT_REQUIRED',
  /**
   * Supplied, but not a plausible account. Distinct from _REQUIRED on purpose: a client renders the
   * code, not the message, and "tell us which account you sent from" is the wrong thing to show
   * somebody who just told us.
   */
  SENDER_ACCOUNT_MALFORMED: 'SENDER_ACCOUNT_MALFORMED',
  PROOF_REQUIRED: 'PROOF_REQUIRED',
  DESTINATION_MISSING: 'DESTINATION_MISSING',
} as const;
