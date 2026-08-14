/**
 * WHY risk flags never reject anything: a duplicate-looking receipt is evidence, not a verdict. Two
 * brothers sharing a phone, a re-sent screenshot after a failed upload, and an actual fraud attempt
 * all produce the same signal. Auto-rejecting on it would deny real money to real players on a
 * heuristic; surfacing it on the admin card puts the decision where the accountability already is.
 *
 * SCHEMA-FORCED STORAGE (documented deviation): `deposit_requests` has no riskFlags column and the
 * schema is not this module's to change. Flags are therefore written to the `metadata.riskFlags` of
 * the DepositTransition that recorded the submission — an append-only row that already exists for
 * exactly this purpose — and mirrored into the audit trail and the outbox payload that draws the
 * admin card. `readRiskFlags()` in deposit-filter.util reads them back.
 */
export const RiskFlags = {
  /** The normalized bytes are byte-identical to a proof another player already submitted. */
  DUPLICATE_PROOF_EXACT: 'DUPLICATE_PROOF_EXACT',
  /** Perceptually the same picture (dHash within the threshold) as another player's proof. */
  DUPLICATE_PROOF_SIMILAR: 'DUPLICATE_PROOF_SIMILAR',
  /** Same image reused by THIS player on a different deposit. Weaker signal, still worth showing. */
  DUPLICATE_PROOF_SAME_PLAYER: 'DUPLICATE_PROOF_SAME_PLAYER',
  /** The player retyped a reference that another non-rejected deposit already claims. */
  REFERENCE_REUSED: 'REFERENCE_REUSED',
  /** Claim is at or above the dual-approval threshold. */
  LARGE_AMOUNT: 'LARGE_AMOUNT',
  /** First deposit from an account created in the last 24h. */
  NEW_PLAYER: 'NEW_PLAYER',
  /** Several submissions from this player inside a few minutes. */
  RAPID_RESUBMISSION: 'RAPID_RESUBMISSION',
  /** The image could not be decoded, so no duplicate check was possible. */
  PROOF_UNREADABLE: 'PROOF_UNREADABLE',
} as const;

export type RiskFlag = (typeof RiskFlags)[keyof typeof RiskFlags];

const ALL: readonly string[] = Object.values(RiskFlags);

export const isRiskFlag = (value: unknown): value is RiskFlag =>
  typeof value === 'string' && ALL.includes(value);

/** Severity for the admin card ordering: the two cross-player duplicates come first. */
export const RISK_FLAG_SEVERITY: Readonly<Record<RiskFlag, number>> = Object.freeze({
  [RiskFlags.DUPLICATE_PROOF_EXACT]: 5,
  [RiskFlags.DUPLICATE_PROOF_SIMILAR]: 4,
  [RiskFlags.REFERENCE_REUSED]: 4,
  [RiskFlags.DUPLICATE_PROOF_SAME_PLAYER]: 3,
  [RiskFlags.RAPID_RESUBMISSION]: 2,
  [RiskFlags.LARGE_AMOUNT]: 2,
  [RiskFlags.NEW_PLAYER]: 1,
  [RiskFlags.PROOF_UNREADABLE]: 1,
});
