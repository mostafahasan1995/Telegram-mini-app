/**
 * TenantIchancyService.health in both Ichancy modes, every collaborator faked. The integration suites
 * prove the same answers through HTTP (tenant-provisioning.int.spec.ts under ICHANCY_FAKE,
 * tenant-ichancy.int.spec.ts with a stubbed real Ichancy); this pins the one rule that matters here:
 * under ICHANCY_FAKE nothing is asked and nothing reads as a success.
 */
import type { AuditService } from '@core/audit/audit.service';
import type { CacheService } from '@core/cache/cache.service';
import type { LockService } from '@core/cache/lock.service';
import type { AppConfigService } from '@core/config/config.service';
import type { IchancyPort, IchancySessionService } from '@core/ichancy';
import type { PrismaService } from '@core/prisma/prisma.service';
import type { TenantSecretService } from '@core/tenant/services/tenant-secret.service';
import { TENANT_ZERO_ID } from '@core/tenant/tenant.constants';

import {
  DEFAULT_PLAYER_IMPORT_LIMITS,
  ICHANCY_FAKE_MODE_MESSAGE,
  PLATFORM_HAS_NO_AGENT_MESSAGE,
} from '../tenant-admin.constants';

import type { TenantAdminService } from './tenant-admin.service';
import { TenantIchancyService, type IchancyHealthTarget } from './tenant-ichancy.service';

const NORTH_ID = '11111111-1111-4111-8111-111111111111';
const BASE_URL = 'https://agents.ichancy.com';
const LOGIN = 'agent_north';

const target = (overrides: Partial<IchancyHealthTarget> = {}): IchancyHealthTarget => ({
  id: NORTH_ID,
  ichancyBaseUrl: BASE_URL,
  ichancyUsername: LOGIN,
  ichancyAgentId: '10045',
  agentFloatLowWatermarkMinor: 50_000_000n,
  ...overrides,
});

function harness(fake: boolean) {
  const prisma = {
    tenant: {
      // Another operator on the same login, which `sharesAgentWith` reports in both modes.
      findMany: jest.fn().mockResolvedValue([
        {
          id: '22222222-2222-4222-8222-222222222222',
          slug: 'south-branch',
          ichancyBaseUrl: BASE_URL,
          ichancyUsername: LOGIN,
          ichancyAgentId: '10046',
        },
      ]),
    },
  };
  const cache = {
    getOrSet: jest.fn((_key: string, _ttl: number, load: () => Promise<unknown>) => load()),
    del: jest.fn().mockResolvedValue(undefined),
  };
  const port = {
    getAgentWallet: jest.fn(),
    signIn: jest.fn(),
  };
  const config = { ichancy: { fake } };

  const service = new TenantIchancyService(
    prisma as unknown as PrismaService,
    {} as unknown as AuditService,
    {} as unknown as TenantSecretService,
    cache as unknown as CacheService,
    {} as unknown as LockService,
    config as unknown as AppConfigService,
    {} as unknown as IchancySessionService,
    {} as unknown as TenantAdminService,
    port as unknown as IchancyPort,
    DEFAULT_PLAYER_IMPORT_LIMITS,
  );
  return { service, cache, port };
}

describe('TenantIchancyService.health', () => {
  describe('under ICHANCY_FAKE', () => {
    it('asks nothing, caches nothing, and reports fake mode as not ok with no float', async () => {
      const h = harness(true);

      const health = await h.service.health(target());

      expect(health).toEqual({
        ok: false,
        fake: true,
        baseUrl: BASE_URL,
        username: LOGIN,
        agentId: '10045',
        checkedAt: expect.any(String),
        error: ICHANCY_FAKE_MODE_MESSAGE,
        floatMinor: null,
        belowWatermark: false,
        sharesAgentWith: ['south-branch'],
      });
      expect(ICHANCY_FAKE_MODE_MESSAGE).toBe(
        'Ichancy is in fake mode (ICHANCY_FAKE=true): no real connection was made.',
      );
      expect(h.port.getAgentWallet).not.toHaveBeenCalled();
      expect(h.port.signIn).not.toHaveBeenCalled();
      expect(h.cache.getOrSet).not.toHaveBeenCalled();
    });

    it('keeps tenant zero’s own reason, and still says the deployment is fake', async () => {
      const h = harness(true);

      const health = await h.service.health(target({ id: TENANT_ZERO_ID }));

      expect(health).toMatchObject({ ok: false, fake: true, error: PLATFORM_HAS_NO_AGENT_MESSAGE });
      expect(h.port.getAgentWallet).not.toHaveBeenCalled();
    });
  });

  describe('in real mode', () => {
    it('reads the agent wallet through the cache and reports the float, with fake false', async () => {
      const h = harness(false);
      h.port.getAgentWallet.mockResolvedValue({
        kind: 'ok',
        data: { balanceMinor: 12_345_600n, availableMinor: 12_345_600n },
      });

      const health = await h.service.health(target());

      expect(health).toEqual({
        ok: true,
        fake: false,
        baseUrl: BASE_URL,
        username: LOGIN,
        agentId: '10045',
        checkedAt: expect.any(String),
        error: null,
        floatMinor: '12345600',
        belowWatermark: true,
        sharesAgentWith: ['south-branch'],
      });
      expect(h.cache.getOrSet).toHaveBeenCalledTimes(1);
      expect(h.port.getAgentWallet).toHaveBeenCalledTimes(1);
    });

    it('reports a refused read as not ok with its reason, and is still not fake', async () => {
      const h = harness(false);
      h.port.getAgentWallet.mockResolvedValue({
        kind: 'rejected',
        code: 'ICHANCY_AUTH_FAILED',
        message: 'the agent was refused',
      });

      const health = await h.service.health(target());

      expect(health).toMatchObject({
        ok: false,
        fake: false,
        error: 'ICHANCY_AUTH_FAILED: the agent was refused',
        floatMinor: null,
        belowWatermark: false,
      });
      expect(h.port.signIn).not.toHaveBeenCalled();
    });

    it('does not report tenant zero as fake', async () => {
      const h = harness(false);

      expect(await h.service.health(target({ id: TENANT_ZERO_ID }))).toMatchObject({
        ok: false,
        fake: false,
        error: PLATFORM_HAS_NO_AGENT_MESSAGE,
      });
    });
  });
});
