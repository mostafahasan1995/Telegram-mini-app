import { DepositMode, WithdrawalMode } from '@prisma/client';

import type { CreateTenantDto } from '../dtos/create-tenant.dto';

import {
  ADMIN_CHAT_UNRESOLVED_MESSAGE,
  ADMIN_CHAT_ZERO_MESSAGE,
  AGENT_ID_UNRESOLVED_MESSAGE,
  resolveCreateDefaults,
  type CreateDefaultsInput,
} from './create-defaults';
import type { PlatformDefaultsValues } from './platform-defaults.resolve';
import { firstFreeSlug, slugify } from './slug';

const DEFAULTS: PlatformDefaultsValues = {
  ichancyBaseUrl: 'https://agents.ichancy.com',
  ichancyAgentId: '10045',
  currencyCode: 'NSP',
  dualApprovalThresholdMinor: 100_000_000n,
  agentFloatLowWatermarkMinor: 50_000_000n,
  depositExpiryMinutes: 30,
};

/** The four-field body the console's create form sends when Advanced is left alone. */
const fourFields = (overrides: Partial<CreateTenantDto> = {}): CreateTenantDto => ({
  displayName: 'Northern branch',
  botToken: '123456789:AAbbccddeeffgghhiijjkkllmmnnooppqq',
  ichancyUsername: 'agent_north',
  ichancyPassword: 'secret password',
  ...overrides,
});

const input = (overrides: Partial<CreateDefaultsInput> = {}): CreateDefaultsInput => ({
  dto: fourFields(),
  platformDefaults: DEFAULTS,
  tenantZeroAgentId: 'unused',
  creatorTelegramUserId: 912_911_246n,
  ...overrides,
});

