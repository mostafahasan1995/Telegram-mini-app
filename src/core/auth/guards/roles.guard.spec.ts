/**
 * RolesGuard and the rule it delegates to (`holdsAnyRole`).
 *
 * The contract under test is the dashboard's (API-CONTRACT.md §3 Roles): PLATFORM_ADMIN is the owner
 * superset and passes every role list; every TENANT role is still matched exactly, so SUPER_ADMIN
 * gets no implicit grant. The guard is exercised with a fake Reflector because what it reads off the
 * route is one metadata object — booting Nest would test Nest.
 */
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { AdminRole } from '@prisma/client';

import { AUTH_REQUIREMENT_KEY, IS_PUBLIC_KEY } from '@common/decorators/auth.decorator';
import {
  REQUEST_ADMIN_KEY,
  type AuthenticatedAdmin,
  type AuthRequirement,
  type RequestPrincipals,
} from '@common/decorators/auth.types';
import { ForbiddenError } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';

import { TENANT_BOOTSTRAP_ID, TENANT_ZERO_ID } from '../../tenant/tenant.constants';
import { holdsAnyRole, isPlatformStaff } from '../admin-authority';
import { RolesGuard } from './roles.guard';

const TENANT_ROLES: readonly AdminRole[] = [
  AdminRole.SUPER_ADMIN,
  AdminRole.FINANCE_ADMIN,
  AdminRole.REVIEWER,
  AdminRole.SUPPORT,
  AdminRole.VIEWER,
];

function admin(role: AdminRole, tenantId: string = TENANT_BOOTSTRAP_ID): AuthenticatedAdmin {
  return {
    adminUserId: `admin-${role}`,
    telegramUserId: null,
    tenantId,
    role,
    displayName: role,
  };
}

const PLATFORM = admin(AdminRole.PLATFORM_ADMIN, TENANT_ZERO_ID);

function guardFor(requirement: AuthRequirement | undefined, isPublic = false): RolesGuard {
  const reflector = {
    getAllAndOverride: (key: string): unknown => {
      if (key === IS_PUBLIC_KEY) return isPublic;
      if (key === AUTH_REQUIREMENT_KEY) return requirement;
      return undefined;
    },
  } as unknown as Reflector;
  return new RolesGuard(reflector);
}

function contextFor(principal: AuthenticatedAdmin | undefined): ExecutionContext {
  const request: RequestPrincipals = {};
  if (principal !== undefined) request[REQUEST_ADMIN_KEY] = principal;
  const handler = (): void => undefined;
  class Controller {}
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => Controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function refusal(run: () => unknown): ForbiddenError {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof ForbiddenError) return error;
    throw error;
  }
  throw new Error('expected the guard to refuse');
}

const only = (...roles: AdminRole[]): AuthRequirement => ({ kind: 'ADMIN', roles });

