/**
 * WHY these three map to three different statuses: they ask the client for three different things.
 *  400 — you forgot the header; fix the request.
 *  409 — the same request is in progress; retry the identical call in a moment.
 *  422 — you reused a key for a different body; that is a bug, retrying will not help.
 * Collapsing them into one status would make an automatic client retry either useless or harmful.
 */
import { BusinessRuleError, ConflictError, ValidationError } from '@common/exceptions';

import { IDEMPOTENCY_HEADER, IdempotencyErrorCodes } from './idempotency.constants';

export class IdempotencyKeyRequiredError extends ValidationError {
  constructor(scope: string) {
    super(
      `This endpoint requires an ${IDEMPOTENCY_HEADER} header.`,
      { scope, header: IDEMPOTENCY_HEADER },
      IdempotencyErrorCodes.IDEMPOTENCY_KEY_REQUIRED,
    );
  }
}

export class IdempotencyKeyInvalidError extends ValidationError {
  constructor(scope: string, reason: string) {
    super(
      `The ${IDEMPOTENCY_HEADER} header is not acceptable.`,
      { scope, header: IDEMPOTENCY_HEADER, reason },
      IdempotencyErrorCodes.IDEMPOTENCY_KEY_INVALID,
    );
  }
}

export class IdempotencyInFlightError extends ConflictError {
  constructor(scope: string, since: Date) {
    super(
      IdempotencyErrorCodes.IDEMPOTENCY_IN_FLIGHT,
      'An identical request is still being processed. Retry the same request shortly.',
      { scope, since: since.toISOString() },
    );
  }
}

export class IdempotencyKeyReusedError extends BusinessRuleError {
  constructor(scope: string) {
    super(
      IdempotencyErrorCodes.IDEMPOTENCY_KEY_REUSED,
      'This idempotency key was already used for a different request body.',
      { scope },
    );
  }
}