describe('resolveCreateDefaults', () => {
  it('fills every optional field from PlatformDefaults and the creator, and says which', () => {
    const result = resolveCreateDefaults(input());

    expect(result).toEqual({
      ok: true,
      values: {
        displayName: 'Northern branch',
        adminChatId: 912_911_246n,
        feedChatId: null,
        ichancyBaseUrl: DEFAULTS.ichancyBaseUrl,
        ichancyUsername: 'agent_north',
        ichancyAgentId: '10045',
        currencyCode: 'NSP',
        dualApprovalThresholdMinor: 100_000_000n,
        agentFloatLowWatermarkMinor: 50_000_000n,
        depositExpiryMinutes: 30,
        depositMode: DepositMode.MANUAL,
        withdrawalMode: WithdrawalMode.MANUAL,
        miniAppUrl: null,
      },
      defaulted: expect.arrayContaining([
        'ichancyAgentId',
        'adminChatId',
        'ichancyBaseUrl',
        'currencyCode',
        'dualApprovalThresholdMinor',
        'agentFloatLowWatermarkMinor',
        'depositExpiryMinutes',
      ]),
    });
  });

  it('lets every supplied value win over its default, and records none of them as defaulted', () => {
    const result = resolveCreateDefaults(
      input({
        dto: fourFields({
          adminChatId: '-1001234567890',
          feedChatId: '-1009876543210',
          ichancyBaseUrl: 'https://other.ichancy.example',
          ichancyAgentId: '20077',
          currencyCode: 'USD',
          dualApprovalThresholdMinor: '75000000',
          agentFloatLowWatermarkMinor: '1',
          depositExpiryMinutes: 45,
          depositMode: DepositMode.AUTO,
          withdrawalMode: WithdrawalMode.AUTO,
          miniAppUrl: 'https://app.example/north',
        }),
      }),
    );

    if (!result.ok) throw new Error('expected the create to resolve');
    expect(result.values).toMatchObject({
      adminChatId: -1001234567890n,
      feedChatId: -1009876543210n,
      ichancyBaseUrl: 'https://other.ichancy.example',
      ichancyAgentId: '20077',
      currencyCode: 'USD',
      dualApprovalThresholdMinor: 75_000_000n,
      agentFloatLowWatermarkMinor: 1n,
      depositExpiryMinutes: 45,
      depositMode: DepositMode.AUTO,
      withdrawalMode: WithdrawalMode.AUTO,
      miniAppUrl: 'https://app.example/north',
    });
    expect(result.defaulted).toEqual([]);
  });

  it('falls back for the agent id from PlatformDefaults to tenant zero, skipping placeholders', () => {
    const noPlatformAgent = { ...DEFAULTS, ichancyAgentId: null };

    const fromTenantZero = resolveCreateDefaults(
      input({ platformDefaults: noPlatformAgent, tenantZeroAgentId: '30011' }),
    );
    expect(fromTenantZero.ok && fromTenantZero.values.ichancyAgentId).toBe('30011');

    // Tenant zero's migration literal is `unused`: registering players under it would be a disaster.
    for (const placeholder of ['unused', 'SEED-PLACEHOLDER-PLATFORM-HAS-NO-AGENT', '  ', null]) {
      const refused = resolveCreateDefaults(
        input({ platformDefaults: noPlatformAgent, tenantZeroAgentId: placeholder }),
      );
      expect(refused).toEqual({ ok: false, fields: [AGENT_ID_UNRESOLVED_MESSAGE] });
    }
  });

  it('refuses a console-only creator with no adminChatId, naming the field, and collects both refusals', () => {
    expect(resolveCreateDefaults(input({ creatorTelegramUserId: null }))).toEqual({
      ok: false,
      fields: [ADMIN_CHAT_UNRESOLVED_MESSAGE],
    });

    const both = resolveCreateDefaults(
      input({
        creatorTelegramUserId: null,
        platformDefaults: { ...DEFAULTS, ichancyAgentId: null },
      }),
    );
    expect(both).toEqual({
      ok: false,
      fields: [AGENT_ID_UNRESOLVED_MESSAGE, ADMIN_CHAT_UNRESOLVED_MESSAGE],
    });
    for (const message of [AGENT_ID_UNRESOLVED_MESSAGE, ADMIN_CHAT_UNRESOLVED_MESSAGE]) {
      expect(message).toMatch(/^(ichancyAgentId|adminChatId) is required/);
    }

    // A console-only creator who names the chat is fine.
    const named = resolveCreateDefaults(
      input({ creatorTelegramUserId: null, dto: fourFields({ adminChatId: '-100555' }) }),
    );
    expect(named.ok && named.values.adminChatId).toBe(-100555n);
  });

  it('refuses a supplied adminChatId of 0, as it refuses a 0 default, even when the creator has an id', () => {
    for (const creatorTelegramUserId of [912_911_246n, null]) {
      expect(
        resolveCreateDefaults(
          input({ creatorTelegramUserId, dto: fourFields({ adminChatId: '0' }) }),
        ),
      ).toEqual({ ok: false, fields: [ADMIN_CHAT_ZERO_MESSAGE] });
    }
  });
});

describe('slugify and firstFreeSlug', () => {
  it('slugs the way the dashboard mock does', () => {
    expect(slugify('Northern Branch')).toBe('northern-branch');
    expect(slugify('  Café -- Damascus!! ')).toBe('cafe-damascus');
    expect(slugify('فرع الشمال')).toBe('tenant');
    expect(slugify('Branch 2 / West')).toBe('branch-2-west');
  });

  it('de-duplicates with -2, -3, … and skips suffixes already taken', () => {
    expect(firstFreeSlug('acme', new Set())).toBe('acme');
    expect(firstFreeSlug('acme', new Set(['acme']))).toBe('acme-2');
    expect(firstFreeSlug('acme', new Set(['acme', 'acme-2', 'acme-3']))).toBe('acme-4');
    expect(firstFreeSlug('acme', new Set(['acme-2']))).toBe('acme');
  });
});
