import { DepositMode } from '@prisma/client';

import type { AppConfigService } from '@core/config/config.service';

import type { UpdateTenantDto } from '../dtos/update-tenant.dto';

import { changedFields } from './changed-fields';
import {
  immutableFieldsIn,
  platformDefaultsEditsFromDto,
  tenantEditsFromDto,
  type TenantEditableFields,
} from './edits';
import {
  isInertAgentId,
  platformDefaultsFromEnv,
  resolveIchancyAgentId,
} from './platform-defaults.resolve';

const config = (agentId: string): Pick<AppConfigService, 'ichancy' | 'limits'> =>
  ({
    ichancy: { baseUrl: 'https://agents.ichancy.com', agentId, currency: 'NSP' },
    limits: {
      dualApprovalThresholdMinor: 100_000_000n,
      agentFloatLowWatermarkMinor: 50_000_000n,
      depositExpiryMinutes: 120,
    },
  }) as unknown as Pick<AppConfigService, 'ichancy' | 'limits'>;

describe('platformDefaultsFromEnv', () => {
  it("copies this deployment's env into the six PlatformDefaults columns", () => {
    expect(platformDefaultsFromEnv(config(' 1234567 '))).toEqual({
      ichancyBaseUrl: 'https://agents.ichancy.com',
      ichancyAgentId: '1234567',
      currencyCode: 'NSP',
      dualApprovalThresholdMinor: 100_000_000n,
      agentFloatLowWatermarkMinor: 50_000_000n,
      depositExpiryMinutes: 120,
    });
  });

  it('stores no house agent when the env only holds a placeholder', () => {
    expect(platformDefaultsFromEnv(config('REPLACE-ME')).ichancyAgentId).toBeNull();
    expect(platformDefaultsFromEnv(config('unused')).ichancyAgentId).toBeNull();
  });
});

describe('isInertAgentId', () => {
  it.each([null, undefined, '', '   ', 'unused', 'UNUSED', 'REPLACE-ME', 'SEED-PLACEHOLDER-AGENT'])(
    'treats %p as no agent at all',
    (value) => {
      expect(isInertAgentId(value)).toBe(true);
    },
  );

  it('treats a real numeric agent id as real', () => {
    expect(isInertAgentId('10045')).toBe(false);
  });
});

describe('resolveIchancyAgentId', () => {
  it('takes a supplied id over every fallback', () => {
    expect(resolveIchancyAgentId('777', '10500', '10045')).toBe('777');
  });

  it('falls back to the platform default, then to tenant zero', () => {
    expect(resolveIchancyAgentId(undefined, '10500', '10045')).toBe('10500');
    expect(resolveIchancyAgentId(undefined, null, '10045')).toBe('10045');
  });

  it("skips tenant zero's migration literal 'unused' instead of registering players under it", () => {
    expect(resolveIchancyAgentId(undefined, null, 'unused')).toBeNull();
  });

  it('answers null when nothing real is left, the cue for a 400 naming ichancyAgentId', () => {
    expect(resolveIchancyAgentId('  ', '', null)).toBeNull();
  });
});

describe('tenant edits', () => {
  it('turns decimal strings into bigints and keeps a null miniAppUrl as a clear', () => {
    const dto: UpdateTenantDto = {
      adminChatId: '-1001234567890',
      dualApprovalThresholdMinor: '50000000',
      depositMode: DepositMode.AUTO,
      miniAppUrl: null,
    };
    expect(tenantEditsFromDto(dto)).toEqual({
      adminChatId: -1001234567890n,
      dualApprovalThresholdMinor: 50_000_000n,
      depositMode: 'AUTO',
      miniAppUrl: null,
    });
  });

  it('names the frozen fields a body tried to set, null included', () => {
    expect(immutableFieldsIn({ displayName: 'x' })).toEqual([]);
    expect(immutableFieldsIn({ slug: 'renamed', currencyCode: null })).toEqual([
      'slug',
      'currencyCode',
    ]);
  });

  it('converts a platform defaults PATCH the same way', () => {
    expect(
      platformDefaultsEditsFromDto({ agentFloatLowWatermarkMinor: '100', ichancyAgentId: '10500' }),
    ).toEqual({ agentFloatLowWatermarkMinor: 100n, ichancyAgentId: '10500' });
  });
});

describe('changedFields', () => {
  const current: TenantEditableFields = {
    displayName: 'Northern branch',
    adminChatId: -100n,
    feedChatId: null,
    dualApprovalThresholdMinor: 50n,
    agentFloatLowWatermarkMinor: 10n,
    depositExpiryMinutes: 30,
    depositMode: DepositMode.MANUAL,
    withdrawalMode: 'MANUAL',
    miniAppUrl: 'https://cashier.example.app',
  };

  it('keeps only the fields whose value differs, bigints compared by value', () => {
    expect(
      changedFields(current, {
        displayName: 'Northern branch',
        adminChatId: -100n,
        dualApprovalThresholdMinor: 75n,
        miniAppUrl: null,
      }),
    ).toEqual({
      data: { dualApprovalThresholdMinor: 75n, miniAppUrl: null },
      before: { dualApprovalThresholdMinor: 50n, miniAppUrl: 'https://cashier.example.app' },
      after: { dualApprovalThresholdMinor: 75n, miniAppUrl: null },
    });
  });

  it('answers null for a save that changes nothing', () => {
    expect(changedFields(current, { displayName: 'Northern branch', feedChatId: null })).toBeNull();
    expect(changedFields(current, {})).toBeNull();
  });
});
