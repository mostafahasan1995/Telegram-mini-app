import type { AdminRole } from '@prisma/client';

import { TENANT_ZERO_ID } from '@core/tenant/tenant.constants';

import { mayGrantRole } from './admin-role-grant';

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const OTHER_OPERATOR = '22222222-2222-4222-8222-222222222222';

const TENANT_ROLES: readonly AdminRole[] = [
  'SUPER_ADMIN',
  'FINANCE_ADMIN',
  'REVIEWER',
  'SUPPORT',
  'VIEWER',
];

describe('mayGrantRole', () => {
  it('lets anyone who may write staff grant every operator role, wherever they work', () => {
    for (const role of TENANT_ROLES) {
      expect(mayGrantRole({ role: 'SUPER_ADMIN', tenantId: OPERATOR }, role, OPERATOR)).toBe(true);
      expect(
        mayGrantRole({ role: 'PLATFORM_ADMIN', tenantId: TENANT_ZERO_ID }, role, OTHER_OPERATOR),
      ).toBe(true);
    }
  });

  it('grants PLATFORM_ADMIN only to platform staff working in tenant zero with no override', () => {
    const platformStaff = { role: 'PLATFORM_ADMIN' as const, tenantId: TENANT_ZERO_ID };

    expect(mayGrantRole(platformStaff, 'PLATFORM_ADMIN', TENANT_ZERO_ID)).toBe(true);
    // Switched into an operator with X-Tenant-Id: the row would land inside that operator.
    expect(mayGrantRole(platformStaff, 'PLATFORM_ADMIN', OPERATOR)).toBe(false);
  });

  it('never lets an operator role grant PLATFORM_ADMIN, nor a PLATFORM_ADMIN row outside tenant zero', () => {
    expect(mayGrantRole({ role: 'SUPER_ADMIN', tenantId: OPERATOR }, 'PLATFORM_ADMIN', OPERATOR)).toBe(
      false,
    );
    expect(
      mayGrantRole({ role: 'SUPER_ADMIN', tenantId: TENANT_ZERO_ID }, 'PLATFORM_ADMIN', TENANT_ZERO_ID),
    ).toBe(false);
    expect(
      mayGrantRole({ role: 'PLATFORM_ADMIN', tenantId: OPERATOR }, 'PLATFORM_ADMIN', OPERATOR),
    ).toBe(false);
  });
});
