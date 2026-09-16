/**
 * WHY the "left undefined" assertions matter: the Prisma actor-stamp extension only fills a column
 * it finds `undefined`. If this service defensively wrote `null` for a missing ip/userAgent/
 * correlationId it would win over the extension, and every audit row would silently lose the request
 * context we already had. That is invisible in a happy-path test, so it is asserted directly.
 *
 * WHY every act here opens a tenant context: an audit row names the operator whose decision it is
 * evidence of, so the service reads that operator from the ambient context and refuses to guess
 * when there is none. A request gets one from TenantContextMiddleware; a spec, like a worker or a
 * cron, has to open its own.
 */
import { Prisma } from '@prisma/client';

import { SYSTEM_ACTOR, adminActor, playerActor } from '@common/types/actor.type';
import { runWithTenant } from '@core/tenant';
import type { Tx } from '@core/prisma/tx.type';

import { AuditService } from './audit.service';
import {
  AUDIT_CONTEXT_KEY,
  type AuditWriteInput,
  readAuditAmountMinor,
  readAuditContext,
  stripAuditContext,
} from './audit.types';

const ADMIN_ID = '3f8c1b52-9a4e-4c1d-8f3b-2c7d5e6a9b01';

/**
 * Two operators, not one. "The row was written" and "the row was written to the RIGHT operator's
 * log" are different claims, and only a second tenant can tell them apart: a single-tenant suite
 * passes just as happily against a service that stamps a constant on every row.
 */
const OPERATOR_A = 'b7e4c2a1-5d38-4f6e-9a20-1c3d5e7f9a11';
const OPERATOR_B = 'c8f5d3b2-6e49-4a7f-8b31-2d4e6f8a0b22';

interface AuditRow {
  tenantId: string;
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  ip?: string;
  userAgent?: string;
  correlationId?: string;
}

function createFakeTx() {
  const rows: AuditRow[] = [];
  const auditLog = {
    create({ data }: { data: AuditRow }): Promise<{ id: string }> {
      rows.push(data);
      return Promise.resolve({ id: data.id });
    },
    createMany({ data }: { data: AuditRow[] }): Promise<{ count: number }> {
      rows.push(...data);
      return Promise.resolve({ count: data.length });
    },
  };
  return { rows, auditLog };
}

type FakeTx = ReturnType<typeof createFakeTx>;
const asTx = (tx: FakeTx): Tx => tx as unknown as Tx;

interface Harness {
  tx: FakeTx;
  /** Acts as OPERATOR_A, the operator whose decision the test is describing. */
  write: (input: AuditWriteInput) => Promise<string>;
  writeMany: (inputs: readonly AuditWriteInput[]) => Promise<string[]>;
  /** For the tests whose whole point is that the log is per-operator. */
  writeAs: (tenantId: string, input: AuditWriteInput) => Promise<string>;
}

function setup(): Harness {
  const service = new AuditService();
  const tx = createFakeTx();
  const writeAs = (tenantId: string, input: AuditWriteInput): Promise<string> =>
    runWithTenant(tenantId, () => service.write(asTx(tx), input));
  return {
    tx,
    writeAs,
    write: (input) => writeAs(OPERATOR_A, input),
    writeMany: (inputs) => runWithTenant(OPERATOR_A, () => service.writeMany(asTx(tx), inputs)),
  };
}

