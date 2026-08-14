/**
 * WHY: the Ichancy API cannot be judged by its HTTP status. It answers 201 for "unauthorized",
 * 200 with `status:true, result:false` plus an error notification for real failures, and 422 for
 * business rejections. Worse, it has no idempotency key and no transaction-lookup endpoint, so a
 * timeout is genuinely UNKNOWN — the money may or may not have moved.
 *
 * Therefore every adapter call returns this three-way result instead of throwing:
 *   ok        -> the operation definitely happened
 *   rejected  -> the operation definitely did NOT happen (safe to fail the request, no ledger move)
 *   ambiguous -> we do not know; the caller MUST resolve it (balance-delta re-read, then at most
 *                one retry, then NEEDS_RECONCILIATION). Never blind-retry an ambiguous money call.
 *
 * TOKEN_EXPIRED is deliberately NOT part of this union: it is handled inside the adapter by a
 * single-flight refresh + one retry, and only its final outcome surfaces here.
 */

export type IchancyResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'rejected'; code: string; message: string }
  | { kind: 'ambiguous'; cause: string };

/** Stable, non-translated codes derived from the notification content the API returns. */
export const IchancyRejectionCodes = {
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  NO_WALLET: 'NO_WALLET',
  WRONG_ARGUMENTS: 'WRONG_ARGUMENTS',
  SUM_NOT_VALID: 'SUM_NOT_VALID',
  INSUFFICIENT_AGENT_FLOAT: 'INSUFFICIENT_AGENT_FLOAT',
  INSUFFICIENT_PLAYER_BALANCE: 'INSUFFICIENT_PLAYER_BALANCE',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNKNOWN: 'UNKNOWN',
} as const;

export type IchancyRejectionCode =
  (typeof IchancyRejectionCodes)[keyof typeof IchancyRejectionCodes];

export const ichancyOk = <T>(data: T): IchancyResult<T> => ({ kind: 'ok', data });

export const ichancyRejected = <T>(code: string, message: string): IchancyResult<T> => ({
  kind: 'rejected',
  code,
  message,
});

export const ichancyAmbiguous = <T>(cause: string): IchancyResult<T> => ({
  kind: 'ambiguous',
  cause,
});

export const isIchancyOk = <T>(r: IchancyResult<T>): r is { kind: 'ok'; data: T } =>
  r.kind === 'ok';

export const isIchancyRejected = <T>(
  r: IchancyResult<T>,
): r is { kind: 'rejected'; code: string; message: string } => r.kind === 'rejected';

export const isIchancyAmbiguous = <T>(
  r: IchancyResult<T>,
): r is { kind: 'ambiguous'; cause: string } => r.kind === 'ambiguous';
