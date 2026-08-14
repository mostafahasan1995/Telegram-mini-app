/**
 * WHY one envelope for every response: the mini-app has a single fetch wrapper. If some endpoints
 * returned a bare object and others a wrapper, that wrapper would need per-endpoint knowledge and
 * error handling would drift. `success` is the only branch a client needs; `error` is null on
 * success and `data` is null on failure — never both populated.
 *
 * `meta.correlationId` is echoed on EVERY response (success included) so a user can screenshot a
 * failure and support can find the exact request in the logs.
 */
export interface ApiErrorBody {
  /** Stable SCREAMING_SNAKE code — see @common/exceptions/error-codes. */
  code: string;
  message: string;
  /** Client-safe structured context (field errors, limits). Omitted when there is none. */
  details?: unknown;
}

export interface ApiResponseMeta {
  correlationId: string;
  /** ISO-8601 UTC. */
  timestamp: string;
  [key: string]: unknown;
}

export interface ApiEnvelope<T> {
  success: boolean;
  data: T | null;
  error: ApiErrorBody | null;
  meta: ApiResponseMeta;
}

/** True when a handler already produced an envelope, so the interceptor must not wrap it twice. */
export function isApiEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.success === 'boolean' && 'data' in candidate && 'error' in candidate;
}
