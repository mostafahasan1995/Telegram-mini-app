/**
 * These tests are the readable specification of what our money does. If one of them changes, the
 * business changed — that is the point of keeping the rules pure.
 */
import { LedgerTxKind } from '@prisma/client';

import { SYSTEM_ACTOR, adminActor } from '@common/types/actor.type';
import { sumMinor } from '@common/helpers/money.util';

import {
  ichancyAgentFloatCode,
  houseCashCode,
  playerLiabilityCode,
  railClearingCode,
} from './account-codes';
import { LedgerError } from './ledger.errors';
import type { Posting } from './ledger.types';
import { assertValidPosting } from './posting-validation';
import { depositApproved, ichancyCredited, railSettled, reversal } from './posting-rules';

const DEPOSIT_ID = '4f8a1e2c-0000-4000-8000-000000000001';
const PLAYER_ID = '4f8a1e2c-0000-4000-8000-000000000002';
const METHOD_ID = '4f8a1e2c-0000-4000-8000-000000000003';
const ADMIN_ID = '4f8a1e2c-0000-4000-8000-000000000004';
const TX_ID = '4f8a1e2c-0000-4000-8000-000000000005';
const ACCOUNT_ID_A = '4f8a1e2c-0000-4000-8000-00000000000a';
const ACCOUNT_ID_B = '4f8a1e2c-0000-4000-8000-00000000000b';

const CURRENCY = 'NSP';
/** 1,250.00 NSP */
const AMOUNT = 125_000n;

const amountFor = (posting: Posting, code: string): bigint =>
  sumMinor(posting.entries.filter((entry) => entry.accountCode === code).map((e) => e.amountMinor));

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof LedgerError) return error.code;
    throw error;
  }
  throw new Error('expected the call to throw');
};

describe('depositApproved (T1)', () => {
  const posting = depositApproved({
    depositId: DEPOSIT_ID,
    shortId: 'ABCDEFGHJK',
    playerId: PLAYER_ID,
    paymentMethodId: METHOD_ID,
    amountMinor: AMOUNT,
    currency: CURRENCY,
    actor: adminActor(ADMIN_ID),
  });

  it('debits rail clearing and credits the player liability', () => {
    expect(amountFor(posting, railClearingCode(METHOD_ID, CURRENCY))).toBe(AMOUNT);
    expect(amountFor(posting, playerLiabilityCode(PLAYER_ID, CURRENCY))).toBe(-AMOUNT);
  });

  it('is a valid, balanced DEPOSIT_CLAIM', () => {
    expect(posting.kind).toBe(LedgerTxKind.DEPOSIT_CLAIM);
    expect(() => assertValidPosting(posting)).not.toThrow();
    expect(sumMinor(posting.entries.map((entry) => entry.amountMinor))).toBe(0n);
  });

  it('points at the deposit so the DB can enforce one claim per deposit', () => {
    expect(posting.refType).toBe('DEPOSIT');
    expect(posting.refId).toBe(DEPOSIT_ID);
  });

  it('carries the shortId as the external reference a human can search for', () => {
    expect(posting.externalRef).toBe('ABCDEFGHJK');
  });

  it('derives the same idempotency key every time', () => {
    expect(posting.idempotencyKey).toBe(`ledger:deposit:${DEPOSIT_ID}:claim`);
  });

  it('refuses a non-positive amount', () => {
    expect(
      codeOf(() =>
        depositApproved({
          depositId: DEPOSIT_ID,
          shortId: 'ABCDEFGHJK',
          playerId: PLAYER_ID,
          paymentMethodId: METHOD_ID,
          amountMinor: 0n,
          currency: CURRENCY,
          actor: SYSTEM_ACTOR,
        }),
      ),
    ).toBe('LEDGER_INVALID_AMOUNT');
  });
});

describe('ichancyCredited (T2)', () => {
  const posting = ichancyCredited({
    depositId: DEPOSIT_ID,
    shortId: 'ABCDEFGHJK',
    playerId: PLAYER_ID,
    amountMinor: AMOUNT,
    currency: CURRENCY,
    actor: SYSTEM_ACTOR,
    verifiedBy: 'BALANCE_DELTA',
  });

  it('discharges the player liability out of the agent float', () => {
    expect(amountFor(posting, playerLiabilityCode(PLAYER_ID, CURRENCY))).toBe(AMOUNT);
    expect(amountFor(posting, ichancyAgentFloatCode(CURRENCY))).toBe(-AMOUNT);
  });

  it('is a valid, balanced DEPOSIT_CREDIT', () => {
    expect(posting.kind).toBe(LedgerTxKind.DEPOSIT_CREDIT);
    expect(() => assertValidPosting(posting)).not.toThrow();
  });

  it('omits the credit epoch from the key: re-running the API call never re-posts T2', () => {
    expect(posting.idempotencyKey).toBe(`ledger:deposit:${DEPOSIT_ID}:credit`);
  });

  it('records how the credit was verified', () => {
    expect(posting.metadata?.['verifiedBy']).toBe('BALANCE_DELTA');
  });

  it('leaves the player liability at zero once T1 and T2 have both posted', () => {
    const t1 = depositApproved({
      depositId: DEPOSIT_ID,
      shortId: 'ABCDEFGHJK',
      playerId: PLAYER_ID,
      paymentMethodId: METHOD_ID,
      amountMinor: AMOUNT,
      currency: CURRENCY,
      actor: adminActor(ADMIN_ID),
    });
    const liability = playerLiabilityCode(PLAYER_ID, CURRENCY);
    expect(amountFor(t1, liability) + amountFor(posting, liability)).toBe(0n);
  });
});

