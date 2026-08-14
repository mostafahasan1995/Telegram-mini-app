/**
 * WHY: "who did this?" must never be a parameter that someone forgets to pass down five layers.
 * An AsyncLocalStorage keeps the actor, the correlation id and the client IP attached to the async
 * call chain — the HTTP request, the BullMQ job, the cron tick — so the Prisma extension can stamp
 * audit columns and the logger can correlate lines without threading arguments through every call.
 *
 * It is a CONVENIENCE, never a source of truth for authorisation: a service that decides whether an
 * admin may approve a deposit still receives that admin explicitly.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { SYSTEM_ACTOR, type Actor } from '@common/types/actor.type';

export interface ActorContextStore {
  actor: Actor;
  /** Ties log lines, ichancy_calls rows and audit_logs rows of one logical operation together. */
  correlationId: string;
  /** Must be a real IP or null: audit_logs.ip is a Postgres INET column. */
  ip: string | null;
  userAgent: string | null;
}

const storage = new AsyncLocalStorage<ActorContextStore>();

export interface ActorContextInit {
  actor?: Actor;
  correlationId: string;
  ip?: string | null;
  userAgent?: string | null;
}

export function createActorContext(init: ActorContextInit): ActorContextStore {
  return {
    actor: init.actor ?? SYSTEM_ACTOR,
    correlationId: init.correlationId,
    ip: normalizeIp(init.ip),
    userAgent: init.userAgent ?? null,
  };
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { then?: unknown }).then === 'function';

/** Runs `fn` with its own context. Nested calls shadow, they never merge. */
export function runWithActorContext<T>(init: ActorContextInit, fn: () => T): T {
  return runWithActorContextStore(createActorContext(init), fn);
}

/**
 * Same, for a store that already exists (re-entering the context of an outer operation).
 *
 * WHY the `.then` below: a Prisma query object is LAZY — the query, and therefore the actor-stamp
 * extension, only starts when something calls `.then()`. `runWithActorContext(ctx, () =>
 * prisma.auditLog.create(...))` without an `await` would hand the unstarted query back to a caller
 * that awaits it AFTER the context has been exited, and the row would silently be stamped SYSTEM.
 * Touching `.then()` here starts the work while the context is still entered, which makes both
 * `() => prisma...` and `async () => await prisma...` behave identically.
 *
 * Side effect worth knowing: a returned PrismaPromise becomes a normal Promise, so it can no longer
 * be passed to the array form of `prisma.$transaction([...])`.
 */
export function runWithActorContextStore<T>(store: ActorContextStore, fn: () => T): T {
  return storage.run(store, () => {
    const result = fn();
    return isThenable(result) ? (result.then((value) => value) as T) : result;
  });
}

export function getActorContext(): ActorContextStore | undefined {
  return storage.getStore();
}

/** Defaults to SYSTEM: a cron tick or a queue processor has no request to inherit from. */
export function getCurrentActor(): Actor {
  return storage.getStore()?.actor ?? SYSTEM_ACTOR;
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/**
 * WHY this exists: the context is created before authentication finishes (interceptors run around
 * the handler, guards may resolve the player mid-flight), so the actor is upgraded in place once
 * the identity is known. Only the identity may be replaced — never the correlation id.
 */
export function setCurrentActor(actor: Actor): boolean {
  const store = storage.getStore();
  if (store === undefined) return false;
  store.actor = actor;
  return true;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

/**
 * Postgres INET rejects anything that is not an address, and an audit row that fails to insert
 * would take a money transaction down with it. Anything doubtful becomes null.
 */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const first = raw.split(',')[0]?.trim() ?? '';
  if (first === '') return null;
  // Express reports IPv4 clients as ::ffff:127.0.0.1 behind a dual-stack socket.
  const unmapped = first.startsWith('::ffff:') ? first.slice('::ffff:'.length) : first;
  if (IPV4.test(unmapped)) {
    return unmapped.split('.').every((octet) => Number(octet) <= 255) ? unmapped : null;
  }
  return IPV6.test(unmapped) && unmapped.includes(':') ? unmapped : null;
}
