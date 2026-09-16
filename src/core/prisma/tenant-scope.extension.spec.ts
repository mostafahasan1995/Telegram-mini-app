/**
 * The tenant-scope policy, as the pure function the Prisma extension executes.
 *
 * What is pinned here is the part the integration suite cannot see on single-operator fixtures:
 * a unique selector that names no tenant is REFUSED under test and PINNED everywhere else, a create
 * for another operator is refused under test, and the deliberate cross-operator marker is honoured
 * in unique selectors as well as in filters.
 */
import {
  ALL_TENANTS,
  CrossTenantWriteError,
  UnpinnedTenantAccessError,
  acrossTenants,
  scopeQueryArgs,
} from './tenant-scope.extension';

const TENANT_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const ID = 'cccccccc-3333-4333-8333-333333333333';

const argsOf = (decision: ReturnType<typeof scopeQueryArgs>): Record<string, unknown> =>
  decision.args ?? {};

describe('scopeQueryArgs — list operations', () => {
  it('injects the effective tenant into a filter that names none', () => {
    const decision = scopeQueryArgs('Player', 'findMany', { where: { status: 'ACTIVE' } }, TENANT_A, 'throw');
    expect(argsOf(decision)['where']).toEqual({ status: 'ACTIVE', tenantId: TENANT_A });
  });

  it('never overwrites an explicit tenant, which is how X-Tenant-Id and workers keep working', () => {
    const decision = scopeQueryArgs('Player', 'count', { where: { tenantId: TENANT_B } }, TENANT_A, 'throw');
    expect(decision.kind).toBe('pass');
  });

  it('strips the cross-operator marker and adds nothing', () => {
    const decision = scopeQueryArgs(
      'OutboxMessage',
      'findMany',
      { where: acrossTenants({ status: 'PENDING' }) },
      TENANT_A,
      'throw',
    );
    const where = argsOf(decision)['where'] as Record<string | symbol, unknown>;
    expect(where).toEqual({ status: 'PENDING' });
    expect(Object.getOwnPropertySymbols(where)).not.toContain(ALL_TENANTS);
  });
});

describe('scopeQueryArgs — unique selectors', () => {
  it.each(['findUnique', 'findUniqueOrThrow', 'update', 'delete', 'upsert'])(
    'REFUSES %s by bare id inside a tenant context under test',
    (operation) => {
      expect(() =>
        scopeQueryArgs('PaymentMethod', operation, { where: { id: ID } }, TENANT_A, 'throw'),
      ).toThrow(UnpinnedTenantAccessError);
    },
  );

  it('pins a bare id to the effective tenant outside test, and says so', () => {
    const decision = scopeQueryArgs(
      'DepositRequest',
      'update',
      { where: { id: ID }, data: { feeMinor: 1n } },
      TENANT_A,
      'inject',
    );
    expect(decision.kind).toBe('rewrite');
    expect(argsOf(decision)['where']).toEqual({ id: ID, tenantId: TENANT_A });
    expect(argsOf(decision)['data']).toEqual({ feeMinor: 1n });
    expect(decision.kind === 'rewrite' ? decision.notice : undefined).toMatch(/named no tenant/);
  });

  it('passes a selector that names the tenant directly or through a composite key', () => {
    expect(
      scopeQueryArgs('PaymentMethod', 'findUnique', { where: { id: ID, tenantId: TENANT_B } }, TENANT_A, 'throw')
        .kind,
    ).toBe('pass');
    expect(
      scopeQueryArgs(
        'PaymentMethod',
        'findUnique',
        { where: { tenantId_code: { tenantId: TENANT_A, code: 'X' } } },
        TENANT_A,
        'throw',
      ).kind,
    ).toBe('pass');
  });

  it('honours acrossTenants() in a unique selector, for a worker that has not read its row yet', () => {
    const decision = scopeQueryArgs(
      'DepositRequest',
      'findUnique',
      { where: acrossTenants({ id: ID }) },
      TENANT_A,
      'throw',
    );
    const where = argsOf(decision)['where'] as Record<string | symbol, unknown>;
    expect(where).toEqual({ id: ID });
    expect(Object.getOwnPropertySymbols(where)).toHaveLength(0);
  });

  it('adds nothing and refuses nothing with no tenant context at all', () => {
    const args = { where: { id: ID } };
    expect(scopeQueryArgs('DepositRequest', 'findUnique', args, undefined, 'throw')).toEqual({
      kind: 'pass',
      args,
    });
  });

  it('leaves models without a tenant alone', () => {
    expect(scopeQueryArgs('Tenant', 'findUnique', { where: { id: ID } }, TENANT_A, 'throw').kind).toBe(
      'pass',
    );
  });
});

describe('scopeQueryArgs — creates', () => {
  it("REFUSES a create for another operator under test — the destination-injection shape", () => {
    expect(() =>
      scopeQueryArgs(
        'PaymentDestination',
        'create',
        { data: { tenantId: TENANT_B, label: 'x' } },
        TENANT_A,
        'throw',
      ),
    ).toThrow(CrossTenantWriteError);
  });

  it('checks every row of a createMany and the create branch of an upsert', () => {
    expect(() =>
      scopeQueryArgs(
        'AuditLog',
        'createMany',
        { data: [{ tenantId: TENANT_A }, { tenantId: TENANT_B }] },
        TENANT_A,
        'throw',
      ),
    ).toThrow(CrossTenantWriteError);
    expect(() =>
      scopeQueryArgs(
        'ReconciliationBreak',
        'upsert',
        {
          where: { tenantId_dedupeKey: { tenantId: TENANT_A, dedupeKey: 'k' } },
          create: { tenantId: TENANT_B },
          update: {},
        },
        TENANT_A,
        'throw',
      ),
    ).toThrow(CrossTenantWriteError);
  });

  it('lets a create in the effective tenant through, and only reports a foreign one outside test', () => {
    expect(
      scopeQueryArgs('PaymentDestination', 'create', { data: { tenantId: TENANT_A } }, TENANT_A, 'throw')
        .kind,
    ).toBe('pass');
    const reported = scopeQueryArgs(
      'PaymentDestination',
      'create',
      { data: { tenantId: TENANT_B } },
      TENANT_A,
      'inject',
    );
    expect(reported.kind === 'rewrite' ? reported.notice : undefined).toMatch(/wrote tenant/);
    expect(argsOf(reported)['data']).toEqual({ tenantId: TENANT_B });
  });
});
