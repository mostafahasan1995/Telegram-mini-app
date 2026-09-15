/**
 * WHY tenant zero exists: PLATFORM_ADMIN rows need somewhere to live that is not an operator. A
 * platform login sitting inside a customer's tenant is a tenant login holding platform authority —
 * it has happened before, and it is exactly the shape of an authorization bug that reads as
 * "working" until the day it matters. `prisma/sql/006_tenant_isolation.sql` refuses to write one;
 * this constant is the other half of that pair.
 *
 * The id is a literal rather than a lookup on purpose. It is referenced by a CHECK constraint, by
 * the seed, and by the override interceptor's "is this caller platform staff" test — three places
 * that must agree without a database round trip, and one of which is SQL and cannot call code.
 */
export const TENANT_ZERO_ID = '00000000-0000-0000-0000-000000000000';

export const TENANT_ZERO_SLUG = 'platform';

/**
 * The operator every row that existed before multi-tenancy was backfilled into.
 *
 * Telegram updates no longer need it: the webhook resolves each update's operator from its path
 * token, and every operator has its own bot. What still names it is the Mini App sign-in
 * (player-auth.service.ts), because the mini app does not yet say which operator it was opened for;
 * until that is decided, only this operator's players can sign in there. The seeds and a few specs
 * also target it.
 *
 * Its rows are NOT tenant zero's: tenant zero is the platform and holds PLATFORM_ADMIN logins;
 * this is the operator that was actually taking deposits. Collapsing the two would give every
 * existing player a platform login's tenant.
 *
 * DELETE THIS once the mini app identifies its operator and the seeds stop targeting it.
 */
export const TENANT_BOOTSTRAP_ID = '00000000-0000-0000-0000-000000000001';

export const TENANT_BOOTSTRAP_SLUG = 'default';

/**
 * The header a PLATFORM_ADMIN uses to point one request at another operator's data.
 *
 * It is HONOURED only for a PLATFORM_ADMIN whose row is in tenant zero, and IGNORED — never
 * refused — for everybody else. A 403 here would turn the header into an oracle: send one, read
 * the error, learn which operator ids are real.
 */
export const TENANT_HEADER = 'x-tenant-id';

/** Cached Tenant lookup by id (positive AND negative — an unknown id must not be a free query). */
export const tenantRegistryKey = (tenantId: string): string => `tenant:id:${tenantId}`;

/**
 * Cached webhook route, keyed by the SHA-256 hex of the path token and never by the token itself.
 * The token is half of a webhook's credentials, and Redis keys show up in MONITOR, in SCAN output
 * and in every "what is filling Redis" investigation.
 */
export const tenantWebhookRouteKey = (pathTokenDigest: string): string =>
  `tenant:webhook:${pathTokenDigest}`;

/**
 * Short on purpose. This caches "does this operator exist, and is it serving" — a suspension has
 * to take effect quickly, and the row is tiny enough that re-reading it is cheap.
 */
export const TENANT_REGISTRY_TTL_SECONDS = 30;
