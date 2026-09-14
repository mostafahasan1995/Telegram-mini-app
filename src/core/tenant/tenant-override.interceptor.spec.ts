/**
 * X-Tenant-Id is HONOURED only for a PLATFORM_ADMIN homed in tenant zero and IGNORED — never refused —
 * for everybody else (API-CONTRACT.md §3: "The `X-Tenant-Id` override is how it REACHES another
 * tenant, never a gate on whether the action is allowed").
 *
 * The superset added to RolesGuard must not leak into this interceptor: widening WHO may act is not
 * widening WHERE they may act. These tests pin that the header still moves nobody but platform staff.
 */
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import { lastValueFrom, of } from 'rxjs';

import {
  REQUEST_ADMIN_KEY,
  type AuthenticatedAdmin,
  type RequestPrincipals,
} from '@common/decorators/auth.types';
import { ValidationError } from '@common/exceptions/app.exception';

import type { TenantRegistryService } from './services/tenant-registry.service';
import { TENANT_BOOTSTRAP_ID, TENANT_HEADER, TENANT_ZERO_ID } from './tenant.constants';
import { TenantOverrideInterceptor } from './tenant-override.interceptor';
import { getEffectiveTenantId, runWithTenant } from './tenant.storage';

const OTHER_OPERATOR = '7b0e5a51-3c4d-4e2f-9a8b-1c2d3e4f5a6b';

interface FakeRequest extends RequestPrincipals {
  headers: Record<string, string>;
}

function admin(role: AdminRole, tenantId: string): AuthenticatedAdmin {
  return { adminUserId: `admin-${role}`, telegramUserId: null, tenantId, role, displayName: role };
}

function harness(): { interceptor: TenantOverrideInterceptor; find: jest.Mock } {
  const find = jest.fn((id: string) =>
    Promise.resolve(id === OTHER_OPERATOR ? { id: OTHER_OPERATOR, status: 'ACTIVE' } : null),
  );
  const tenants = { find } as unknown as TenantRegistryService;
  return { interceptor: new TenantOverrideInterceptor(tenants), find };
}

function contextFor(principal: AuthenticatedAdmin | undefined, header?: string): ExecutionContext {
  const request: FakeRequest = { headers: header === undefined ? {} : { [TENANT_HEADER]: header } };
  if (principal !== undefined) request[REQUEST_ADMIN_KEY] = principal;
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/** Runs the interceptor inside the caller's HOME tenant and reports whose rows the handler read. */
function effectiveTenantSeenByHandler(
  interceptor: TenantOverrideInterceptor,
  home: string,
  principal: AuthenticatedAdmin | undefined,
  header?: string,
): Promise<unknown> {
  const next: CallHandler<unknown> = { handle: () => of(getEffectiveTenantId()) };
  return runWithTenant(home, () =>
    lastValueFrom(interceptor.intercept(contextFor(principal, header), next)),
  );
}

describe('TenantOverrideInterceptor', () => {
  it('honours the header for a PLATFORM_ADMIN homed in tenant zero', async () => {
    const { interceptor, find } = harness();
    const platform = admin(AdminRole.PLATFORM_ADMIN, TENANT_ZERO_ID);

    await expect(
      effectiveTenantSeenByHandler(interceptor, TENANT_ZERO_ID, platform, OTHER_OPERATOR),
    ).resolves.toBe(OTHER_OPERATOR);
    expect(find).toHaveBeenCalledWith(OTHER_OPERATOR);
  });

  it('answers an unknown tenant id from platform staff with a 400, not a fallback', async () => {
    const { interceptor } = harness();
    const platform = admin(AdminRole.PLATFORM_ADMIN, TENANT_ZERO_ID);

    await expect(
      effectiveTenantSeenByHandler(interceptor, TENANT_ZERO_ID, platform, TENANT_BOOTSTRAP_ID),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it.each([
    AdminRole.SUPER_ADMIN,
    AdminRole.FINANCE_ADMIN,
    AdminRole.REVIEWER,
    AdminRole.SUPPORT,
    AdminRole.VIEWER,
  ])('IGNORES the header from %s — no lookup, no refusal, home tenant served', async (role) => {
    const { interceptor, find } = harness();

    await expect(
      effectiveTenantSeenByHandler(
        interceptor,
        TENANT_BOOTSTRAP_ID,
        admin(role, TENANT_BOOTSTRAP_ID),
        OTHER_OPERATOR,
      ),
    ).resolves.toBe(TENANT_BOOTSTRAP_ID);
    // Not even a lookup: a lookup whose outcome changed the answer would be an oracle.
    expect(find).not.toHaveBeenCalled();
  });

  it('ignores the header from a PLATFORM_ADMIN row that is NOT homed in tenant zero', async () => {
    const { interceptor, find } = harness();
    const stray = admin(AdminRole.PLATFORM_ADMIN, TENANT_BOOTSTRAP_ID);

    await expect(
      effectiveTenantSeenByHandler(interceptor, TENANT_BOOTSTRAP_ID, stray, OTHER_OPERATOR),
    ).resolves.toBe(TENANT_BOOTSTRAP_ID);
    expect(find).not.toHaveBeenCalled();
  });

  it('ignores the header when there is no admin principal (a player, or a public route)', async () => {
    const { interceptor, find } = harness();

    await expect(
      effectiveTenantSeenByHandler(interceptor, TENANT_BOOTSTRAP_ID, undefined, OTHER_OPERATOR),
    ).resolves.toBe(TENANT_BOOTSTRAP_ID);
    expect(find).not.toHaveBeenCalled();
  });

  it('does nothing without the header', async () => {
    const { interceptor, find } = harness();
    const platform = admin(AdminRole.PLATFORM_ADMIN, TENANT_ZERO_ID);

    await expect(effectiveTenantSeenByHandler(interceptor, TENANT_ZERO_ID, platform)).resolves.toBe(
      TENANT_ZERO_ID,
    );
    expect(find).not.toHaveBeenCalled();
  });
});
