/**
 * WHY: "which operator is this?" must never be a parameter someone forgets to pass down five
 * layers. Every tenant-scoped query reads the answer from here, the same way audit stamping reads
 * the actor from ActorContextStorage.
 *
 * ══ HOME vs EFFECTIVE — the whole point of this file ═════════════════════════════════════════
 * These are deliberately two different things and must never be collapsed into one:
 *
 *   HOME      who you ARE. The `tid` claim, signed into the access token at sign-in, taken from
 *             the tenant your `admin_users` row lives in. No header can move it. Authority is
 *             measured here — AdminIdentityService resolves (homeTenantId, adminUserId).
 *
 *   EFFECTIVE whose data you are READING. Defaults to home. A PLATFORM_ADMIN whose row is in
 *             tenant zero may point it at another operator for one request with X-Tenant-Id.
 *
 * Collapsing them breaks in one of two directions, both bad: resolve identity in the tenant the
 * CLIENT picked and you have an authentication bypass wearing a header; refuse the split entirely
 * and a platform admin is blind, because their own operator holds no players.
 *
 * Like ActorContextStorage this is a CONVENIENCE, never a source of truth for authorisation. A
 * service deciding whether someone may act on a row still receives the principal explicitly.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { TENANT_ZERO_ID } from './tenant.constants';

export interface TenantContextStore {
  /** The `tid` claim. Immovable for the life of the request. */
  readonly homeTenantId: string;
  /** Whose data this request reads. Starts equal to home; only the override interceptor moves it. */
  effectiveTenantId: string;
  /** True when the caller's HOME is tenant zero — i.e. they are platform staff, not an operator. */
  readonly isPlatformHome: boolean;
}

const storage = new AsyncLocalStorage<TenantContextStore>();

export function createTenantContext(homeTenantId: string): TenantContextStore {
  return {
    homeTenantId,
    effectiveTenantId: homeTenantId,
    isPlatformHome: homeTenantId === TENANT_ZERO_ID,
  };
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { then?: unknown }).then === 'function';

/**
 * Runs `fn` inside a tenant context. Nested calls shadow, they never merge.
 *
 * The `.then()` touch mirrors ActorContextStorage and exists for the same reason: a Prisma query
 * object is LAZY, so `runWithTenant(id, () => prisma.player.findMany())` without an await would
 * hand an unstarted query back to a caller that awaits it AFTER the context has been exited — and
 * the tenant filter would be read from an empty store. Starting the work here makes
 * `() => prisma...` and `async () => await prisma...` behave identically.
 */
export function runWithTenantStore<T>(store: TenantContextStore, fn: () => T): T {
  return storage.run(store, () => {
    const result = fn();
    return isThenable(result) ? (result.then((value) => value) as T) : result;
  });
}

/** Convenience for the common case: enter the context of one tenant by id. */
export function runWithTenant<T>(homeTenantId: string, fn: () => T): T {
  return runWithTenantStore(createTenantContext(homeTenantId), fn);
}

/**
 * Enter tenant zero. For workers, crons and CLI commands that act as the platform rather than on
 * behalf of an operator — the tenant equivalent of ActorContextStorage's SYSTEM actor.
 */
export function runAsPlatform<T>(fn: () => T): T {
  return runWithTenant(TENANT_ZERO_ID, fn);
}

export function getTenantContext(): TenantContextStore | undefined {
  return storage.getStore();
}

export function getHomeTenantId(): string | undefined {
  return storage.getStore()?.homeTenantId;
}

export function getEffectiveTenantId(): string | undefined {
  return storage.getStore()?.effectiveTenantId;
}

/**
 * For code paths where running without a tenant is a bug rather than a possibility — every
 * tenant-scoped repository read, for instance.
 *
 * It throws a plain Error, not an AppException: reaching here means a route ran outside the
 * middleware, which is a programming error and belongs in the logs as an INTERNAL_ERROR with a
 * correlation id, not as a tidy 4xx that invites a client to retry.
 */
export function requireEffectiveTenantId(): string {
  const tenantId = storage.getStore()?.effectiveTenantId;
  if (tenantId === undefined) {
    throw new Error(
      'No tenant context. A tenant-scoped operation ran outside TenantContextMiddleware — ' +
        'wrap worker and CLI entry points in runWithTenant()/runAsPlatform().',
    );
  }
  return tenantId;
}

/**
 * Repoints THIS request at another operator's data. Only TenantOverrideInterceptor may call it,
 * and only after it has established that the caller is a PLATFORM_ADMIN homed in tenant zero.
 *
 * Home is intentionally not writable by anything, here or elsewhere.
 */
export function setEffectiveTenant(tenantId: string): boolean {
  const store = storage.getStore();
  if (store === undefined) return false;
  store.effectiveTenantId = tenantId;
  return true;
}
