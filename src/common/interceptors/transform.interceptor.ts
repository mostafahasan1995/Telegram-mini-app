/**
 * WHY wrap here rather than in every controller: the envelope is a contract, and contracts that
 * depend on 40 controllers remembering to apply them are not contracts. This is the success half of
 * the pair; the failure half lives in @common/filters/global-exception.filter, and BOTH must emit
 * the identical `{ success, data, error, meta }` shape or the mini-app's fetch wrapper breaks.
 *
 * Three passthrough cases, all deliberate:
 *  - non-HTTP contexts (BullMQ processors, the CLI) have no envelope.
 *  - a handler that already returned an envelope is left alone (health checks, proxied payloads).
 *  - `undefined` from a 204 handler stays a 204 with a null data field rather than becoming `{}`.
 */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import { type ApiEnvelope, type ApiResponseMeta, isApiEnvelope } from '../dtos/api-response.dto';
import { CursorResult, PaginatedResult } from '../dtos/paginated.dto';
import { resolveCorrelationId } from './correlation-id.interceptor';

@Injectable()
export class TransformInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const correlationId = resolveCorrelationId(http.getRequest(), http.getResponse());

    return next.handle().pipe(
      map((payload: unknown): unknown => {
        if (isApiEnvelope(payload)) return payload;

        const meta: ApiResponseMeta = {
          correlationId,
          timestamp: new Date().toISOString(),
        };

        // A page result carries its own meta; merge it rather than nesting it under `data`,
        // so clients read `meta.total` and never `data.meta.total`.
        if (payload instanceof PaginatedResult || payload instanceof CursorResult) {
          const envelope: ApiEnvelope<unknown> = {
            success: true,
            data: payload.data,
            error: null,
            meta: { ...meta, ...payload.meta },
          };
          return envelope;
        }

        const envelope: ApiEnvelope<unknown> = {
          success: true,
          data: payload === undefined ? null : payload,
          error: null,
          meta,
        };
        return envelope;
      }),
    );
  }
}
