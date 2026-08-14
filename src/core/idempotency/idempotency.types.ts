/**
 * WHY a lease with a fence: `complete()` must not be able to write a response for a record that was
 * taken away from it. When a stale IN_FLIGHT record is stolen, the thief moves `lockedAt`; the
 * original owner's lease still carries the old value, so its UPDATE matches zero rows and is
 * ignored instead of publishing a response for a request nobody is waiting on any more.
 */
import type { JsonValue } from '@core/queue/json.util';

export interface IdempotencyBeginInput {
  /** Namespace, e.g. "deposit.create". The same client key may legitimately exist per scope. */
  scope: string;
  key: string;
  /** Digest of the request body. A repeat with a different body is a client bug, not a replay. */
  requestHash: string;
  ttlSeconds?: number;
}

export interface IdempotencyLease {
  recordId: string;
  scope: string;
  key: string;
  /** The `lockedAt` value we own. Any later write must present it unchanged. */
  fencedAt: Date;
}

export type IdempotencyBeginResult =
  /** Nobody has run this yet (or the previous owner died). Run the handler. */
  | { kind: 'proceed'; lease: IdempotencyLease; recoveredFrom?: Date }
  /** Already finished: answer with the stored response, do not run anything. */
  | {
      kind: 'replay';
      response: JsonValue | null;
      resultRef: string | null;
      completedAt: Date | null;
    }
  /** Somebody is running it right now. 409 — the client must retry, not duplicate. */
  | { kind: 'in_flight'; since: Date }
  /** Same key, different body. 422 — replaying the old answer would be a lie. */
  | { kind: 'mismatch' };

export interface IdempotencyCompleteInput {
  /** Serialized as JSON exactly as the client would have received it. */
  response: unknown;
  /** Id of whatever was created, so an operator can jump from a key to the deposit. */
  resultRef?: string | null;
}

/** Metadata attached by @Idempotent and read by the interceptor. */
export interface IdempotentOptions {
  scope: string;
  /** When false, a request without the header simply runs unprotected. Default: true. */
  required: boolean;
  ttlSeconds: number;
}
