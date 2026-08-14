/**
 * WHY the resolver is a plain function and not just an interceptor: Nest runs interceptors AFTER
 * guards. Our AuthGuard is global and fails closed, so the single most common error response (401)
 * would be produced BEFORE any interceptor ever ran — and would carry no correlation id, which is
 * exactly the response a user is most likely to screenshot.
 *
 * So `resolveCorrelationId` is called from three places, and is idempotent by design:
 *   1. pino's `genReqId` in @core/logging — that runs as middleware, i.e. before guards. Primary.
 *   2. this interceptor — covers apps that mount without the logging module.
 *   3. the global exception filter — last-resort fallback so no error is ever un-correlated.
 * Whoever gets there first mints the id and stamps the response header; the rest reuse it.
 */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { type Observable } from 'rxjs';
import { uuidv7 } from 'uuidv7';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/** Property stamped onto the request object; read it via `getCorrelationId(req)`. */
export const CORRELATION_ID_PROP = 'correlationId';

/**
 * An inbound id is only honoured if it looks like an id. Without this a caller could inject
 * newlines or 10KB of text straight into every log line for the request (log forging).
 */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._-]{8,128}$/;

interface MinimalRequest {
  headers?: Record<string, string | string[] | undefined>;
  correlationId?: string;
}

interface MinimalResponse {
  setHeader?: (name: string, value: string) => unknown;
  headersSent?: boolean;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function stampResponse(res: unknown, id: string): void {
  const response = res as MinimalResponse | null | undefined;
  if (!response || response.headersSent === true) return;
  response.setHeader?.(CORRELATION_ID_HEADER, id);
}

/**
 * Returns the request's correlation id, minting and attaching one if needed.
 * Safe to call with a raw node IncomingMessage, an express Request, or undefined.
 */
export function resolveCorrelationId(req: unknown, res?: unknown): string {
  const request = req as MinimalRequest | null | undefined;

  const existing = request?.correlationId;
  if (typeof existing === 'string' && existing.length > 0) {
    stampResponse(res, existing);
    return existing;
  }

  const incoming = firstHeader(request?.headers?.[CORRELATION_ID_HEADER]);
  const id = incoming !== undefined && SAFE_CORRELATION_ID.test(incoming) ? incoming : uuidv7();

  if (request) request.correlationId = id;
  stampResponse(res, id);
  return id;
}

/** Read-only accessor for code that must not mint an id (e.g. pure formatters). */
export function getCorrelationId(req: unknown): string | undefined {
  return (req as MinimalRequest | null | undefined)?.correlationId;
}

@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const http = context.switchToHttp();
      resolveCorrelationId(http.getRequest(), http.getResponse());
    }
    return next.handle();
  }
}