describe('AuditService.write', () => {
  it('records who did what to which entity', async () => {
    const { tx, write } = setup();

    const id = await write({
      action: 'deposit.approve',
      actor: adminActor(ADMIN_ID),
      subjectType: 'DepositRequest',
      subjectId: 'dep-1',
    });

    expect(tx.rows).toHaveLength(1);
    expect(tx.rows[0]).toMatchObject({
      id,
      tenantId: OPERATOR_A,
      actorType: 'ADMIN',
      actorId: ADMIN_ID,
      action: 'deposit.approve',
      entityType: 'DepositRequest',
      entityId: 'dep-1',
    });
  });

  it('files the evidence in the log of the operator that took the decision', async () => {
    const { tx, writeAs } = setup();

    await writeAs(OPERATOR_A, {
      action: 'deposit.approve',
      actor: adminActor(ADMIN_ID),
      subjectType: 'DepositRequest',
      subjectId: 'dep-a',
    });
    await writeAs(OPERATOR_B, {
      action: 'deposit.approve',
      actor: adminActor(ADMIN_ID),
      subjectType: 'DepositRequest',
      subjectId: 'dep-b',
    });

    // Not "every row has a tenant" but "every row has ITS OWN operator's tenant". A service that
    // resolved the tenant once, or fell back to the bootstrap operator, would file dep-b in A's
    // log — where A's auditor would read it as a decision A never took.
    expect(tx.rows.map((row) => [row.entityId, row.tenantId])).toEqual([
      ['dep-a', OPERATOR_A],
      ['dep-b', OPERATOR_B],
    ]);
  });

  it('leaves the request context undefined so the actor-stamp extension can fill it', async () => {
    const { tx, write } = setup();
    await write({
      action: 'deposit.approve',
      actor: adminActor(ADMIN_ID),
      subjectType: 'DepositRequest',
      subjectId: 'dep-1',
    });

    const written = tx.rows[0]!;
    expect('ip' in written).toBe(false);
    expect('userAgent' in written).toBe(false);
    expect('correlationId' in written).toBe(false);
  });

  it('honours context the caller supplied explicitly', async () => {
    const { tx, write } = setup();
    await write({
      action: 'deposit.approve',
      actor: adminActor(ADMIN_ID),
      subjectType: 'DepositRequest',
      subjectId: 'dep-1',
      ip: '10.0.0.1',
      userAgent: 'telegram-bot',
      correlationId: 'corr-1',
    });

    expect(tx.rows[0]).toMatchObject({
      ip: '10.0.0.1',
      userAgent: 'telegram-bot',
      correlationId: 'corr-1',
    });
  });

  it('writes SQL NULL, not JSON null, when no snapshot was taken', async () => {
    const { tx, write } = setup();
    await write({
      action: 'deposit.view',
      actor: SYSTEM_ACTOR,
      subjectType: 'DepositRequest',
      subjectId: 'dep-1',
    });

    expect(tx.rows[0]?.before).toBe(Prisma.DbNull);
    expect(tx.rows[0]?.after).toBe(Prisma.DbNull);
  });

  it('renders bigint money inside a snapshot as a decimal string', async () => {
    const { tx, write } = setup();
    await write({
      action: 'deposit.approve',
      actor: adminActor(ADMIN_ID),
      subjectType: 'DepositRequest',
      subjectId: 'dep-1',
      before: { verifiedAmountMinor: null },
      after: { verifiedAmountMinor: 500000n },
    });

    expect(tx.rows[0]?.before).toEqual({ verifiedAmountMinor: null });
    expect(tx.rows[0]?.after).toMatchObject({ verifiedAmountMinor: '500000' });
  });
});

describe('AuditService — no operator, no row', () => {
  it('refuses to write rather than filing the decision under a guessed operator', async () => {
    // What a worker that forgot runWithTenant() gets. Failing the money transaction is the correct
    // outcome: an audit row in the wrong operator's log is worse than a loud crash, because it is
    // evidence of something that never happened and nothing downstream would ever question it.
    const tx = createFakeTx();

    await expect(
      new AuditService().write(asTx(tx), {
        action: 'deposit.approve',
        actor: adminActor(ADMIN_ID),
        subjectType: 'DepositRequest',
        subjectId: 'dep-1',
      }),
    ).rejects.toThrow(/No tenant context/);
    expect(tx.rows).toHaveLength(0);
  });
});

