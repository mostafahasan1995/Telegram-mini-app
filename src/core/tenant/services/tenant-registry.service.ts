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
import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { type TenantStatus } from '@prisma/client';

import { CacheService } from '../../cache/cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  TENANT_REGISTRY_TTL_SECONDS,
  tenantRegistryKey,
  tenantWebhookRouteKey,
} from '../tenant.constants';

/** JSON-safe. Nothing here may become a bigint without revisiting the cache round trip. */
export interface TenantSummary {
  id: string;
  slug: string;
  displayName: string;
  status: TenantStatus;
  currencyCode: string;
}

/**
 * Where an inbound webhook call belongs, and what it must prove. JSON-safe for the same reason.
 *
 * The secret stays SEALED here, and so does the cached copy: only TenantSecretService opens it, at the
 * moment of comparison, and the plaintext never reaches Redis. The status is deliberately absent. It
 * is read through `find()`, whose cache `invalidate()` already evicts, so a suspension reaches the
 * webhook through the same path as every other caller instead of through a second cache nobody
 * remembers to clear.
 */
export interface TenantWebhookRoute {
  tenantId: string;
  webhookSecretEnc: string | null;
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
   * The operator whose webhook is served under `pathToken`, or null when none is.
   *
   * Misses are cached like hits, so a scanner walking random tokens costs Redis reads, not Postgres
   * queries. A token that is not even shaped like one is refused before either. That early return
   * is the only timing difference between two unknown tokens, and it tells the caller nothing
   * beyond what it already knows: that it sent something malformed.
   */
  async findByWebhookPathToken(pathToken: string): Promise<TenantWebhookRoute | null> {
    if (!WEBHOOK_PATH_TOKEN.test(pathToken)) return null;

    return this.cache.getOrSet<TenantWebhookRoute | null>(
      tenantWebhookRouteKey(digestPathToken(pathToken)),
      TENANT_REGISTRY_TTL_SECONDS,
      async () => {
        const row = await this.prisma.tenant.findUnique({
          where: { webhookPathToken: pathToken },
          select: { id: true, webhookSecretEnc: true },
        });
        return row === null ? null : { tenantId: row.id, webhookSecretEnc: row.webhookSecretEnc };
      },
      { cacheNull: true },
    );
  }

  /**
   * MUST be called by anything that changes a tenant's status, slug or currency, otherwise a
   * suspended operator keeps serving for up to the TTL.
   */
  async invalidate(tenantId: string): Promise<void> {
    await this.cache.del(tenantRegistryKey(tenantId));
  }

  /**
   * MUST be called with the OLD token by anything that rotates a webhook path token or its secret.
   * Otherwise, for up to the TTL, the old token keeps routing, or the old secret keeps authenticating.
   * The route cache is keyed by the token, so the tenant id alone cannot find the entry.
   */
  async invalidateWebhookPathToken(pathToken: string): Promise<void> {
    await this.cache.del(tenantWebhookRouteKey(digestPathToken(pathToken)));
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * URL-safe and bounded. Generated tokens are CSPRNG bytes in a URL-safe encoding, and the path segment
 * is what Caddy's and the backend's redaction regexes match. The upper bound keeps an absurd segment
 * out of the unique index lookup.
 */
const WEBHOOK_PATH_TOKEN = /^[A-Za-z0-9_-]{8,256}$/;

const digestPathToken = (pathToken: string): string =>
  createHash('sha256').update(pathToken, 'utf8').digest('hex');
