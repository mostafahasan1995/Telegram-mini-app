/**
 * The webhook route lookup: which inputs may reach the cache or the database at all, what the cache
 * key is made of, and that the eviction helper evicts the same key the lookup writes.
 */
import { createHash } from 'node:crypto';

import { type CacheService, type GetOrSetOptions } from '../../cache/cache.service';
import { type PrismaService } from '../../prisma/prisma.service';
import { tenantWebhookRouteKey } from '../tenant.constants';
import { TenantRegistryService } from './tenant-registry.service';

const TOKEN = 'webhook_path_token_ABC-123_xyz';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';

describe('TenantRegistryService.findByWebhookPathToken', () => {
  let getOrSet: jest.Mock;
  let del: jest.Mock;
  let findUnique: jest.Mock;
  let registry: TenantRegistryService;

  beforeEach(() => {
    // Behaves like a cold cache: always runs the factory, records how it was called.
    getOrSet = jest.fn(
      (_key: string, _ttl: number, factory: () => Promise<unknown>, _options?: GetOrSetOptions) =>
        factory(),
    );
    del = jest.fn().mockResolvedValue(undefined);
    findUnique = jest.fn();
    registry = new TenantRegistryService(
      { tenant: { findUnique } } as unknown as PrismaService,
      { getOrSet, del } as unknown as CacheService,
    );
  });

  it.each(['', 'short', '../../etc/passwd', 'has space in it', 'x'.repeat(257), 'tok%2Fen_12345'])(
    'refuses %j without touching the cache or the database',
    async (token) => {
      await expect(registry.findByWebhookPathToken(token)).resolves.toBeNull();
      expect(getOrSet).not.toHaveBeenCalled();
      expect(findUnique).not.toHaveBeenCalled();
    },
  );

  it('keys the cache by a digest of the token, never the token, and caches misses', async () => {
    findUnique.mockResolvedValue(null);

    await expect(registry.findByWebhookPathToken(TOKEN)).resolves.toBeNull();

    const [key, , , options] = getOrSet.mock.calls[0] as [string, number, unknown, GetOrSetOptions];
    const digest = createHash('sha256').update(TOKEN, 'utf8').digest('hex');
    expect(key).toBe(tenantWebhookRouteKey(digest));
    expect(key).not.toContain(TOKEN);
    expect(options.cacheNull).toBe(true);
  });

  it('looks the row up by the unique path token and returns the id and the SEALED secret', async () => {
    findUnique.mockResolvedValue({ id: TENANT_ID, webhookSecretEnc: 'v1.sealed' });

    await expect(registry.findByWebhookPathToken(TOKEN)).resolves.toEqual({
      tenantId: TENANT_ID,
      webhookSecretEnc: 'v1.sealed',
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { webhookPathToken: TOKEN },
      select: { id: true, webhookSecretEnc: true },
    });
  });

  it('evicts exactly the key the lookup writes', async () => {
    findUnique.mockResolvedValue(null);
    await registry.findByWebhookPathToken(TOKEN);
    await registry.invalidateWebhookPathToken(TOKEN);

    expect(del).toHaveBeenCalledWith(getOrSet.mock.calls[0]?.[0]);
  });
});
