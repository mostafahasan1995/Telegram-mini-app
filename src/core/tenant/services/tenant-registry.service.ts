/**
 * WHY this is a cached service and not a bare `prisma.tenant.findUnique`: it answers "does this
 * operator exist, and is it serving" on the request hot path — once per X-Tenant-Id override, and
 * once per inbound Telegram update when the webhook resolves its tenant from the path token.
 *
 * It caches MISSES too, for the same reason AdminIdentityService does: an unknown id must not be a
 * free database query for anyone who can send a header.
 *
 * The TTL is short (30s). This is the row that says whether an operator is suspended, and a
 * suspension that takes a minute to bite is a minute of an operator still taking money.
 */
import { Injectable } from '@nestjs/common';
import { type TenantStatus } from '@prisma/client';

import { CacheService } from '../../cache/cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TENANT_REGISTRY_TTL_SECONDS, tenantRegistryKey } from '../tenant.constants';

/** JSON-safe. Nothing here may become a bigint without revisiting the cache round trip. */
export interface TenantSummary {
  id: string;
  slug: string;
  displayName: string;
  status: TenantStatus;
  currencyCode: string;
}

@Injectable()
export class TenantRegistryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /** The operator behind an id, or null when there is no such row. */
  async find(tenantId: string): Promise<TenantSummary | null> {
    return this.cache.getOrSet<TenantSummary | null>(
      tenantRegistryKey(tenantId),
      TENANT_REGISTRY_TTL_SECONDS,
      async () => {
        // A malformed uuid would make Postgres raise 22P02 rather than return no rows, and a
        // header is client input. Checking the shape first keeps a bad header a 400, not a 500.
        if (!UUID.test(tenantId)) return null;

        return this.prisma.tenant.findUnique({
          where: { id: tenantId },
          select: { id: true, slug: true, displayName: true, status: true, currencyCode: true },
        });
      },
      { cacheNull: true },
    );
  }

  async exists(tenantId: string): Promise<boolean> {
    return (await this.find(tenantId)) !== null;
  }

  /**
   * MUST be called by anything that changes a tenant's status, slug or currency, otherwise a
   * suspended operator keeps serving for up to the TTL.
   */
  async invalidate(tenantId: string): Promise<void> {
    await this.cache.del(tenantRegistryKey(tenantId));
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
