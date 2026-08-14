import { DepositStatus, type DepositRequest } from '@prisma/client';

import { SYSTEM_ACTOR, adminActor } from '@common/types/actor.type';
import type { Tx } from '@core/prisma/tx.type';

import {
  ALLOWED_TRANSITIONS,
  DepositStateMachine,
  IllegalDepositTransitionError,
  OPEN_STATUSES,
  REVIEWABLE_STATUSES,
  TERMINAL_STATUSES,
  isTerminal,
} from './deposit-state.machine';

const DEPOSIT_ID = '11111111-2222-4333-8444-555555555555';
const ADMIN_ID = '99999999-8888-4777-8666-555555555555';

interface TransitionRow {
  depositRequestId: string;
  fromStatus: DepositStatus | null;
  toStatus: DepositStatus;
  actorType: string;
  actorId: string | null;
  reason: string | null;
  metadata: unknown;
}

/**
 * A fake `Tx` that models the ONE property the state machine depends on: `updateMany` reports how
 * many rows its WHERE clause matched. Everything else here exists to make that observable.
 */
function makeTx(initial: (Partial<DepositRequest> & { status: DepositStatus }) | null) {
  let row: (Partial<DepositRequest> & { status: DepositStatus }) | null =
    initial === null ? null : { id: DEPOSIT_ID, ...initial };
  const transitions: TransitionRow[] = [];
  /** Predicates the fake understands, recorded so a test can assert the CAS shape. */
  const seenWhere: Record<string, unknown>[] = [];

  const matches = (where: Record<string, unknown>): boolean => {
    if (row === null) return false;
    const status = where['status'] as { in?: DepositStatus[] } | undefined;
    if (status?.in !== undefined && !status.in.includes(row.status)) return false;

    // A tiny subset of Prisma's filter language: enough for the guards this module actually uses.
    for (const [key, value] of Object.entries(where)) {
      if (key === 'id' || key === 'status') continue;
      const actual = (row as Record<string, unknown>)[key];
      if (key === 'OR' && Array.isArray(value)) {
        const anyMatch = value.some((clause) => matches(clause as Record<string, unknown>));
        if (!anyMatch) return false;
        continue;
      }
      if (value !== null && typeof value === 'object') {
        const filter = value as { lt?: Date; not?: unknown };
        if (filter.lt !== undefined && !(actual instanceof Date && actual < filter.lt))
          return false;
        if ('not' in filter && actual === filter.not) return false;
        continue;
      }
      if (actual !== value) return false;
    }
    return true;
  };

  const tx = {
    depositRequest: {
      updateMany: ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        seenWhere.push(where);
        if (!matches(where)) return Promise.resolve({ count: 0 });
        row = { ...(row as object), ...data } as typeof row;
        return Promise.resolve({ count: 1 });
      },
      findUniqueOrThrow: () => Promise.resolve(row as DepositRequest),
      findUnique: ({ select }: { select?: Record<string, boolean> }) => {
        if (row === null) return Promise.resolve(null);
        if (select === undefined) return Promise.resolve(row);
        return Promise.resolve({ status: row.status });
      },
    },
    depositTransition: {
      create: ({ data }: { data: TransitionRow }) => {
        transitions.push(data);
        return Promise.resolve({ id: 'transition' });
      },
    },
  };

  return {
    tx: tx as unknown as Tx,
    transitions,
    seenWhere,
    current: () => row,
  };
}