describe('railSettled', () => {
  const posting = railSettled({
    settlementId: 'stmt-2026-08-12-17',
    paymentMethodId: METHOD_ID,
    amountMinor: AMOUNT,
    currency: CURRENCY,
    actor: SYSTEM_ACTOR,
  });

  it('moves money from in-transit to confirmed cash', () => {
    expect(amountFor(posting, houseCashCode(METHOD_ID, CURRENCY))).toBe(AMOUNT);
    expect(amountFor(posting, railClearingCode(METHOD_ID, CURRENCY))).toBe(-AMOUNT);
  });

  it('is balanced and keyed by the statement line', () => {
    expect(() => assertValidPosting(posting)).not.toThrow();
    expect(posting.idempotencyKey).toBe('ledger:rail-settlement:stmt-2026-08-12-17');
  });

  it('empties rail clearing when it settles the claim that filled it', () => {
    const t1 = depositApproved({
      depositId: DEPOSIT_ID,
      shortId: 'ABCDEFGHJK',
      playerId: PLAYER_ID,
      paymentMethodId: METHOD_ID,
      amountMinor: AMOUNT,
      currency: CURRENCY,
      actor: adminActor(ADMIN_ID),
    });
    const clearing = railClearingCode(METHOD_ID, CURRENCY);
    expect(amountFor(t1, clearing) + amountFor(posting, clearing)).toBe(0n);
  });

  it('lets the caller override the kind the enum cannot express', () => {
    expect(posting.kind).toBe(LedgerTxKind.MANUAL_ADJUSTMENT);
    const explicit = railSettled({
      settlementId: 's1',
      paymentMethodId: METHOD_ID,
      amountMinor: AMOUNT,
      currency: CURRENCY,
      actor: SYSTEM_ACTOR,
      kind: LedgerTxKind.AGENT_FLOAT_TOPUP,
    });
    expect(explicit.kind).toBe(LedgerTxKind.AGENT_FLOAT_TOPUP);
  });
});

describe('reversal', () => {
  const original = {
    id: TX_ID,
    kind: LedgerTxKind.DEPOSIT_CREDIT,
    currencyCode: CURRENCY,
    entries: [
      { ledgerAccountId: ACCOUNT_ID_A, amountMinor: AMOUNT, sequence: 0 },
      { ledgerAccountId: ACCOUNT_ID_B, amountMinor: -AMOUNT, sequence: 1 },
    ],
  };

  const posting = reversal({
    transaction: original,
    actor: adminActor(ADMIN_ID),
    reason: 'duplicate credit',
  });

  it('negates every entry and stays balanced', () => {
    expect(posting.entries.map((entry) => entry.amountMinor)).toEqual([-AMOUNT, AMOUNT]);
    expect(() => assertValidPosting(posting)).not.toThrow();
  });

  it('targets accounts by id, because the original already resolved them', () => {
    expect(posting.entries.map((entry) => entry.accountId)).toEqual([ACCOUNT_ID_A, ACCOUNT_ID_B]);
  });

  it('never reuses the original kind, which a partial unique index would refuse', () => {
    expect(posting.kind).toBe(LedgerTxKind.DEPOSIT_REVERSAL);
    expect(posting.reversesTxId).toBe(TX_ID);
  });

  it('waives the sign guard so a correction is always postable', () => {
    expect(posting.allowNegative).toBe(true);
  });

  it('reverses each transaction at most once, by key', () => {
    expect(posting.idempotencyKey).toBe(`ledger:reversal:${TX_ID}`);
  });

  it('restores the original sequence order before negating', () => {
    const shuffled = reversal({
      transaction: {
        ...original,
        entries: [
          { ledgerAccountId: ACCOUNT_ID_B, amountMinor: -AMOUNT, sequence: 1 },
          { ledgerAccountId: ACCOUNT_ID_A, amountMinor: AMOUNT, sequence: 0 },
        ],
      },
      actor: SYSTEM_ACTOR,
      reason: 'ordering',
    });
    expect(shuffled.entries.map((entry) => entry.accountId)).toEqual([ACCOUNT_ID_A, ACCOUNT_ID_B]);
  });

  it('refuses a transaction with nothing to reverse', () => {
    expect(
      codeOf(() =>
        reversal({
          transaction: { ...original, entries: [] },
          actor: SYSTEM_ACTOR,
          reason: 'empty',
        }),
      ),
    ).toBe('LEDGER_NOTHING_TO_REVERSE');
  });

  it('round-trips a posting back to zero', () => {
    const net = sumMinor([
      ...original.entries.map((entry) => entry.amountMinor),
      ...posting.entries.map((entry) => entry.amountMinor),
    ]);
    expect(net).toBe(0n);
  });
});
