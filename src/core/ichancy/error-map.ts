/**
 * WHY: Ichancy reports failure in four different places at once — the HTTP status (which lies: 201
 * means "unauthorized"), `status`, `result` and the `notification[]` array — and the ONLY reliable
 * signal is the human-readable English sentence inside `notification[].content`. This file is the
 * single translation table from that sentence to a stable code plus, more importantly, to one of
 * four operational outcomes.
 *
 * THE DEFAULT FOR AN UNRECOGNISED MESSAGE IS `ambiguous`, NOT `rejected`. This is deliberate and it
 * is the most important decision in the folder:
 *   - `rejected` tells the credit worker "the money definitely did not move", so it writes no ledger
 *     entry and lets an admin retry. If we guessed `rejected` for an error string that was actually
 *     emitted AFTER the balance changed, the retry pays the player twice. That loss is real, silent
 *     and unrecoverable.
 *   - `ambiguous` costs us a balance re-read and, at worst, a NEEDS_RECONCILIATION row a human looks
 *     at. That is a cheap, loud, recoverable failure.
 * Since Ichancy has no idempotency key and no transaction-lookup endpoint, "unknown" genuinely IS
 * unknown, and pretending otherwise is the only mistake we cannot undo.
 *
 * Adding a message here is how an outcome gets promoted from `ambiguous` to a definite `rejected` —
 * never by relaxing the default.
 */
import { IchancyRejectionCodes } from './ichancy.types';
import { firstErrorNotification, type IchancyEnvelope } from './ichancy.wire';

/**
 * `token_expired` is not a business outcome: it makes the adapter refresh once and replay the call.
 * `already_exists` is not a failure either: registerPlayer is effectively idempotent, so the caller
 * resolves the existing playerId instead of giving up.
 */
export type IchancyFailureOutcome = 'rejected' | 'ambiguous' | 'token_expired' | 'already_exists';

export const TOKEN_EXPIRED_CODE = 'TOKEN_EXPIRED';

/**
 * The spec text calls the agent-float code AGENT_FLOAT_INSUFFICIENT while the shared contract in
 * ichancy.types.ts calls it INSUFFICIENT_AGENT_FLOAT. The shared contract wins (other modules
 * compare against IchancyRejectionCodes); this alias exists so both spellings resolve to one value.
 */
export const AGENT_FLOAT_INSUFFICIENT = IchancyRejectionCodes.INSUFFICIENT_AGENT_FLOAT;

export interface IchancyErrorClassification {
  readonly outcome: IchancyFailureOutcome;
  /** Stable, non-translated code — goes to ichancy_calls.error_code. */
  readonly code: string;
  /** The raw notification content, kept verbatim for forensics. */
  readonly message: string;
  /** Which rule matched, or null when nothing did (i.e. the safe default fired). */
  readonly rule: string | null;
}

export type IchancyClassification = { readonly outcome: 'ok' } | IchancyErrorClassification;

export const OK_CLASSIFICATION: IchancyClassification = Object.freeze({ outcome: 'ok' as const });

interface ErrorRule {
  readonly id: string;
  readonly test: RegExp;
  readonly outcome: IchancyFailureOutcome;
  readonly code: string;
}

/**
 * Order matters. Auth rules run first (a token problem must never be mistaken for a business
 * rejection), and the two "amount is greater than ..." messages are distinguished by their tails:
 * "in Total Available(FROM)" is OUR agent float, "account balance" is the PLAYER's balance.
 */