describe('ALLOWED_TRANSITIONS', () => {
  it('covers every DepositStatus, so a new status cannot be silently unreachable', () => {
    for (const status of Object.values(DepositStatus)) {
      expect(ALLOWED_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('leaves REJECTED, EXPIRED and REVERSED with no outgoing edges', () => {
    expect(ALLOWED_TRANSITIONS[DepositStatus.REJECTED]).toEqual([]);
    expect(ALLOWED_TRANSITIONS[DepositStatus.EXPIRED]).toEqual([]);
    expect(ALLOWED_TRANSITIONS[DepositStatus.REVERSED]).toEqual([]);
  });

  it('classifies statuses consistently', () => {
    expect(isTerminal(DepositStatus.CREDITED)).toBe(true);
    expect(isTerminal(DepositStatus.CREDITING)).toBe(false);
    expect(OPEN_STATUSES).toContain(DepositStatus.CREDITING);
    expect(OPEN_STATUSES).not.toContain(DepositStatus.CREDITED);
    expect(REVIEWABLE_STATUSES).toEqual([
      DepositStatus.SUBMITTED,
      DepositStatus.UNDER_REVIEW,
      DepositStatus.PENDING_SECOND_APPROVAL,
    ]);
    // A terminal status is never reviewable, and never open.
    for (const status of TERMINAL_STATUSES) {
      expect(REVIEWABLE_STATUSES).not.toContain(status);
    }
  });
});

describe('DepositStateMachine.transition', () => {
  const machine = new DepositStateMachine();

  it('CASes on (id, status) and writes a transition row', async () => {
    const { tx, transitions, seenWhere, current } = makeTx({
      status: DepositStatus.AWAITING_PROOF,
    });

    const outcome = await machine.transition(tx, {
      depositRequestId: DEPOSIT_ID,
      from: DepositStatus.AWAITING_PROOF,
      to: DepositStatus.SUBMITTED,
      actor: adminActor(ADMIN_ID),
      reason: 'proof arrived',
      metadata: { riskFlags: [] },
    });

    expect(outcome.kind).toBe('transitioned');
    expect(current()?.status).toBe(DepositStatus.SUBMITTED);
    expect(seenWhere[0]).toMatchObject({
      id: DEPOSIT_ID,
      status: { in: [DepositStatus.AWAITING_PROOF] },
    });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      fromStatus: DepositStatus.AWAITING_PROOF,
      toStatus: DepositStatus.SUBMITTED,
      actorType: 'ADMIN',
      actorId: ADMIN_ID,
      reason: 'proof arrived',
    });
  });

  it('returns alreadyHandled — never throws — when the status has moved on', async () => {
    const { tx, transitions } = makeTx({ status: DepositStatus.CREDITED });

    const outcome = await machine.transition(tx, {
      depositRequestId: DEPOSIT_ID,
      from: DepositStatus.CREDITING,
      to: DepositStatus.CREDITED,
      actor: SYSTEM_ACTOR,
    });

    expect(outcome).toEqual({
      kind: 'alreadyHandled',
      current: DepositStatus.CREDITED,
      reason: 'STATUS_MISMATCH',
    });
    // Nothing was written: an already-handled transition must leave no trace.
    expect(transitions).toHaveLength(0);
  });

  it('reports NOT_FOUND rather than throwing when the row is gone', async () => {
    const { tx } = makeTx(null);
    const outcome = await machine.transition(tx, {
      depositRequestId: DEPOSIT_ID,
      from: DepositStatus.APPROVED,
      to: DepositStatus.CREDITING,
      actor: SYSTEM_ACTOR,
    });
    expect(outcome).toEqual({ kind: 'alreadyHandled', current: null, reason: 'NOT_FOUND' });
  });

  it('distinguishes a failed GUARD from a status mismatch', async () => {
    // Status matches, but the four-eyes guard (decidedByAdminId != me) does not.
    const { tx } = makeTx({
      status: DepositStatus.PENDING_SECOND_APPROVAL,
      decidedByAdminId: ADMIN_ID,
    });

    const outcome = await machine.transition(tx, {
      depositRequestId: DEPOSIT_ID,
      from: DepositStatus.PENDING_SECOND_APPROVAL,
      to: DepositStatus.APPROVED,
      actor: adminActor(ADMIN_ID),
      guard: { decidedByAdminId: { not: ADMIN_ID } },
    });

    expect(outcome).toEqual({
      kind: 'alreadyHandled',
      current: DepositStatus.PENDING_SECOND_APPROVAL,
      reason: 'GUARD_FAILED',
    });
  });

  it('lets the same guard PASS for a different admin', async () => {
    const other = '77777777-6666-4555-8444-333333333333';
    const { tx, current } = makeTx({
      status: DepositStatus.PENDING_SECOND_APPROVAL,
      decidedByAdminId: ADMIN_ID,
    });

    const outcome = await machine.transition(tx, {
      depositRequestId: DEPOSIT_ID,
      from: DepositStatus.PENDING_SECOND_APPROVAL,
      to: DepositStatus.APPROVED,
      actor: adminActor(other),
      guard: { decidedByAdminId: { not: other } },
      patch: { secondApproverAdminId: other },
    });

    expect(outcome.kind).toBe('transitioned');
    expect(current()?.secondApproverAdminId).toBe(other);
  });

  it('throws on an illegal edge — that is a programming error, not a business one', async () => {
    const { tx } = makeTx({ status: DepositStatus.REJECTED });
    await expect(
      machine.transition(tx, {
        depositRequestId: DEPOSIT_ID,
        from: DepositStatus.REJECTED,
        to: DepositStatus.APPROVED,
        actor: SYSTEM_ACTOR,
      }),
    ).rejects.toBeInstanceOf(IllegalDepositTransitionError);
  });

  it('applies only the patch keys the caller actually set', async () => {
    const { tx, current } = makeTx({
      status: DepositStatus.SUBMITTED,
      rejectionNote: 'keep me',
    });

    await machine.transition(tx, {
      depositRequestId: DEPOSIT_ID,
      from: DepositStatus.SUBMITTED,
      to: DepositStatus.UNDER_REVIEW,
      actor: adminActor(ADMIN_ID),
      patch: { reviewStartedAt: new Date(), rejectionNote: undefined },
    });

    expect(current()?.rejectionNote).toBe('keep me');
    expect(current()?.reviewStartedAt).toBeInstanceOf(Date);
  });

  it('records a null actorId for a non-uuid actor instead of aborting the write', async () => {
    const { tx, transitions } = makeTx({ status: DepositStatus.APPROVED });
    await machine.transition(tx, {
      depositRequestId: DEPOSIT_ID,
      from: DepositStatus.APPROVED,
      to: DepositStatus.CREDITING,
      actor: { type: 'ADMIN', id: 'telegram:12345' },
    });
    expect(transitions[0]?.actorId).toBeNull();
  });

  it('accepts several source statuses and records the candidate set when it cannot tell', async () => {
    const { tx, transitions } = makeTx({ status: DepositStatus.UNDER_REVIEW });

    const outcome = await machine.transition(tx, {
      depositRequestId: DEPOSIT_ID,
      from: [DepositStatus.SUBMITTED, DepositStatus.UNDER_REVIEW],
      to: DepositStatus.APPROVED,
      actor: adminActor(ADMIN_ID),
    });

    expect(outcome.kind).toBe('transitioned');
    expect(transitions[0]?.fromStatus).toBeNull();
    expect(transitions[0]?.metadata).toMatchObject({
      fromCandidates: [DepositStatus.SUBMITTED, DepositStatus.UNDER_REVIEW],
    });
  });

  it('tryTransition returns null instead of an outcome object on contention', async () => {
    const { tx } = makeTx({ status: DepositStatus.CREDITED });
    const result = await machine.tryTransition(tx, {
      depositRequestId: DEPOSIT_ID,
      from: DepositStatus.APPROVED,
      to: DepositStatus.CREDITING,
      actor: SYSTEM_ACTOR,
    });
    expect(result).toBeNull();
  });
});
