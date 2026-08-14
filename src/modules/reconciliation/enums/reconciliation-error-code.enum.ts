/**
 * Domain codes for reconciliation. Same rules as everywhere else: SCREAMING_SNAKE, never renamed,
 * never carrying a value.
 */
export const ReconciliationErrorCodes = {
  BREAK_NOT_FOUND: 'BREAK_NOT_FOUND',
  BREAK_ALREADY_RESOLVED: 'BREAK_ALREADY_RESOLVED',
  /** A correction was requested for a break whose delta is zero — there is nothing to post. */
  NOTHING_TO_CORRECT: 'NOTHING_TO_CORRECT',
  /** The agent wallet could not be read, so no comparison was possible. */
  AGENT_WALLET_UNAVAILABLE: 'AGENT_WALLET_UNAVAILABLE',
  CORRECTION_NOT_ALLOWED: 'CORRECTION_NOT_ALLOWED',
} as const;

export type ReconciliationErrorCode =
  (typeof ReconciliationErrorCodes)[keyof typeof ReconciliationErrorCodes];