export const ICHANCY_ERROR_RULES: readonly ErrorRule[] = Object.freeze([
  // ---- auth / session -----------------------------------------------------------------
  {
    id: 'REFRESH_TOKEN_DEAD',
    test: /invalid or expired refresh token/,
    outcome: 'token_expired',
    code: TOKEN_EXPIRED_CODE,
  },
  {
    id: 'ACCESS_TOKEN_DEAD',
    test: /invalid access(?: token)?|expired access token|token (?:is )?expired/,
    outcome: 'token_expired',
    code: TOKEN_EXPIRED_CODE,
  },
  {
    id: 'UNAUTHORIZED',
    test: /unauthori[sz]/,
    outcome: 'token_expired',
    code: TOKEN_EXPIRED_CODE,
  },
  {
    // Signing in with the wrong password is a hard stop, NOT something a refresh can fix.
    id: 'INVALID_CREDENTIALS',
    test: /invalid username or password/,
    outcome: 'rejected',
    code: IchancyRejectionCodes.INVALID_CREDENTIALS,
  },

  // ---- registration -------------------------------------------------------------------
  {
    id: 'DUPLICATE_PLAYER',
    test: /duplicate (?:login|email|username)/,
    outcome: 'already_exists',
    code: IchancyRejectionCodes.ALREADY_EXISTS,
  },
  {
    id: 'MISSING_PROPERTY',
    test: /property is required/,
    outcome: 'rejected',
    code: IchancyRejectionCodes.VALIDATION_FAILED,
  },
  {
    id: 'PASSWORD_TOO_SHORT',
    test: /password should contain at least \d+ characters/,
    outcome: 'rejected',
    code: IchancyRejectionCodes.VALIDATION_FAILED,
  },

  // ---- money --------------------------------------------------------------------------
  {
    // Their message names whatever currency the wallet was created in (the docs show "AMD" even on
    // an NSP agent), so the currency code is matched loosely.
    id: 'NO_WALLET',
    test: /(?:you|user|agent)?\s*(?:don'?t|do not|does not|doesn'?t) have (?:an? )?[a-z]{3} wallet/,
    outcome: 'rejected',
    code: IchancyRejectionCodes.NO_WALLET,
  },
  {
    id: 'AGENT_FLOAT_INSUFFICIENT',
    test: /amount is greater than you have in total available/,
    outcome: 'rejected',
    code: IchancyRejectionCodes.INSUFFICIENT_AGENT_FLOAT,
  },
  {
    id: 'PLAYER_BALANCE_INSUFFICIENT',
    test: /amount is greater than account balance/,
    outcome: 'rejected',
    code: IchancyRejectionCodes.INSUFFICIENT_PLAYER_BALANCE,
  },
  {
    id: 'USER_BALANCE_INSUFFICIENT',
    test: /(?:user|player) does not have sufficient balance/,
    outcome: 'rejected',
    code: IchancyRejectionCodes.INSUFFICIENT_PLAYER_BALANCE,
  },
  {
    id: 'SUM_NOT_VALID',
    test: /sum is not valid/,
    outcome: 'rejected',
    code: IchancyRejectionCodes.SUM_NOT_VALID,
  },
  {
    id: 'WRONG_ARGUMENTS',
    test: /wrong arguments/,
    outcome: 'rejected',
    code: IchancyRejectionCodes.WRONG_ARGUMENTS,
  },
]);

/**
 * Lowercase, collapse whitespace, unify the typographic apostrophe ("don’t" vs "don't") and drop a
 * trailing period, so the table matches whether or not they punctuate a given release.
 */
