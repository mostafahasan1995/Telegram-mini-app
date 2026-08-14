/**
 * WHY: this is the single place where an inbound HTTP request becomes an actor context. Everything
 * downstream (audit stamping, ichancy_calls.correlation_id, log correlation) reads from the store
 * instead of digging around in the request object.
 *
 * NOTE on the subscribe-inside-run dance below: Nest interceptors return an Observable that Nest
 * subscribes to LATER, outside our synchronous frame. Wrapping only `next.handle()` in
 * AsyncLocalStorage.run would therefore lose the context before the route handler ever runs. The
 * context has to be entered at SUBSCRIPTION time, which is what the explicit Observable does.
 */
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { uuidv7 } from 'uuidv7';

import { SYSTEM_ACTOR, adminActor, playerActor, type Actor } from '@common/types/actor.type';

import { createActorContext, runWithActorContextStore } from './actor-context.storage';

export const CORRELATION_ID_HEADER = 'x-correlation-id';
const REQUEST_ID_HEADER = 'x-request-id';
/** Anything longer or weirder than this is somebody else's header, not our correlation id. */
const SAFE_CORRELATION_ID = /^[\w.:-]{8,128}$/;

interface ActorBearingRequest extends Request {
  /** Preferred hand-off point: an auth guard that knows the identity sets this. */
  actor?: Actor;
  player?: { id?: unknown };
  admin?: { id?: unknown };
  user?: {
    type?: unknown;
    actorType?: unknown;
    id?: unknown;
    playerId?: unknown;
    adminUserId?: unknown;
  };
}

const asId = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/**
 * Tolerant on purpose: the auth module owns the request shape and may change it. The worst case
 * here is an anonymous SYSTEM actor on an audit row, never a failed request.
 */
export function resolveActor(request: ActorBearingRequest): Actor {
  const explicit = request.actor;
  if (
    explicit !== undefined &&
    (explicit.type === 'PLAYER' || explicit.type === 'ADMIN' || explicit.type === 'SYSTEM')
  ) {
    return explicit;
  }

  const playerId = asId(request.player?.id) ?? asId(request.user?.playerId);
  if (playerId !== null) return playerActor(playerId);

  const adminId = asId(request.admin?.id) ?? asId(request.user?.adminUserId);
  if (adminId !== null) return adminActor(adminId);

  const declaredType = request.user?.type ?? request.user?.actorType;
  const userId = asId(request.user?.id);
  if (userId !== null && declaredType === 'PLAYER') return playerActor(userId);
  if (userId !== null && declaredType === 'ADMIN') return adminActor(userId);

  return SYSTEM_ACTOR;
}

function headerValue(request: Request, name: string): string | undefined {
  const raw = request.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === 'string' ? raw : undefined;
}

/** Reuses an upstream correlation id when there is a sane one, so a trace survives the edge. */
export function resolveCorrelationId(request: Request): string {
  const candidate =
    headerValue(request, CORRELATION_ID_HEADER) ?? headerValue(request, REQUEST_ID_HEADER);
  return candidate !== undefined && SAFE_CORRELATION_ID.test(candidate) ? candidate : uuidv7();
}

@Injectable()
export class ActorContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler<unknown>): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<ActorBearingRequest>();
    const response = http.getResponse<Response>();

    const correlationId = resolveCorrelationId(request);
    const store = createActorContext({
      actor: resolveActor(request),
      correlationId,
      ip: request.ip ?? headerValue(request, 'x-forwarded-for') ?? request.socket.remoteAddress,
      userAgent: headerValue(request, 'user-agent') ?? null,
    });

    // Echoing it back is what makes a support ticket ("I got error X at 14:03") searchable.
    if (typeof response.setHeader === 'function') {
      response.setHeader(CORRELATION_ID_HEADER, correlationId);
    }

    return new Observable((subscriber) =>
      runWithActorContextStore(store, () => next.handle().subscribe(subscriber)),
    );
  }
}