describe('RolesGuard', () => {
  describe('PLATFORM_ADMIN homed in tenant zero — the owner superset', () => {
    it.each<[string, AuthRequirement]>([
      ['SUPER_ADMIN-only (admins.write)', only(AdminRole.SUPER_ADMIN)],
      [
        'SUPER_ADMIN + FINANCE_ADMIN (deposits.retryCredit)',
        only(AdminRole.SUPER_ADMIN, AdminRole.FINANCE_ADMIN),
      ],
      [
        'the deciding roles (deposits.decide)',
        only(AdminRole.SUPER_ADMIN, AdminRole.FINANCE_ADMIN, AdminRole.REVIEWER),
      ],
      ['VIEWER-only', only(AdminRole.VIEWER)],
    ])('passes a route restricted to %s', (_label, requirement) => {
      expect(guardFor(requirement).canActivate(contextFor(PLATFORM))).toBe(true);
    });

    it('passes a route that lists PLATFORM_ADMIN itself', () => {
      expect(guardFor(only(AdminRole.PLATFORM_ADMIN)).canActivate(contextFor(PLATFORM))).toBe(true);
    });
  });

  describe('a PLATFORM_ADMIN row outside tenant zero earns nothing implicit', () => {
    // prisma/sql/006 refuses to write one; this is what makes one worthless if it ever exists.
    const stray = admin(AdminRole.PLATFORM_ADMIN, TENANT_BOOTSTRAP_ID);

    it('is refused on a route restricted to other roles', () => {
      const error = refusal(() =>
        guardFor(only(AdminRole.SUPER_ADMIN)).canActivate(contextFor(stray)),
      );
      expect(error.errorCode).toBe(CommonErrorCodes.INSUFFICIENT_ROLE);
    });
  });

  describe('every tenant role is matched exactly, as before', () => {
    it.each(TENANT_ROLES)('%s passes a route that lists it', (role) => {
      expect(guardFor(only(role)).canActivate(contextFor(admin(role)))).toBe(true);
    });

    it.each(TENANT_ROLES)('%s is refused on a route that lists every OTHER tenant role', (role) => {
      const others = TENANT_ROLES.filter((candidate) => candidate !== role);
      const error = refusal(() => guardFor(only(...others)).canActivate(contextFor(admin(role))));
      expect(error.errorCode).toBe(CommonErrorCodes.INSUFFICIENT_ROLE);
    });

    it('gives SUPER_ADMIN no implicit grant: FINANCE_ADMIN-only stays FINANCE_ADMIN-only', () => {
      const error = refusal(() =>
        guardFor(only(AdminRole.FINANCE_ADMIN)).canActivate(
          contextFor(admin(AdminRole.SUPER_ADMIN)),
        ),
      );
      expect(error.errorCode).toBe(CommonErrorCodes.INSUFFICIENT_ROLE);
    });

    it('refuses a tenant role on a PLATFORM_ADMIN-only route', () => {
      const error = refusal(() =>
        guardFor(only(AdminRole.PLATFORM_ADMIN)).canActivate(
          contextFor(admin(AdminRole.SUPER_ADMIN)),
        ),
      );
      expect(error.errorCode).toBe(CommonErrorCodes.INSUFFICIENT_ROLE);
    });
  });

  describe('what the guard does not decide', () => {
    it('lets any admin through a route with no role list', () => {
      expect(guardFor(only()).canActivate(contextFor(admin(AdminRole.VIEWER)))).toBe(true);
    });

    it('ignores public and non-admin routes', () => {
      expect(guardFor(only(AdminRole.SUPER_ADMIN), true).canActivate(contextFor(undefined))).toBe(
        true,
      );
      expect(guardFor({ kind: 'PLAYER' }).canActivate(contextFor(undefined))).toBe(true);
      expect(guardFor(undefined).canActivate(contextFor(undefined))).toBe(true);
    });

    it('fails closed when no admin principal is attached', () => {
      const error = refusal(() =>
        guardFor(only(AdminRole.SUPER_ADMIN)).canActivate(contextFor(undefined)),
      );
      expect(error.errorCode).toBe(CommonErrorCodes.WRONG_PRINCIPAL);
    });
  });
});

describe('holdsAnyRole / isPlatformStaff', () => {
  it('needs BOTH the role and the tenant-zero home to be platform staff', () => {
    expect(isPlatformStaff({ role: AdminRole.PLATFORM_ADMIN, tenantId: TENANT_ZERO_ID })).toBe(
      true,
    );
    expect(isPlatformStaff({ role: AdminRole.PLATFORM_ADMIN, tenantId: TENANT_BOOTSTRAP_ID })).toBe(
      false,
    );
    expect(isPlatformStaff({ role: AdminRole.SUPER_ADMIN, tenantId: TENANT_ZERO_ID })).toBe(false);
  });

  it('treats an empty list as "nobody" rather than a wildcard, except for the superset', () => {
    expect(holdsAnyRole({ role: AdminRole.SUPER_ADMIN, tenantId: TENANT_BOOTSTRAP_ID }, [])).toBe(
      false,
    );
    expect(holdsAnyRole({ role: AdminRole.PLATFORM_ADMIN, tenantId: TENANT_ZERO_ID }, [])).toBe(
      true,
    );
  });
});
