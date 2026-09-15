import { DepositMode, TenantStatus, WithdrawalMode } from '@prisma/client';

import { TENANT_VIEW_SELECT, toTenantView, type TenantViewRow } from './tenant.view';

const PATH_TOKEN = 'path-token-that-must-never-leave-the-server';

const row = (overrides: Partial<TenantViewRow> = {}): TenantViewRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'northern-branch',
  displayName: 'Northern branch',
  status: TenantStatus.SUSPENDED,
  webhookPathToken: PATH_TOKEN,
  adminChatId: -1001234567890n,
  feedChatId: null,
  botUsername: 'northern_cashier_bot',
  ichancyBaseUrl: 'https://agents.ichancy.com',
  ichancyUsername: 'agent_north',
  ichancyAgentId: '10099',
  currencyCode: 'NSP',
  dualApprovalThresholdMinor: 30_000_000n,
  agentFloatLowWatermarkMinor: 50_000_000n,
  depositExpiryMinutes: 30,
  depositMode: DepositMode.MANUAL,
  withdrawalMode: WithdrawalMode.AUTO,
  miniAppUrl: 'https://cashier.example.app',
  createdAt: new Date('2026-09-01T10:00:00.000Z'),
  updatedAt: new Date('2026-09-02T11:30:00.000Z'),
  ...overrides,
});

const REAL = { ichancyFake: false } as const;

describe('toTenantView', () => {
  it('answers every field the console tenantSchema reads, with ids and money as strings', () => {
    expect(toTenantView(row(), { ...REAL, counts: { players: 12, deposits: 40 } })).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      slug: 'northern-branch',
      displayName: 'Northern branch',
      status: 'SUSPENDED',
      hasWebhookPath: true,
      adminChatId: '-1001234567890',
      feedChatId: null,
      botUsername: 'northern_cashier_bot',
      ichancyBaseUrl: 'https://agents.ichancy.com',
      ichancyUsername: 'agent_north',
      ichancyAgentId: '10099',
      currencyCode: 'NSP',
      dualApprovalThresholdMinor: '30000000',
      agentFloatLowWatermarkMinor: '50000000',
      depositExpiryMinutes: 30,
      depositMode: 'MANUAL',
      withdrawalMode: 'AUTO',
      miniAppUrl: 'https://cashier.example.app',
      ichancyFake: false,
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-02T11:30:00.000Z',
      counts: { players: 12, deposits: 40 },
    });
  });

  it('says so when the deployment runs with ICHANCY_FAKE, whatever the status', () => {
    expect(toTenantView(row({ status: TenantStatus.ACTIVE }), { ichancyFake: true })).toMatchObject({
      status: 'ACTIVE',
      ichancyFake: true,
    });
  });

  it('reports the webhook path only as a boolean, and never the token itself', () => {
    const view = toTenantView(row(), REAL);
    expect(view.hasWebhookPath).toBe(true);
    expect(JSON.stringify(view)).not.toContain(PATH_TOKEN);
    expect(view).not.toHaveProperty('webhookPathToken');

    expect(toTenantView(row({ webhookPathToken: null }), REAL).hasWebhookPath).toBe(false);
    expect(toTenantView(row({ webhookPathToken: '' }), REAL).hasWebhookPath).toBe(false);
  });

  it('answers an operator with no staff group bound (stored as 0) with a null admin chat', () => {
    const view = toTenantView(row({ adminChatId: 0n, feedChatId: 0n }), REAL);
    expect(view.adminChatId).toBeNull();
    expect(view.feedChatId).toBeNull();
  });

  it('keeps a channel id past what a JS number holds exactly', () => {
    const view = toTenantView(row({ feedChatId: -1009007199254740993n }), REAL);
    expect(view.feedChatId).toBe('-1009007199254740993');
  });

  it('omits counts when nothing was counted, rather than claiming zero', () => {
    expect(toTenantView(row(), REAL)).not.toHaveProperty('counts');
    expect(toTenantView(row(), { ...REAL, counts: { players: 0, deposits: 0 } }).counts).toEqual({
      players: 0,
      deposits: 0,
    });
  });

  it('selects no sealed column, so a secret cannot reach the mapper by accident', () => {
    const selected = Object.keys(TENANT_VIEW_SELECT);
    for (const secret of [
      'botTokenEnc',
      'webhookSecretEnc',
      'ichancyPasswordEnc',
      'shamcashApiKeyEnc',
    ]) {
      expect(selected).not.toContain(secret);
    }
  });
});
