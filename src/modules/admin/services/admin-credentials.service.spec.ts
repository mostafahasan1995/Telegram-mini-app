import { TenantStatus, type AdminRole } from '@prisma/client';

import { isAppException, type AppException } from '@common/exceptions/app.exception';
import type { AuditService } from '@core/audit/audit.service';
import { PasswordHasherService } from '@core/auth/services/password-hasher.service';
import type { SessionService } from '@core/auth/services/session.service';
import type { PrismaService } from '@core/prisma/prisma.service';
import { TENANT_ZERO_ID, TENANT_ZERO_SLUG } from '@core/tenant/tenant.constants';
import { getEffectiveTenantId } from '@core/tenant/tenant.storage';

import { AdminErrorCodes } from '../admin.constants';
import {
  AdminCredentialsService,
  resolveOperator,
  type OperatorRef,
} from './admin-credentials.service';

/** Cheap enough that the suite does not spend seconds deriving keys; still a real scrypt. */
const TEST_COST = { ln: 10, r: 8, p: 1 };
const PASSWORD = 'correct horse battery';
const WRONG_PASSWORD = 'incorrect horse battery';

const ALPHA: OperatorRef = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  slug: 'alpha',
  displayName: 'Alpha',
  status: TenantStatus.ACTIVE,
};
const BETA: OperatorRef = {
  tenantId: '22222222-2222-4222-8222-222222222222',
  slug: 'beta',
  displayName: 'Beta',
  status: TenantStatus.ACTIVE,
};
const SUSPENDED: OperatorRef = {
  tenantId: '33333333-3333-4333-8333-333333333333',
  slug: 'gamma',
  displayName: 'Gamma',
  status: TenantStatus.SUSPENDED,
};
const PLATFORM: OperatorRef = {
  tenantId: TENANT_ZERO_ID,
  slug: TENANT_ZERO_SLUG,
  displayName: 'Platform',
  status: TenantStatus.ACTIVE,
};

/** What the service's findMany selects. */
interface CandidateRow {
  id: string;
  tenantId: string;
  telegramUserId: bigint | null;
  role: AdminRole;
  displayName: string;
  passwordHash: string | null;
  tenant: { slug: string; displayName: string; status: TenantStatus };
}

let adminSequence = 0;

