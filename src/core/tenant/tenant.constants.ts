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
 * WHY IT IS A CONSTANT AND NOT A LOOKUP: until phase 6 gives each operator its own bot and resolves
 * the tenant from the webhook path token, there is exactly one bot — the one in TELEGRAM_BOT_TOKEN —
 * and its inbound updates have no tenant on them. The webhook and the bot handlers need an answer
 * synchronously, and "the single non-zero ACTIVE tenant" is a rule that silently breaks the moment
 * a second operator is created.
 *
 * Its rows are NOT tenant zero's: tenant zero is the platform and holds PLATFORM_ADMIN logins;
 * this is the operator that was actually taking deposits. Collapsing the two would give every
 * existing player a platform login's tenant.
 *
 * DELETE THIS in phase 6, once `webhookPathToken` resolves the tenant per update.
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
 * Short on purpose. This caches "does this operator exist, and is it serving" — a suspension has
 * to take effect quickly, and the row is tiny enough that re-reading it is cheap.
 */
export const TENANT_REGISTRY_TTL_SECONDS = 30;
