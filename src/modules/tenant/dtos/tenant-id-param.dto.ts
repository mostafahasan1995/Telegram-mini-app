/**
 * The `:id` of every `/v1/admin/tenants/:id` route.
 *
 * WHY NOT the shared IdParamDto: its `@IsUUID()` accepts only RFC versioned uuids (plus the nil one),
 * and the bootstrap operator's fixed id, `00000000-0000-0000-0000-000000000001`, has version nibble 0.
 * That id is a literal the migration, a CHECK constraint and the seeds agree on, so it cannot change.
 * With IdParamDto, the one operator players actually use answered 400 on every route of this surface,
 * and a platform admin could not read, edit, suspend or resume it from the console.
 *
 * So this checks the SHAPE Postgres needs to cast the value to a uuid, which is all the edge has to
 * guarantee: 8-4-4-4-12 hex, the same shape TenantRegistryService checks before it queries. Anything
 * else is still a 400 VALIDATION_FAILED rather than a 22P02 cast error surfacing as a 500.
 */
import { Matches } from 'class-validator';

export const TENANT_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenantIdParamDto {
  @Matches(TENANT_ID_SHAPE, { message: 'id must be a UUID' })
  id: string;
}
