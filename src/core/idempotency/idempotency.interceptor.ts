/**
 * WHY an interceptor rather than a guard: a guard can only say yes/no, and two of the four outcomes
 * here need to REPLACE the response (replay) or to run cleanup AFTER the handler (complete/release).
 * Only an interceptor sees both sides of the call.
 *
 * The request is typed structurally instead of importing express' Request: core has no business
 * knowing which HTTP adapter is mounted, and the four fields we read are the same under Fastify.
 *
 * Ordering note: route-scoped interceptors run INSIDE global ones, so what gets cached here is the
 * raw handler return value, before any global response envelope. A replay therefore goes back
 * through the same envelope and the client cannot tell the two apart — which is the point.
 */
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, of, throwError, type Observable } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';

import {
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENCY_REPLAY_HEADER,
  IDEMPOTENT_METADATA,
} from './idempotency.constants';
import {
  IdempotencyInFlightError,
  IdempotencyKeyInvalidError,
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedError,
} from './idempotency.errors';
import { IdempotencyService } from './idempotency.service';
import type { IdempotencyBeginResult, IdempotentOptions } from './idempotency.types';

interface IdempotentHttpRequest {
  method?: string;
  url?: string;
  originalUrl?: string;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
}

interface IdempotentHttpResponse {
  setHeader?: (name: string, value: string) => void;
}

function readHeader(request: IdempotentHttpRequest, name: string): string | null {
  const raw = request.headers?.[name];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw[0] ?? null;
  return null;
}

/**
 * Best-effort pointer from a key to the thing it created, so an operator looking at a stuck record
 * can jump straight to the deposit. Never load-bearing.
 */
function extractResultRef(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null;
  const record = result as Record<string, unknown>;
  if (typeof record.id === 'string') return record.id;
  const data = record.data;
  if (typeof data === 'object' && data !== null) {
    const nested = (data as Record<string, unknown>).id;
    if (typeof nested === 'string') return nested;
  }
  return null;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly idempotency: IdempotencyService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.getAllAndOverride<IdempotentOptions | undefined>(
      IDEMPOTENT_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (options === undefined || context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<IdempotentHttpRequest>();

    const rawKey = readHeader(request, IDEMPOTENCY_HEADER);
    if (rawKey === null) {
      if (!options.required) return next.handle();
      throw new IdempotencyKeyRequiredError(options.scope);
    }

    const key = rawKey.trim();
    if (key.length < IDEMPOTENCY_KEY_MIN_LENGTH || key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
      throw new IdempotencyKeyInvalidError(
        options.scope,
        `length must be between ${IDEMPOTENCY_KEY_MIN_LENGTH} and ${IDEMPOTENCY_KEY_MAX_LENGTH}`,
      );
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw new IdempotencyKeyInvalidError(options.scope, 'unsupported characters');
    }

    // Method and path are part of the identity: the same key sent to a different endpoint is a
    // different request, and replaying one endpoint's answer on another would be nonsense.
    const requestHash = this.idempotency.hashRequest({
      method: request.method ?? '',
      path: request.originalUrl ?? request.url ?? '',
      body: request.body ?? null,
    });

    return from(
      this.idempotency.begin({
        scope: options.scope,
        key,
        requestHash,
        ttlSeconds: options.ttlSeconds,
      }),
    ).pipe(
      switchMap((begun: IdempotencyBeginResult) => {
        switch (begun.kind) {
          case 'mismatch':
            return throwError(() => new IdempotencyKeyReusedError(options.scope));
          case 'in_flight':
            return throwError(() => new IdempotencyInFlightError(options.scope, begun.since));
          case 'replay': {
            const response = http.getResponse<IdempotentHttpResponse>();
            response.setHeader?.(IDEMPOTENCY_REPLAY_HEADER, 'true');
            return of(begun.response);
          }
          case 'proceed':
            return next.handle().pipe(
              switchMap(async (result: unknown) => {
                await this.idempotency.complete(begun.lease, {
                  response: result,
                  resultRef: extractResultRef(result),
                });
                return result;
              }),
              // A failure must leave no trace, so the identical request can be retried with the
              // identical key. Releasing is best-effort: if it fails, the stale-lock window is the
              // backstop and the original error still reaches the client.
              catchError((error: unknown) =>
                from(this.idempotency.release(begun.lease, 'handler failed')).pipe(
                  catchError(() => of(false)),
                  switchMap(() => throwError(() => error)),
                ),
              ),
            );
          default:
            return next.handle();
        }
      }),
    );
  }
}
