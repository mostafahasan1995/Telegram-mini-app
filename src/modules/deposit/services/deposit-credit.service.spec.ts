/**
 * The BALANCE-DELTA protocol, exercised end to end against fakes.
 *
 * These are the cases that decide whether a player's money exists, so each one is written as the
 * question an operator would ask: "Ichancy timed out — did we credit them twice?", "the float is
 * empty — will it keep retrying?", "the delta says it landed — did we post T2?".
 */
import { CreditVerifiedBy, DepositStatus, type DepositRequest } from '@prisma/client';

import type { IchancyPort, IchancyResult, PlayerBalance } from '@core/ichancy';
import { IchancyRejectionCodes } from '@core/ichancy';
import { LedgerError } from '@core/ledger';

import { DepositErrorCodes } from '../enums/deposit-error-code.enum';
import type { PlayerLinkPort } from '../ports';
import { CreditRetryLaterError, DepositCreditService } from './deposit-credit.service';

const DEPOSIT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PLAYER_ID = '11111111-2222-4333-8444-555555555555';
const ICHANCY_PLAYER_ID = 'ich-123';
const AMOUNT = 150_000n; // 1500.00 NSP

function makeDeposit(overrides: Partial<DepositRequest> = {}): DepositRequest {
  return {
    id: DEPOSIT_ID,
    shortId: 'K7Q2ZP9V3M',
    playerId: PLAYER_ID,
    paymentMethodId: '22222222-3333-4444-8555-666666666666',
    paymentDestinationId: null,
    currencyCode: 'NSP',
    claimedAmountMinor: AMOUNT,
    verifiedAmountMinor: AMOUNT,
    feeMinor: 0n,
    creditedAmountMinor: AMOUNT,
    status: DepositStatus.APPROVED,
    externalReference: null,
    senderAccount: null,
    expiresAt: null,
    submittedAt: new Date(),
    reviewStartedAt: null,
    decidedAt: new Date(),
    secondApprovedAt: null,
    creditedAt: null,
    decidedByAdminId: null,
    secondApproverAdminId: null,
    rejectionCode: null,
    rejectionNote: null,
    idempotencyKey: null,
    creditKeyEpoch: 0,
    creditAttempts: 0,
    creditVerifiedBy: null,
    balanceBeforeMinor: null,
    balanceAfterMinor: null,
    ledgerClaimTxId: 'tx-1',
    ledgerCreditTxId: null,
    adminChatId: null,
    adminMessageId: null,
    adminThreadId: null,
    source: null,
    ipAddress: null,
    userAgent: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

interface Harness {
  service: DepositCreditService;
  deposit: DepositRequest;
  transitions: { to: DepositStatus; patch?: Record<string, unknown> }[];
  postings: { idempotencyKey: string }[];
  outbox: { topic: string; payload: Record<string, unknown> }[];
  creditCalls: number;
  balanceReads: number;
  lockExtends: number;
  lockReleases: number;
}

interface HarnessOptions {
  deposit?: Partial<DepositRequest>;
  /** Answers for successive creditPlayer calls. */
  creditAnswers: IchancyResult<{ balanceMinor: bigint | null }>[];
  /** Answers for successive getPlayerBalance calls (b0 first). */
  balanceAnswers: IchancyResult<PlayerBalance>[];
  /** Ledger float available to fund the credit. */
  floatMinor?: bigint;
  /** Make ledger.post throw, to model the sign guard refusing T2 after a confirmed credit. */
  ledgerRefusesPost?: boolean;
  lockAvailable?: boolean;
  lockStaysOurs?: boolean;
}

function makeHarness(options: HarnessOptions): Harness {
  const state = {
    deposit: makeDeposit(options.deposit),
    transitions: [] as { to: DepositStatus; patch?: Record<string, unknown> }[],
    postings: [] as { idempotencyKey: string }[],
    outbox: [] as { topic: string; payload: Record<string, unknown> }[],
    creditCalls: 0,
    balanceReads: 0,
    lockExtends: 0,
    lockReleases: 0,
  };

  const prisma = {
    depositRequest: {
      findUnique: () => Promise.resolve(state.deposit),
      update: ({ data }: { data: Record<string, unknown> }) => {
        state.deposit = { ...state.deposit, ...data };
        return Promise.resolve(state.deposit);
      },
    },
    runInTransaction: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(prisma),
  };

  // NOTE both take `tx` FIRST, exactly like the real service — a fake with the wrong arity would
  // silently receive the transaction where it expected the input and "pass" for the wrong reason.
  const stateMachine = {
    transition: (
      _tx: unknown,
      { to, patch }: { to: DepositStatus; patch?: Record<string, unknown> },
    ) => {
      state.transitions.push({ to, patch });
      state.deposit = { ...state.deposit, status: to, ...(patch ?? {}) };
      return Promise.resolve({ kind: 'transitioned' as const, deposit: state.deposit, from: to });
    },
    tryTransition: (
      _tx: unknown,
      { to, patch }: { to: DepositStatus; patch?: Record<string, unknown> },
    ) => {
      state.transitions.push({ to, patch });
      state.deposit = { ...state.deposit, status: to, ...(patch ?? {}) };
      return Promise.resolve(state.deposit);
    },
  };

  const ledger = {
    post: (_tx: unknown, posting: { idempotencyKey: string }) => {
      if (options.ledgerRefusesPost === true) {
        return Promise.reject(
          new LedgerError('LEDGER_SIGN_VIOLATION', 'agent float would go negative'),
        );
      }
      state.postings.push({ idempotencyKey: posting.idempotencyKey });
      return Promise.resolve({ transactionId: 'tx-t2' });
    },
  };

  const accounts = {
    findByCode: () => Promise.resolve({ id: 'float-account' }),
    computeBalanceFromEntries: () => Promise.resolve(options.floatMinor ?? 10_000_000n),
  };

  const locks = {
    acquire: () =>
      Promise.resolve(
        options.lockAvailable === false
          ? null
          : { key: 'lock', token: 't', acquiredAt: Date.now(), ttlMs: 1000 },
      ),
    extend: () => {
      state.lockExtends += 1;
      return Promise.resolve(options.lockStaysOurs !== false);
    },
    release: () => {
      state.lockReleases += 1;
      return Promise.resolve(true);
    },
  };

  const outbox = {
    enqueue: (_tx: unknown, input: { topic: string; payload: Record<string, unknown> }) => {
      state.outbox.push(input);
      return Promise.resolve({ id: 'outbox', deduplicated: false });
    },
    enqueueMany: (_tx: unknown, inputs: { topic: string; payload: Record<string, unknown> }[]) => {
      state.outbox.push(...inputs);
      return Promise.resolve(inputs.map(() => ({ id: 'outbox', deduplicated: false })));
    },
  };

  const audit = { write: () => Promise.resolve('audit-id') };

  const creditAnswers = [...options.creditAnswers];
  const balanceAnswers = [...options.balanceAnswers];

  const ichancy: Partial<IchancyPort> = {
    getPlayerBalance: () => {
      state.balanceReads += 1;
      const next = balanceAnswers.shift();
      return Promise.resolve(next ?? { kind: 'ambiguous', cause: 'no more scripted answers' });
    },
    creditPlayer: () => {
      state.creditCalls += 1;
      const next = creditAnswers.shift();
      return Promise.resolve(next ?? { kind: 'ambiguous', cause: 'no more scripted answers' });
    },
  };

  // Matches PLAYER_LINK_PORT exactly (../ports): the real one is owned by modules/player.
  const playerLink: PlayerLinkPort = {
    ensureLinked: () =>
      Promise.resolve({
        playerId: PLAYER_ID,
        ichancyPlayerId: ICHANCY_PLAYER_ID,
        ichancyLogin: 'pdeadbeef1234',
        created: false,
      }),
  };

  const service = new DepositCreditService(
    prisma as never,
    stateMachine as never,
    ledger as never,
    accounts as never,
    locks as never,
    outbox as never,
    audit as never,
    ichancy as IchancyPort,
    playerLink,
  );

  return {
    service,
    get deposit() {
      return state.deposit;
    },
    get transitions() {
      return state.transitions;
    },
    get postings() {
      return state.postings;
    },
    get outbox() {
      return state.outbox;
    },
    get creditCalls() {
      return state.creditCalls;
    },
    get balanceReads() {
      return state.balanceReads;
    },
    get lockExtends() {
      return state.lockExtends;
    },
    get lockReleases() {
      return state.lockReleases;
    },
  };
}

const task = {
  depositRequestId: DEPOSIT_ID,
  shortId: 'K7Q2ZP9V3M',
  creditKeyEpoch: 0,
  amountMinor: AMOUNT.toString(),
};

const ok = (balanceMinor: bigint | null): IchancyResult<{ balanceMinor: bigint | null }> => ({
  kind: 'ok',
  data: { balanceMinor },
});
const balance = (minor: bigint): IchancyResult<PlayerBalance> => ({
  kind: 'ok',
  data: { balanceMinor: minor },
});

// The verify window sleeps for seconds; fake timers would need every await interleaved, so the
// constants are shortened instead by running with jest's real timers and tiny delays.
jest.mock('../deposit.constants', () => {
  const actual = jest.requireActual<Record<string, unknown>>('../deposit.constants');
  return { ...actual, BALANCE_VERIFY_DELAY_MS: 1, BALANCE_VERIFY_RETRY_DELAY_MS: 1 };
});

describe('DepositCreditService — the balance-delta protocol', () => {
  it('API says ok -> CREDITED via API_OK, T2 posted exactly once', async () => {
    const harness = makeHarness({
      creditAnswers: [ok(1_000_000n)],
      balanceAnswers: [balance(850_000n)],
    });

    const outcome = await harness.service.credit(task);

    expect(outcome).toMatchObject({ kind: 'credited', verifiedBy: CreditVerifiedBy.API_OK });
    expect(harness.creditCalls).toBe(1);
    expect(harness.postings).toHaveLength(1);
    expect(harness.postings[0]?.idempotencyKey).toBe(`ledger:deposit:${DEPOSIT_ID}:credit`);
    expect(harness.deposit.status).toBe(DepositStatus.CREDITED);
    expect(harness.lockReleases).toBe(1);
  });

  it('API rejects -> CREDIT_FAILED and NO ledger movement', async () => {
    const harness = makeHarness({
      creditAnswers: [
        { kind: 'rejected', code: IchancyRejectionCodes.WRONG_ARGUMENTS, message: 'nope' },
      ],
      balanceAnswers: [balance(0n)],
    });

    const outcome = await harness.service.credit(task);

    expect(outcome).toMatchObject({ kind: 'failed' });
    expect(harness.postings).toHaveLength(0);
    expect(harness.deposit.status).toBe(DepositStatus.CREDIT_FAILED);
  });

  it('ambiguous but the delta covers the amount -> CREDITED via BALANCE_DELTA, no second POST', async () => {
    const harness = makeHarness({
      creditAnswers: [{ kind: 'ambiguous', cause: 'timeout' }],
      // b0 = 500.00, b1 = 2000.00 -> +1500.00, exactly what we sent.
      balanceAnswers: [balance(50_000n), balance(200_000n)],
    });

    const outcome = await harness.service.credit(task);

    expect(outcome).toMatchObject({
      kind: 'credited',
      verifiedBy: CreditVerifiedBy.BALANCE_DELTA,
    });
    // THE property that stops a double credit.
    expect(harness.creditCalls).toBe(1);
    expect(harness.postings).toHaveLength(1);
    expect(harness.lockExtends).toBeGreaterThanOrEqual(1);
  });

  it('ambiguous with no movement -> retries exactly ONCE, then succeeds', async () => {
    const harness = makeHarness({
      creditAnswers: [{ kind: 'ambiguous', cause: 'timeout' }, ok(200_000n)],
      balanceAnswers: [balance(50_000n), balance(50_000n)],
    });

    const outcome = await harness.service.credit(task);

    expect(outcome).toMatchObject({ kind: 'credited', verifiedBy: CreditVerifiedBy.API_OK });
    expect(harness.creditCalls).toBe(2);
  });

  it('ambiguous twice with no movement -> NEEDS_RECONCILIATION, never a third POST', async () => {
    const harness = makeHarness({
      creditAnswers: [
        { kind: 'ambiguous', cause: 'timeout' },
        { kind: 'ambiguous', cause: 'timeout again' },
      ],
      balanceAnswers: [balance(50_000n), balance(50_000n), balance(50_000n)],
    });

    const outcome = await harness.service.credit(task);

    expect(outcome.kind).toBe('needs_reconciliation');
    expect(harness.creditCalls).toBe(2);
    // No compensating entry is needed because T2 was never posted — the ledger still says we owe
    // the player, which is the truth while we do not know.
    expect(harness.postings).toHaveLength(0);
    expect(harness.deposit.status).toBe(DepositStatus.NEEDS_RECONCILIATION);
    expect(harness.outbox.some((message) => message.topic.endsWith('alert'))).toBe(true);
  });

  it('a delta LARGER than expected still counts as landed (other movements may share the window)', async () => {
    const harness = makeHarness({
      creditAnswers: [{ kind: 'ambiguous', cause: 'timeout' }],
      balanceAnswers: [balance(50_000n), balance(400_000n)],
    });
    const outcome = await harness.service.credit(task);
    expect(outcome).toMatchObject({ verifiedBy: CreditVerifiedBy.BALANCE_DELTA });
  });

  it('a delta SMALLER than expected does not count as landed', async () => {
    const harness = makeHarness({
      creditAnswers: [
        { kind: 'ambiguous', cause: 'timeout' },
        { kind: 'ambiguous', cause: 'timeout' },
      ],
      balanceAnswers: [balance(50_000n), balance(60_000n), balance(60_000n)],
    });
    const outcome = await harness.service.credit(task);
    expect(outcome.kind).toBe('needs_reconciliation');
  });

  it('AGENT_FLOAT_INSUFFICIENT is refused BEFORE Ichancy is called and is not retried', async () => {
    const harness = makeHarness({
      creditAnswers: [ok(null)],
      balanceAnswers: [balance(0n)],
      floatMinor: AMOUNT - 1n,
    });

    const outcome = await harness.service.credit(task);

    expect(outcome).toMatchObject({
      kind: 'failed',
      code: DepositErrorCodes.AGENT_FLOAT_INSUFFICIENT,
    });
    // Never called: our own books already knew this could not work.
    expect(harness.creditCalls).toBe(0);
    expect(harness.deposit.status).toBe(DepositStatus.CREDIT_FAILED);
    // An operator has to top the wallet up, so the failure must raise an alert.
    expect(harness.outbox.some((message) => message.topic.endsWith('alert'))).toBe(true);
  });

  it('an Ichancy INSUFFICIENT_AGENT_FLOAT rejection also ends in CREDIT_FAILED with an alert', async () => {
    const harness = makeHarness({
      creditAnswers: [
        {
          kind: 'rejected',
          code: IchancyRejectionCodes.INSUFFICIENT_AGENT_FLOAT,
          message: 'The amount is greater than you have in Total Available(FROM)',
        },
      ],
      balanceAnswers: [balance(0n)],
    });

    const outcome = await harness.service.credit(task);

    expect(outcome).toMatchObject({
      kind: 'failed',
      code: DepositErrorCodes.AGENT_FLOAT_INSUFFICIENT,
    });
    expect(harness.postings).toHaveLength(0);
    expect(harness.outbox.some((message) => message.topic.endsWith('alert'))).toBe(true);
  });

  it('refuses to send anything when the BASELINE balance cannot be read', async () => {
    const harness = makeHarness({
      creditAnswers: [ok(null)],
      balanceAnswers: [{ kind: 'ambiguous', cause: 'upstream down' }],
    });

    await expect(harness.service.credit(task)).rejects.toBeInstanceOf(CreditRetryLaterError);
    // Without b0 there is no delta to verify against, so the money must not move at all.
    expect(harness.creditCalls).toBe(0);
    expect(harness.lockReleases).toBe(1);
  });

  it('stops rather than measure without the mutex', async () => {
    const harness = makeHarness({
      creditAnswers: [{ kind: 'ambiguous', cause: 'timeout' }],
      balanceAnswers: [balance(50_000n), balance(200_000n)],
      lockStaysOurs: false,
    });

    await expect(harness.service.credit(task)).rejects.toBeInstanceOf(CreditRetryLaterError);
    expect(harness.postings).toHaveLength(0);
  });

  it('retries later rather than run two credits for one player at once', async () => {
    const harness = makeHarness({
      creditAnswers: [ok(null)],
      balanceAnswers: [balance(0n)],
      lockAvailable: false,
    });
    await expect(harness.service.credit(task)).rejects.toBeInstanceOf(CreditRetryLaterError);
    expect(harness.creditCalls).toBe(0);
  });

  it('a confirmed credit whose T2 the ledger refuses becomes NEEDS_RECONCILIATION, not a failure', async () => {
    const harness = makeHarness({
      creditAnswers: [ok(200_000n)],
      balanceAnswers: [balance(50_000n)],
      ledgerRefusesPost: true,
    });

    const outcome = await harness.service.credit(task);

    expect(outcome.kind).toBe('needs_reconciliation');
    expect(harness.deposit.status).toBe(DepositStatus.NEEDS_RECONCILIATION);
  });

  it('ignores a job carrying a stale creditKeyEpoch', async () => {
    const harness = makeHarness({
      deposit: { creditKeyEpoch: 3 },
      creditAnswers: [ok(null)],
      balanceAnswers: [balance(0n)],
    });

    const outcome = await harness.service.credit({ ...task, creditKeyEpoch: 2 });

    expect(outcome).toEqual({ kind: 'skipped', reason: 'STALE_EPOCH' });
    expect(harness.creditCalls).toBe(0);
  });

  it('is a no-op for a deposit that is already CREDITED', async () => {
    const harness = makeHarness({
      deposit: { status: DepositStatus.CREDITED },
      creditAnswers: [ok(null)],
      balanceAnswers: [balance(0n)],
    });

    const outcome = await harness.service.credit(task);

    expect(outcome).toEqual({ kind: 'skipped', reason: 'ALREADY_CREDITED' });
    expect(harness.creditCalls).toBe(0);
    expect(harness.postings).toHaveLength(0);
  });

  it('refuses to credit a REJECTED deposit', async () => {
    const harness = makeHarness({
      deposit: { status: DepositStatus.REJECTED },
      creditAnswers: [ok(null)],
      balanceAnswers: [balance(0n)],
    });

    const outcome = await harness.service.credit(task);

    expect(outcome).toEqual({ kind: 'skipped', reason: 'NOT_CREDITABLE_REJECTED' });
    expect(harness.creditCalls).toBe(0);
  });
});