function candidate(
  operator: OperatorRef,
  passwordHash: string | null,
  overrides: Partial<CandidateRow> = {},
): CandidateRow {
  adminSequence += 1;
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${adminSequence.toString().padStart(12, '0')}`,
    tenantId: operator.tenantId,
    telegramUserId: null,
    role: 'SUPER_ADMIN',
    displayName: `Admin ${adminSequence}`,
    passwordHash,
    tenant: { slug: operator.slug, displayName: operator.displayName, status: operator.status },
    ...overrides,
  };
}

const EXPIRES_AT = new Date('2026-09-14T12:15:00.000Z');

function harness(rows: CandidateRow[]) {
  const hasher = new PasswordHasherService(TEST_COST);
  const verify = jest.spyOn(hasher, 'verify');

  const findMany = jest.fn().mockResolvedValue(rows);
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  /** The tenant context each transaction ran in — the audit row's tenant. */
  const transactionTenants: (string | undefined)[] = [];

  const tx = { adminUser: { updateMany } };
  const prisma = {
    adminUser: { findMany },
    runInTransaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => {
      transactionTenants.push(getEffectiveTenantId());
      return fn(tx);
    }),
  } as unknown as PrismaService;

  const write = jest.fn().mockResolvedValue('audit-row-id');
  const audit = { write } as unknown as AuditService;

  const issueAdminAccessToken = jest
    .fn()
    .mockResolvedValue({ accessToken: 'signed.access.token', accessTokenExpiresAt: EXPIRES_AT });
  const sessions = { issueAdminAccessToken } as unknown as SessionService;

  const service = new AdminCredentialsService(prisma, hasher, sessions, audit);
  return {
    service,
    hasher,
    verify,
    findMany,
    updateMany,
    write,
    issueAdminAccessToken,
    transactionTenants,
  };
}

/** Awaits a promise that must be refused, and hands back the AppException it was refused with. */
async function refusal(promise: Promise<unknown>): Promise<AppException> {
  try {
    await promise;
  } catch (error: unknown) {
    if (isAppException(error)) return error;
    throw error;
  }
  throw new Error('expected the sign-in to be refused');
}

/** Everything a mock was handed, as text — for proving the password went nowhere it should not. */
function everythingPassedTo(...mocks: jest.Mock[]): string {
  return JSON.stringify(
    mocks.map((mock): unknown => mock.mock.calls),
    (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
  );
}

describe('resolveOperator', () => {
  const match = (operator: OperatorRef) => ({ operator });

  it('chooses the only active operator', () => {
    expect(resolveOperator([match(ALPHA)])).toEqual({ kind: 'chosen', match: match(ALPHA) });
  });

  it('asks which operator when several are active, naming only slug and display name', () => {
    expect(resolveOperator([match(ALPHA), match(BETA)])).toEqual({
      kind: 'ambiguous',
      operators: [
        { slug: 'alpha', displayName: 'Alpha' },
        { slug: 'beta', displayName: 'Beta' },
      ],
    });
  });

  it('does not ask about a suspended operator when exactly one other is active', () => {
    expect(resolveOperator([match(SUSPENDED), match(ALPHA)])).toEqual({
      kind: 'chosen',
      match: match(ALPHA),
    });
  });

  it('refuses as not-active when every proven operator is suspended, naming them', () => {
    expect(resolveOperator([match(SUSPENDED)])).toEqual({
      kind: 'not-active',
      operators: [{ slug: 'gamma', displayName: 'Gamma' }],
    });
  });
});

describe('AdminCredentialsService.signIn', () => {
  let hash: string;

  beforeAll(async () => {
    hash = await new PasswordHasherService(TEST_COST).hash(PASSWORD);
  });

  it('looks the login up lower-cased and trimmed, across operators, active and password-bearing', async () => {
    const h = harness([]);
    await refusal(
      h.service.signIn({ username: '  Owner@Example.COM ', password: PASSWORD, operatorSlug: ' Alpha ' }),
    );

    expect(h.findMany).toHaveBeenCalledTimes(1);
    const [args] = h.findMany.mock.calls[0] as [{ where: Record<string, unknown> }];
    expect(args.where).toMatchObject({
      username: 'owner@example.com',
      isActive: true,
      passwordHash: { not: null },
      tenant: { status: { not: TenantStatus.CLOSED }, slug: 'alpha' },
    });
    // Deliberately cross-tenant: the marker the scope extension strips is on the filter.
    expect(Object.getOwnPropertySymbols(args.where)).toHaveLength(1);
  });

  it('answers an unknown login with 401 ADMIN_CREDENTIALS_INVALID, after a full dummy derivation', async () => {
    const h = harness([]);
    const error = await refusal(h.service.signIn({ username: 'nobody', password: PASSWORD }));

    expect(error.httpStatus).toBe(401);
    expect(error.errorCode).toBe(AdminErrorCodes.ADMIN_CREDENTIALS_INVALID);
    expect(h.verify).toHaveBeenCalledTimes(1);
    expect(h.verify).toHaveBeenCalledWith(PASSWORD, null);
    expect(h.issueAdminAccessToken).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });

  it('gives a wrong password exactly the answer an unknown login gets', async () => {
    const unknown = await refusal(
      harness([]).service.signIn({ username: 'nobody', password: PASSWORD }),
    );

    const h = harness([candidate(ALPHA, hash)]);
    const wrong = await refusal(h.service.signIn({ username: 'owner', password: WRONG_PASSWORD }));

    expect(wrong.toJSON()).toEqual(unknown.toJSON());
    expect(wrong.httpStatus).toBe(unknown.httpStatus);
    expect(wrong.details).toBeUndefined();
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it('still derives once for a blank login, without querying for it', async () => {
    const h = harness([]);
    const error = await refusal(h.service.signIn({ username: '   ', password: PASSWORD }));

    expect(error.errorCode).toBe(AdminErrorCodes.ADMIN_CREDENTIALS_INVALID);
    expect(h.findMany).not.toHaveBeenCalled();
    expect(h.verify).toHaveBeenCalledWith(PASSWORD, null);
  });

  it('opens a session in the account’s own operator, stamps it and audits it — never the password', async () => {
    const row = candidate(ALPHA, hash, { telegramUserId: 912_911_246n, role: 'FINANCE_ADMIN' });
    const h = harness([row]);

    const session = await h.service.signIn({ username: 'owner', password: PASSWORD });

    expect(session).toEqual({
      accessToken: 'signed.access.token',
      expiresAt: EXPIRES_AT.toISOString(),
      admin: {
        id: row.id,
        telegramUserId: '912911246',
        role: 'FINANCE_ADMIN',
        displayName: row.displayName,
      },
      tenantId: ALPHA.tenantId,
      tenantSlug: 'alpha',
    });
    expect(session).not.toHaveProperty('refreshToken');

    expect(h.issueAdminAccessToken).toHaveBeenCalledWith({
      adminUserId: row.id,
      telegramUserId: 912_911_246n,
      tenantId: ALPHA.tenantId,
      role: 'FINANCE_ADMIN',
      displayName: row.displayName,
    });

    // The @Public route has no ambient tenant; the stamp and the audit row run in the account's.
    expect(h.transactionTenants).toEqual([ALPHA.tenantId]);
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { id: row.id, tenantId: ALPHA.tenantId, isActive: true },
      data: { lastLoginAt: expect.any(Date) },
    });
    expect(h.write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin.login',
        actor: { type: 'ADMIN', id: row.id },
        subjectType: 'AdminUser',
        subjectId: row.id,
      }),
    );

    expect(everythingPassedTo(h.write, h.updateMany, h.issueAdminAccessToken)).not.toContain(
      PASSWORD,
    );
  });

  it('signs platform staff into tenant zero and its slug', async () => {
    const row = candidate(PLATFORM, hash, { role: 'PLATFORM_ADMIN' });
    const h = harness([row]);

    const session = await h.service.signIn({ username: 'platform', password: PASSWORD });

    expect(session.tenantId).toBe(TENANT_ZERO_ID);
    expect(session.tenantSlug).toBe(TENANT_ZERO_SLUG);
    expect(session.admin.role).toBe('PLATFORM_ADMIN');
    expect(h.transactionTenants).toEqual([TENANT_ZERO_ID]);
  });

  it('asks which operator (409) when the password opens several active ones, and issues nothing', async () => {
    const h = harness([candidate(ALPHA, hash), candidate(BETA, hash)]);

    const error = await refusal(h.service.signIn({ username: 'shared', password: PASSWORD }));

    expect(error.httpStatus).toBe(409);
    expect(error.errorCode).toBe(AdminErrorCodes.ADMIN_OPERATOR_AMBIGUOUS);
    expect(error.details).toEqual({
      operators: [
        { slug: 'alpha', displayName: 'Alpha' },
        { slug: 'beta', displayName: 'Beta' },
      ],
    });
    expect(h.issueAdminAccessToken).not.toHaveBeenCalled();
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it('counts only the operators whose stored password actually matched', async () => {
    const otherHash = await new PasswordHasherService(TEST_COST).hash(WRONG_PASSWORD);
    const h = harness([candidate(ALPHA, hash), candidate(BETA, otherHash)]);

    const session = await h.service.signIn({ username: 'shared', password: PASSWORD });

    expect(session.tenantSlug).toBe('alpha');
    expect(h.verify).toHaveBeenCalledTimes(2);
  });

  it('refuses a suspended operator with 403 ADMIN_OPERATOR_NOT_ACTIVE only once the password is right', async () => {
    const right = await refusal(
      harness([candidate(SUSPENDED, hash)]).service.signIn({
        username: 'staff',
        password: PASSWORD,
      }),
    );
    expect(right.httpStatus).toBe(403);
    expect(right.errorCode).toBe(AdminErrorCodes.ADMIN_OPERATOR_NOT_ACTIVE);
    expect(right.details).toEqual({ operators: [{ slug: 'gamma', displayName: 'Gamma' }] });

    const wrong = await refusal(
      harness([candidate(SUSPENDED, hash)]).service.signIn({
        username: 'staff',
        password: WRONG_PASSWORD,
      }),
    );
    expect(wrong.errorCode).toBe(AdminErrorCodes.ADMIN_CREDENTIALS_INVALID);
    expect(wrong.details).toBeUndefined();
  });

  it('re-stores a hash made at an older cost, at the current one', async () => {
    const olderHash = await new PasswordHasherService({ ln: 11, r: 8, p: 1 }).hash(PASSWORD);
    const h = harness([candidate(ALPHA, olderHash)]);

    await h.service.signIn({ username: 'owner', password: PASSWORD });

    const [args] = h.updateMany.mock.calls[0] as [{ data: { passwordHash?: string } }];
    const restored = args.data.passwordHash;
    expect(restored).toMatch(/^\$scrypt\$ln=10,r=8,p=1\$/);
    await expect(h.hasher.verify(PASSWORD, restored ?? null)).resolves.toEqual({
      ok: true,
      needsRehash: false,
    });
  });

  it('issues no token when the account was deactivated between the check and the stamp', async () => {
    const h = harness([candidate(ALPHA, hash)]);
    h.updateMany.mockResolvedValueOnce({ count: 0 });

    const error = await refusal(h.service.signIn({ username: 'owner', password: PASSWORD }));

    expect(error.errorCode).toBe(AdminErrorCodes.ADMIN_CREDENTIALS_INVALID);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.issueAdminAccessToken).not.toHaveBeenCalled();
  });
});
