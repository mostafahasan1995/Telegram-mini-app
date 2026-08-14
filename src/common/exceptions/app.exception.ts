/**
 * WHY a bespoke hierarchy instead of Nest's HttpException: every error that reaches a client must
 * carry a STABLE machine code, and Nest's exceptions only carry a status and a free-text message.
 * Encoding the code in the message would make the contract un-refactorable. This base pairs the
 * three things a client needs — httpStatus, errorCode, message — and nothing else.
 *
 * These are deliberately NOT named *Exception like Nest's (NotFoundException, ...): a file that
 * imports both would otherwise pick the wrong one silently. `throw new NotFoundError(...)` is
 * unambiguous at a glance.
 *
 * Anything thrown here is considered SAFE TO SHOW to the caller. Never put a secret, a token, an
 * SQL fragment or an upstream stack trace into `message` or `details` — the filter forwards both
 * verbatim. Unexpected failures should just be thrown as ordinary Errors; the filter turns those
 * into an opaque INTERNAL_ERROR with a correlation id.
 */
import { CommonErrorCodes, type ErrorCode } from './error-codes';

export abstract class AppException extends Error {
  /** HTTP status the global filter will use. */
  readonly httpStatus: number;
  /** Stable, non-translated machine code. Part of the API contract. */
  readonly errorCode: ErrorCode;
  /** Structured, client-safe context (field errors, limits, ids). Serialized into the envelope. */
  readonly details?: unknown;

  protected constructor(
    httpStatus: number,
    errorCode: ErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    // Without this every subclass reports `Error` as its name in logs.
    this.name = new.target.name;
    this.httpStatus = httpStatus;
    this.errorCode = errorCode;
    this.details = details;
    // Drop the constructor frames so the stack points at the throw site.
    Error.captureStackTrace?.(this, new.target);
  }

  /** Shape used by the global filter and by structured logs. */
  toJSON(): { code: ErrorCode; message: string; details?: unknown } {
    return this.details === undefined
      ? { code: this.errorCode, message: this.message }
      : { code: this.errorCode, message: this.message, details: this.details };
  }
}

/** 401 — no credential, or a credential we cannot accept. */
export class UnauthorizedError extends AppException {
  constructor(
    errorCode: ErrorCode = CommonErrorCodes.UNAUTHENTICATED,
    message = 'Authentication is required.',
    details?: unknown,
  ) {
    super(401, errorCode, message, details);
  }
}

/** 403 — we know who you are; you may not do this. */
export class ForbiddenError extends AppException {
  constructor(
    errorCode: ErrorCode = CommonErrorCodes.FORBIDDEN,
    message = 'You are not allowed to perform this action.',
    details?: unknown,
  ) {
    super(403, errorCode, message, details);
  }
}

/** 404 — the addressed resource does not exist (or is not visible to this caller). */
export class NotFoundError extends AppException {
  constructor(
    errorCode: ErrorCode = CommonErrorCodes.RESOURCE_NOT_FOUND,
    message = 'The requested resource was not found.',
    details?: unknown,
  ) {
    super(404, errorCode, message, details);
  }
}

/** 409 — the request collides with current state (duplicate, stale version, lost race). */
export class ConflictError extends AppException {
  constructor(
    errorCode: ErrorCode = CommonErrorCodes.DUPLICATE_RESOURCE,
    message = 'The request conflicts with the current state of the resource.',
    details?: unknown,
  ) {
    super(409, errorCode, message, details);
  }
}

/** 400 — the request itself is malformed or fails field-level validation. */
export class ValidationError extends AppException {
  constructor(
    message = 'The request payload is invalid.',
    details?: unknown,
    errorCode: ErrorCode = CommonErrorCodes.VALIDATION_FAILED,
  ) {
    super(400, errorCode, message, details);
  }
}

/**
 * 422 — the payload is well-formed and the caller is allowed, but a DOMAIN rule says no.
 * "Deposit already credited", "amount exceeds your daily cap", "agent float cannot cover this".
 * Kept distinct from ValidationError so the mini-app can render it as a business message rather
 * than as a field error.
 */
export class BusinessRuleError extends AppException {
  constructor(
    errorCode: ErrorCode = CommonErrorCodes.BUSINESS_RULE_VIOLATION,
    message = 'This operation is not allowed in the current state.',
    details?: unknown,
  ) {
    super(422, errorCode, message, details);
  }
}

/** 503 — a dependency we need is unreachable. Retryable by the caller. */
export class ServiceUnavailableError extends AppException {
  constructor(
    errorCode: ErrorCode = CommonErrorCodes.SERVICE_UNAVAILABLE,
    message = 'The service is temporarily unavailable.',
    details?: unknown,
  ) {
    super(503, errorCode, message, details);
  }
}

/** Structural check that survives multiple copies of this module in node_modules. */
export function isAppException(value: unknown): value is AppException {
  return value instanceof AppException;
}
