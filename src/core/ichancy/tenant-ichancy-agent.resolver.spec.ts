/**
 * Where an Ichancy call's credentials come from: the operator's own tenant row, and nowhere else.
 *
 * Pinned here because each refusal is a money-path property: an operator with no context, the
 * platform, a missing row, a placeholder or a password that does not open must never fall through to
 * "some" agent.
 */
import type { AppConfigService } from '@core/config/config.service';
import type { PrismaService } from '@core/prisma/prisma.service';
import { TenantSecretService } from '@core/tenant/services/tenant-secret.service';
import { TENANT_ZERO_ID } from '@core/tenant/tenant.constants';
import { runWithTenant } from '@core/tenant/tenant.storage';

import { ichancyAgentKey, normaliseIchancyBaseUrl } from './ichancy-agent';
import { TenantIchancyAgentResolver } from './tenant-ichancy-agent.resolver';

const ROOT = 'resolver-spec-root-secret-at-least-32-characters';
const NORTH = '11111111-1111-4111-8111-111111111111';
const SOUTH = '22222222-2222-4222-8222-222222222222';

describe('TenantIchancyAgentResolver', () => {
  const secrets = new TenantSecretService(ROOT);
  const rows = new Map<string, Record<string, unknown>>();
  const prisma = {
    tenant: {
      findUnique: jest.fn((args: { where: { id: string } }) =>
        Promise.resolve(rows.get(args.where.id) ?? null),
      ),
    },
  } as unknown as PrismaService;
  const config = { jwt: { secret: ROOT } } as unknown as AppConfigService;
  const resolver = new TenantIchancyAgentResolver(prisma, secrets, config);

  const row = (id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    ichancyBaseUrl: 'https://Agents.Example.com/',
    ichancyUsername: 'agent_north',
    ichancyPasswordEnc: secrets.sealIchancyPassword('north-password'),
    ichancyAgentId: '10099',
    currencyCode: 'NSP',
    ...overrides,
  });

  beforeEach(() => {
    rows.clear();
  });

  it("reads the operator in context from its own row, normalised, with its own agent id and currency", async () => {
    rows.set(NORTH, row(NORTH, { currencyCode: 'USD' }));

    const agent = await runWithTenant(NORTH, () => resolver.forCurrentTenant());

    expect(agent).toMatchObject({
      tenantId: NORTH,
      baseUrl: 'https://agents.example.com',
      username: 'agent_north',
      password: 'north-password',
      agentId: '10099',
      currency: 'USD',
      agentKey: ichancyAgentKey('https://agents.example.com', 'agent_north'),
    });
  });

  it('fails loudly with no operator in context, instead of borrowing an agent', async () => {
    const readsBefore = (prisma.tenant.findUnique as jest.Mock).mock.calls.length;
    await expect(resolver.forCurrentTenant()).rejects.toMatchObject({
      code: 'ICHANCY_NO_TENANT_CONTEXT',
    });
    // Not even a read: there is no operator whose row could be the answer.
    expect((prisma.tenant.findUnique as jest.Mock).mock.calls.length).toBe(readsBefore);
  });

  it('refuses the platform, a missing operator, a placeholder and a password that does not open', async () => {
    await expect(resolver.forTenant(TENANT_ZERO_ID)).rejects.toMatchObject({
      code: 'ICHANCY_PLATFORM_HAS_NO_AGENT',
    });
    await expect(resolver.forTenant(NORTH)).rejects.toMatchObject({ code: 'ICHANCY_TENANT_NOT_FOUND' });

    rows.set(NORTH, row(NORTH, { ichancyUsername: 'REPLACE-ME-ICHANCY-USERNAME' }));
    await expect(resolver.forTenant(NORTH)).rejects.toMatchObject({ code: 'ICHANCY_AGENT_UNCONFIGURED' });

    rows.set(NORTH, row(NORTH, { ichancyPasswordEnc: 'not-a-sealed-value' }));
    const refusal = await resolver.forTenant(NORTH).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: 'ICHANCY_AGENT_UNCONFIGURED' });
    expect(JSON.stringify(refusal)).not.toContain('not-a-sealed-value');
  });

  it('gives operators sharing one login one key and one digest, and a different password another digest', async () => {
    // Another spelling of the base URL and padding around the login: still one agent.
    rows.set(NORTH, row(NORTH));
    rows.set(SOUTH, row(SOUTH, { ichancyBaseUrl: 'https://agents.example.com', ichancyUsername: ' agent_north ' }));

    const north = await resolver.forTenant(NORTH);
    const south = await resolver.forTenant(SOUTH);
    expect(south.agentKey).toBe(north.agentKey);
    // The session's owner check: equal here, or the two would sign each other out on every call.
    expect(south.credentialDigest).toBe(north.credentialDigest);

    const changed = resolver.fromCandidate({
      tenantId: SOUTH,
      baseUrl: north.baseUrl,
      username: north.username,
      password: 'another-password',
      agentId: north.agentId,
      currency: 'NSP',
    });
    expect(changed.agentKey).toBe(north.agentKey);
    expect(changed.credentialDigest).not.toBe(north.credentialDigest);
    expect(north.credentialDigest).not.toContain('north-password');
    expect(north.agentKey).not.toContain('north');
  });

  it('keeps the key and the digest in agreement on a login that differs only in case: two agents, never one key with two digests', async () => {
    rows.set(NORTH, row(NORTH));
    rows.set(SOUTH, row(SOUTH, { ichancyUsername: 'AGENT_NORTH' }));

    const north = await resolver.forTenant(NORTH);
    const south = await resolver.forTenant(SOUTH);

    // Compared exactly, as the dashboard matches sharesAgentWith: nothing says Ichancy folds case, and
    // folding would lend one account's tokens to another.
    expect(south.agentKey).not.toBe(north.agentKey);
    expect(south.credentialDigest).not.toBe(north.credentialDigest);
    expect(south.username).toBe('AGENT_NORTH');
  });

  it('normalises base URLs the same way everywhere', () => {
    expect(normaliseIchancyBaseUrl(' HTTPS://Agents.Example.com/prefix/ ')).toBe(
      'https://agents.example.com/prefix',
    );
    expect(normaliseIchancyBaseUrl('not a url/')).toBe('not a url');
  });
});
