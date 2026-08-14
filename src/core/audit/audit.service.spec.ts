/**
 * WHY the "left undefined" assertions matter: the Prisma actor-stamp extension only fills a column
 * it finds `undefined`. If this service defensively wrote `null` for a missing ip/userAgent/
 * correlationId it would win over the extension, and every audit row would silently lose the request
 * context we already had. That is invisible in a happy-path test, so it is asserted directly.
 */
import { Prisma } from '@prisma/client';

import { SYSTEM_ACTOR, adminActor, playerActor } from '@common/types/actor.type';
import type { Tx } from '@core/prisma/tx.type';

import { AuditService } from './audit.service';
import {
  AUDIT_CONTEXT_KEY,
  readAuditAmountMinor,
  readAuditContext,
  stripAuditContext,
} from './audit.types';

const ADMIN_ID = '3f8c1b52-9a4e-4c1d-8f3b-2c7d5e6a9b01';

interface AuditRow {
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

function setup(): { service: AuditService; tx: FakeTx } {
  return { service: new AuditService(), tx: createFakeTx() };
}

describe('AuditService.write', () => {
  it('records who did what to which entity', async () => {
    const { service, tx } = setup();

    const id = await service.write(asTx(tx), {
      action: 'deposit.approve',
      actor: adminActor(ADMIN_ID),
      subjectType: 'DepositRequest',
      subjectId: 'dep-1',
    });

    expect(tx.rows).toHaveLength(1);
    expect(tx.rows[0]).toMatchObject({
      id,
      actorType: 'ADMIN',
      actorId: ADMIN_ID,
      action: 'deposit.approve',
      entityType: 'DepositRequest',
      entityId: 'dep-1',
    });
  });

  it('leaves the request context undefined so the actor-stamp extension can fill it', async () => {
    const { service, tx } = setup();
    await service.write(asTx(tx), {
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
    const { service, tx } = setup();
    await service.write(asTx(tx), {
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
    const { service, tx } = setup();
    await service.write(asTx(tx), {
      action: 'deposit.view',
      actor: SYSTEM_ACTOR,
      subjectType: 'DepositRequest',
      subjectId: 'dep-1',
    });

    expect(tx.rows[0]?.before).toBe(Prisma.DbNull);
    expect(tx.rows[0]?.after).toBe(Prisma.DbNull);
  });

  it('renders bigint money inside a snapshot as a decimal string', async () => {
    const { service, tx } = setup();
    await service.write(asTx(tx), {
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

describe('AuditService — the $meta envelope', () => {
  it('carries amountMinor and metadata that the table has no columns for', async () => {
    const { service, tx } = setup();
    await service.write(asTx(tx), {
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
    const { service, tx } = setup();
    await service.write(asTx(tx), {
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
    const { service, tx } = setup();
    await service.write(asTx(tx), {
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
    const { service, tx } = setup();
    await service.write(asTx(tx), {
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
    const { service, tx } = setup();
    await service.write(asTx(tx), {
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
    const { service, tx } = setup();
    await service.write(asTx(tx), {
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
    const { service, tx } = setup();
    const ids = await service.writeMany(asTx(tx), [
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
  });

  it('is a no-op for an empty batch', async () => {
    const { service, tx } = setup();
    await expect(service.writeMany(asTx(tx), [])).resolves.toEqual([]);
    expect(tx.rows).toHaveLength(0);
  });
});
