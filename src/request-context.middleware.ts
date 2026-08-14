/**
 * COMPOSITION-LAYER BRIDGE. This file exists because two independently-built edges of the system
 * describe the same request in two different vocabularies, and nothing in either of them fails when
 * they disagree — the system just quietly loses information. Both problems are fixed here, in the
 * one place that is allowed to know about both sides.
 *
 * ---------------------------------------------------------------------------------------------
 * PROBLEM 1 — every audit row would have said SYSTEM.
 *
 *   @core/auth's AuthGuard attaches   req.player = { playerId, telegramUserId, sessionId }
 *                                     req.admin  = { adminUserId, telegramUserId, role, ... }
 *   @core/actor-context's resolveActor looks for  req.actor, req.player.id, req.admin.id,
 *                                                 req.user.playerId, req.user.adminUserId
 *
 * `playerId` is not `id`, and `req.user` is never set — so resolveActor fell through to
 * SYSTEM_ACTOR on EVERY authenticated request. Since the Prisma actor-stamp extension reads that
 * context, every audit_log, deposit_transition and ledger_transaction written on behalf of a real
 * person would have been attributed to the system. For a cashier whose four-eyes approval rule is
 * the control that stops one admin paying themselves, "who did this" is not a nice-to-have.
 *
 * It is fixed with a lazily-evaluated `actor` property rather than a guard or an interceptor,
 * because ordering is the trap here: the principal does not exist until AuthGuard has run, and the
 * relative order of two global guards depends on Nest's module-scan order, which is not a contract.
 * A getter is read at the moment resolveActor asks — by then AuthGuard has definitely run, whatever
 * order anything was registered in. Assignment still works (`req.actor = x` wins), so the day
 * @core/auth sets it directly this bridge becomes a no-op instead of a conflict.
 *
 * ---------------------------------------------------------------------------------------------
 * PROBLEM 2 — logs and audit rows would have carried DIFFERENT correlation ids.
 *
 * Three components mint a correlation id, and two of them use different resolvers:
 *   @common/interceptors/correlation-id  reads req.correlationId, then the x-correlation-id header
 *   @core/actor-context/…interceptor     reads ONLY the x-correlation-id / x-request-id headers
 *
 * When a client sends no header (i.e. always, from the mini-app), pino mints id A onto
 * `req.correlationId` for the logs while the actor context independently mints id B for every
 * audit row and ichancy_calls entry. Support then has a log line and a money record that cannot be
 * joined — the exact thing a correlation id exists to prevent.
 *
 * Running FIRST and writing the resolved id back into the request HEADERS makes every downstream
 * resolver agree, because the header is the one input all of them read.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY express middleware and not a Nest middleware class: this must run before pino-http, which
 * nestjs-pino installs through the module system. `app.use()` in main.ts registers on the express
 * instance before `app.init()` wires Nest's own middleware, so this is genuinely first.
 */
import { adminActor, playerActor, type Actor } from '@common/types/actor.type';
import {
  CORRELATION_ID_HEADER,
  resolveCorrelationId,
} from '@common/interceptors/correlation-id.interceptor';
import { REQUEST_ADMIN_KEY, REQUEST_PLAYER_KEY } from '@common/decorators/auth.types';

/** Structural, not imported: this middleware must not care which framework shipped the request. */
interface PrincipalBearingRequest {
  headers: Record<string, string | string[] | undefined>;
  [REQUEST_PLAYER_KEY]?: { playerId?: unknown };
  [REQUEST_ADMIN_KEY]?: { adminUserId?: unknown };
  actor?: Actor;
}

type NextFunction = (error?: unknown) => void;

const asId = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/**
 * Translate whatever AuthGuard attached into the shared Actor vocabulary.
 * Returns undefined for an anonymous request so resolveActor falls through to SYSTEM_ACTOR — an
 * unauthenticated caller is not an actor, and inventing one would be worse than admitting it.
 */
export function actorFromPrincipals(request: PrincipalBearingRequest): Actor | undefined {
  const playerId = asId(request[REQUEST_PLAYER_KEY]?.playerId);
  if (playerId !== null) return playerActor(playerId);

  const adminUserId = asId(request[REQUEST_ADMIN_KEY]?.adminUserId);
  if (adminUserId !== null) return adminActor(adminUserId);

  return undefined;
}

/**
 * Installs the lazy `actor` getter and pins the correlation id into the request headers.
 * Idempotent: a request that somehow passes through twice keeps its first id and its first getter.
 */
export function requestContextMiddleware(
  request: unknown,
  response: unknown,
  next: NextFunction,
): void {
  const req = request as PrincipalBearingRequest | null | undefined;
  if (!req || typeof req !== 'object') {
    next();
    return;
  }

  // Mints (or reuses) the id, stamps req.correlationId and the response header.
  const correlationId = resolveCorrelationId(req, response);

  // The line that makes the actor context agree with the logger. Header names are lowercase on an
  // inbound node request, so this is the exact key every resolver reads.
  if (req.headers !== undefined && req.headers[CORRELATION_ID_HEADER] === undefined) {
    req.headers[CORRELATION_ID_HEADER] = correlationId;
  }

  if (!Object.prototype.hasOwnProperty.call(req, 'actor')) {
    let explicit: Actor | undefined;
    Object.defineProperty(req, 'actor', {
      configurable: true,
      enumerable: false,
      get: (): Actor | undefined => explicit ?? actorFromPrincipals(req),
      set: (value: Actor | undefined): void => {
        explicit = value;
      },
    });
  }

  next();
}