export function normalizeNotificationContent(content: string): string {
  return content
    .normalize('NFKC')
    .replace(/[‘’ʼ´`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '')
    .toLowerCase();
}

/** Map one notification sentence to an outcome. Unrecognised => ambiguous (see file header). */
export function classifyErrorContent(content: string): IchancyErrorClassification {
  const normalized = normalizeNotificationContent(content);
  for (const rule of ICHANCY_ERROR_RULES) {
    if (rule.test.test(normalized)) {
      return { outcome: rule.outcome, code: rule.code, message: content, rule: rule.id };
    }
  }
  return {
    outcome: 'ambiguous',
    code: IchancyRejectionCodes.UNKNOWN,
    message: content,
    rule: null,
  };
}

/**
 * 401/403 are unambiguous: the request was refused at the door, nothing executed.
 * 201 is Ichancy's documented "UNAUTHORIZED" status — see classifyEnvelope for the guard that keeps
 * a genuinely successful 201 from triggering a replay.
 */
export function isUnauthorizedHttpStatus(status: number): boolean {
  return status === 401 || status === 403;
}

function ambiguous(code: string, message: string, rule: string | null): IchancyErrorClassification {
  return { outcome: 'ambiguous', code, message, rule };
}

function tokenExpired(message: string, rule: string): IchancyErrorClassification {
  return { outcome: 'token_expired', code: TOKEN_EXPIRED_CODE, message, rule };
}

/**
 * The full success/failure decision for one response.
 *
 * Evaluation order (each step exists because of a documented Ichancy behaviour):
 *  1. An error notification wins over everything — it is the only place the real reason lives, and
 *     it is how a 201 "Invalid username or password." stays INVALID_CREDENTIALS instead of becoming
 *     a pointless token refresh.
 *  2. 401/403 => token_expired.
 *  3. 201 => token_expired, BUT ONLY IF the envelope does not look successful. Blindly replaying
 *     every 201 would re-send money calls that had already succeeded; the documented 201 failures
 *     all carry `result:false`/`result:[]` plus a notification, so this guard loses nothing.
 *  4. `status:false` or `result:false` with no explanation => ambiguous, never rejected.
 *  5. Any non-2xx / 5xx we did not recognise => ambiguous.
 */
export function classifyEnvelope(
  httpStatus: number,
  envelope: IchancyEnvelope | null,
): IchancyClassification {
  const note = firstErrorNotification(envelope);
  if (note) {
    if (note.content && note.content.trim().length > 0) return classifyErrorContent(note.content);
    return ambiguous(
      IchancyRejectionCodes.UNKNOWN,
      `Error notification without content (HTTP ${String(httpStatus)})`,
      null,
    );
  }

  if (isUnauthorizedHttpStatus(httpStatus)) {
    return tokenExpired(`HTTP ${String(httpStatus)}`, 'HTTP_UNAUTHORIZED');
  }

  if (!envelope) {
    return ambiguous(
      IchancyRejectionCodes.UNKNOWN,
      `Unparseable response body (HTTP ${String(httpStatus)})`,
      null,
    );
  }

  const looksFailed = envelope.status === false || envelope.result === false;

  if (httpStatus === 201 && looksFailed) {
    return tokenExpired('HTTP 201 (Ichancy returns 201 for UNAUTHORIZED)', 'HTTP_201_UNAUTHORIZED');
  }

  if (looksFailed) {
    const detail =
      envelope.html && envelope.html.length > 0 ? envelope.html : 'status/result false';
    return ambiguous(
      IchancyRejectionCodes.UNKNOWN,
      `Unexplained failure (HTTP ${String(httpStatus)}): ${detail}`,
      null,
    );
  }

  if (httpStatus < 200 || httpStatus > 299) {
    return ambiguous(
      IchancyRejectionCodes.UNKNOWN,
      `Unexpected HTTP ${String(httpStatus)} with no error notification`,
      null,
    );
  }

  return OK_CLASSIFICATION;
}

/**
 * AbortSignal.timeout() rejects with a DOMException named TimeoutError; a manual abort gives
 * AbortError. Both mean "we stopped listening", not "it did not happen".
 */
export function isTimeoutError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return name === 'TimeoutError' || name === 'AbortError';
}

/** A timeout or a socket error: we never learned whether the far side executed the call. */
export function classifyTransportFailure(error: unknown): IchancyErrorClassification {
  const message = error instanceof Error ? error.message : String(error);
  const timedOut = isTimeoutError(error);
  return ambiguous(
    IchancyRejectionCodes.UNKNOWN,
    timedOut ? `Request timed out: ${message}` : `Transport failure: ${message}`,
    timedOut ? 'TIMEOUT' : 'TRANSPORT_ERROR',
  );
}