describe('AuditService — the $meta envelope', () => {
  it('carries amountMinor and metadata that the table has no columns for', async () => {
    const { tx, write } = setup();
    await write({
      action: 'deposit.credit',
      actor: SYSTEM_ACTOR,
      subjectType: 'DepositRequest',
      subjectId: 'dep-1',
      after: { status: 'CREDITED' },
      amountMinor: 500000n,
      metadata: { verifiedBy: 'BALANCE_DELTA', ichancyCallId: 'call-1' },
    });

    const after = tx.rows[0]?.after as Prisma.JsonValue;
    expect(after).toEqual({
      status: 'CREDITED',
      [AUDIT_CONTEXT_KEY]: {
        verifiedBy: 'BALANCE_DELTA',
        ichancyCallId: 'call-1',
        amountMinor: '500000',
      },
    });
  });

  it('round-trips through the readers', async () => {
    const { tx, write } = setup();
    await write({
      action: 'deposit.credit',
      actor: SYSTEM_ACTOR,
      subjectType: 'DepositRequest',
      subjectId: 'dep-1',
      after: { status: 'CREDITED' },
      amountMinor: 500000n,
      metadata: { verifiedBy: 'API_OK' },
    });

    const after = tx.rows[0]?.after as Prisma.JsonValue;
    expect(readAuditAmountMinor(after)).toBe(500000n);
    expect(readAuditContext(after)).toMatchObject({ verifiedBy: 'API_OK' });
    // A reader that wants the domain snapshot must not see our bookkeeping key.
    expect(stripAuditContext(after)).toEqual({ status: 'CREDITED' });
  });

  it('does not add the envelope when there is nothing to put in it', async () => {
    const { tx, write } = setup();
    await write({
      action: 'deposit.reject',
      actor: adminActor(ADMIN_ID),
      subjectType: 'DepositRequest',
      subjectId: 'dep-1',
      after: { status: 'REJECTED' },
    });

    expect(tx.rows[0]?.after).toEqual({ status: 'REJECTED' });
    expect(readAuditContext(tx.rows[0]?.after as Prisma.JsonValue)).toBeNull();
  });

  it('records the amount even with no snapshot to attach it to', async () => {
    const { tx, write } = setup();
    await write({
      action: 'agentFloat.topup',
      actor: SYSTEM_ACTOR,
      subjectType: 'LedgerAccount',
      subjectId: 'acc-1',
      amountMinor: -2500n,
    });

    expect(readAuditAmountMinor(tx.rows[0]?.after as Prisma.JsonValue)).toBe(-2500n);
  });

  it('reads back as null for rows that never had an envelope', () => {
    expect(readAuditAmountMinor(null)).toBeNull();
    expect(readAuditContext(null)).toBeNull();
    expect(stripAuditContext(null)).toBeNull();
    expect(
      readAuditAmountMinor({ [AUDIT_CONTEXT_KEY]: { amountMinor: 'not a number' } }),
    ).toBeNull();
  });
});

describe('AuditService — actor id safety', () => {
  it('keeps a SYSTEM action anonymous', async () => {
    const { tx, write } = setup();
    await write({
      action: 'deposit.expire',
      actor: SYSTEM_ACTOR,
      subjectType: 'DepositRequest',
      subjectId: 'dep-1',
    });
    expect(tx.rows[0]).toMatchObject({ actorType: 'SYSTEM', actorId: null });
  });

  it('drops a non-uuid actor id rather than aborting the money transaction', async () => {
    // actor_id is @db.Uuid. A Telegram id here would raise 22P02 and roll back the credit that the
    // audit row was describing — the audit must never be the thing that loses the money write.
    const { tx, write } = setup();
    await write({
      action: 'deposit.approve',
      actor: playerActor('123456789'),
      subjectType: 'DepositRequest',
      subjectId: 'dep-1',
    });
    expect(tx.rows[0]).toMatchObject({ actorType: 'PLAYER', actorId: null });
  });
});

describe('AuditService.writeMany', () => {
  it('writes a batch in one call and returns the ids in order', async () => {
    const { tx, writeMany } = setup();
    const ids = await writeMany([
      {
        action: 'deposit.expire',
        actor: SYSTEM_ACTOR,
        subjectType: 'DepositRequest',
        subjectId: 'dep-1',
      },
      {
        action: 'deposit.expire',
        actor: SYSTEM_ACTOR,
        subjectType: 'DepositRequest',
        subjectId: 'dep-2',
      },
    ]);

    expect(ids).toHaveLength(2);
    expect(tx.rows.map((row) => row.entityId)).toEqual(['dep-1', 'dep-2']);
    expect(tx.rows.map((row) => row.id)).toEqual(ids);
    // One bulk decision is one operator's decision: its evidence must not end up split in two.
    expect(tx.rows.map((row) => row.tenantId)).toEqual([OPERATOR_A, OPERATOR_A]);
  });

  it('is a no-op for an empty batch', async () => {
    const { tx, writeMany } = setup();
    await expect(writeMany([])).resolves.toEqual([]);
    expect(tx.rows).toHaveLength(0);
  });
});
