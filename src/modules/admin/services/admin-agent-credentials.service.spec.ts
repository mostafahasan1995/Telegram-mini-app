/**
 * The agent credential prover against a real TenantSecretService and a mocked tenant lookup. Principal
 * resolution and its race are proved against Postgres in admin-agent-auth.int.spec.ts, where the
 * unique index that settles the race actually exists.
 */
import { TenantStatus } from '@prisma/client';

import type { AuditService } from '@core/audit/audit.service';
import type { AdminIdentityService } from '@core/auth/services/admin-identity.service';
import type { PrismaService } from '@core/prisma/prisma.service';
import { TenantSecretService } from '@core/tenant/services/tenant-secret.service';
import { TENANT_ZERO_ID } from '@core/tenant/tenant.constants';

import type { AdminUserRepository } from '../repositories/admin-user.repository';
import { AdminAgentCredentialsService } from './admin-agent-credentials.service';

const secrets = new TenantSecretService('unit-test-root-secret-0123456789');
const AGENT_PASSWORD = 'Agent pass 9';

interface TenantRow {
  id: string;
  slug: string;
  displayName: string;
  status: TenantStatus;
  ichancyUsername: string;
  ichancyPasswordEnc: string;
}

let sequence = 0;
function tenantRow(overrides: Partial<TenantRow> = {}): TenantRow {
  sequence += 1;
  return {
    id: `11111111-1111-4111-8111-${sequence.toString().padStart(12, '0')}`,
    slug: `operator-${sequence}`,
    displayName: `Operator ${sequence}`,
    status: TenantStatus.ACTIVE,
    ichancyUsername: 'Agent_One',
    ichancyPasswordEnc: secrets.sealIchancyPassword(AGENT_PASSWORD),
    ...overrides,
  };
}

function harness(rows: TenantRow[]) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const prisma = { tenant: { findMany } } as unknown as PrismaService;
  const service = new AdminAgentCredentialsService(
    prisma,
    secrets,
    {} as AdminUserRepository,
    {} as AdminIdentityService,
    {} as AuditService,
  );
  return { service, findMany };
}

describe('AdminAgentCredentialsService.prove', () => {
  it('matches the login trimmed and case-insensitively, the password exactly, and names the operator', async () => {
    const row = tenantRow();
    const h = harness([row]);

    const proven = await h.service.prove('  agent_ONE ', AGENT_PASSWORD, 'chosen-slug');

    expect(proven).toEqual([
      {
        operator: {
          tenantId: row.id,
          slug: row.slug,
          displayName: row.displayName,
          status: TenantStatus.ACTIVE,
        },
        agentLogin: 'Agent_One',
      },
    ]);
    const [args] = h.findMany.mock.calls[0] as [{ where: Record<string, unknown> }];
    expect(args.where).toEqual({
      id: { not: TENANT_ZERO_ID },
      status: { not: TenantStatus.CLOSED },
      ichancyUsername: { equals: 'agent_ONE', mode: 'insensitive' },
      slug: 'chosen-slug',
    });
  });

  it('refuses a wrong password, a password differing only by case, and one with a trailing space', async () => {
    for (const attempt of ['wrong password', AGENT_PASSWORD.toUpperCase(), `${AGENT_PASSWORD} `]) {
      expect(await harness([tenantRow()]).service.prove('agent_one', attempt, undefined)).toEqual([]);
    }
  });

  it('drops a row the database matched only as a pattern, so `_` never stands for any character', async () => {
    const h = harness([tenantRow({ ichancyUsername: 'AgentXOne' })]);
    expect(await h.service.prove('agent_one', AGENT_PASSWORD, undefined)).toEqual([]);
  });

  it('does not look up a blank or placeholder login at all', async () => {
    for (const login of ['   ', 'unused', 'REPLACE-ME']) {
      const h = harness([tenantRow({ ichancyUsername: login })]);
      expect(await h.service.prove(login, AGENT_PASSWORD, undefined)).toEqual([]);
      expect(h.findMany).not.toHaveBeenCalled();
    }
  });

  it('treats an operator whose password is unset or does not open as a miss, without throwing', async () => {
    const otherKey = new TenantSecretService('a-different-root-secret-987654321');
    const h = harness([
      tenantRow({ ichancyPasswordEnc: 'SEED-PLACEHOLDER-ICHANCY' }),
      tenantRow({ ichancyPasswordEnc: otherKey.sealIchancyPassword(AGENT_PASSWORD) }),
    ]);
    expect(await h.service.prove('agent_one', AGENT_PASSWORD, undefined)).toEqual([]);
  });

  it('does the same crypto work for an unknown login as for one known operator: one open, one comparison', async () => {
    const open = jest.spyOn(secrets, 'openIchancyPassword');
    try {
      await harness([]).service.prove('nobody_here', AGENT_PASSWORD, undefined);
      expect(open).toHaveBeenCalledTimes(1);

      open.mockClear();
      await harness([tenantRow()]).service.prove('agent_one', 'wrong password', undefined);
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
    }
  });

  it('returns every operator the credential opens, in the order they were listed', async () => {
    const first = tenantRow();
    const second = tenantRow({ status: TenantStatus.SUSPENDED });
    const h = harness([first, second]);

    const proven = await h.service.prove('agent_one', AGENT_PASSWORD, undefined);
    expect(proven.map((match) => [match.operator.slug, match.operator.status])).toEqual([
      [first.slug, TenantStatus.ACTIVE],
      [second.slug, TenantStatus.SUSPENDED],
    ]);
  });
});
