/**
 * The zero-sum assertion is the single rule that makes this a ledger rather than a log. It is tested
 * without a database on purpose: if it ever needs a container to verify, it has stopped being pure
 * and the guarantee has moved somewhere harder to reason about.
 */
import { LedgerTxKind } from '@prisma/client';

import { SYSTEM_ACTOR } from '@common/types/actor.type';

import { LedgerError } from './ledger.errors';
import type { Posting, PostingEntry } from './ledger.types';
import {
  assertEntryShape,
  assertValidPosting,
  assertZeroSum,
  netByAccountRef,
} from './posting-validation';

const ACCOUNT_A = 'ICHANCY_AGENT_FLOAT:NSP';
const ACCOUNT_B = 'HOUSE_ROUNDING:NSP';

const posting = (entries: PostingEntry[]): Posting => ({
  idempotencyKey: 'ledger:test:1',
  kind: LedgerTxKind.MANUAL_ADJUSTMENT,
  refType: 'MANUAL',
  refId: 'test',
  currency: 'NSP',
  entries,
  description: 'test posting',
  actor: SYSTEM_ACTOR,
});

/** Narrow an unknown thrown value to LedgerError and hand back its stable code. */
const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof LedgerError) return error.code;
    throw error;
  }
  throw new Error('expected the call to throw');
};

describe('assertZeroSum', () => {
  it('accepts entries that cancel exactly', () => {
    expect(() =>
      assertZeroSum(
        [
          { accountCode: ACCOUNT_A, amountMinor: 5_000n },
          { accountCode: ACCOUNT_B, amountMinor: -5_000n },
        ],
        'NSP',
      ),
    ).not.toThrow();
  });

  it('rejects a posting that is off by a single minor unit', () => {
    const code = codeOf(() =>
      assertZeroSum(
        [
          { accountCode: ACCOUNT_A, amountMinor: 5_000n },
          { accountCode: ACCOUNT_B, amountMinor: -4_999n },
        ],
        'NSP',
      ),
    );
    expect(code).toBe('LEDGER_UNBALANCED');
  });

  it('reports the actual imbalance in the error context', () => {
    try {
      assertZeroSum(
        [
          { accountCode: ACCOUNT_A, amountMinor: 100n },
          { accountCode: ACCOUNT_B, amountMinor: -70n },
        ],
        'NSP',
      );
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerError);
      expect((error as LedgerError).context['sumMinor']).toBe('30');
    }
  });

  it('balances across more than two sides', () => {
    expect(() =>
      assertZeroSum(
        [
          { accountCode: ACCOUNT_A, amountMinor: 10_000n },
          { accountCode: ACCOUNT_B, amountMinor: -3_000n },
          {
            accountCode: 'HOUSE_CASH:11111111-1111-4111-8111-111111111111:NSP',
            amountMinor: -7_000n,
          },
        ],
        'NSP',
      ),
    ).not.toThrow();
  });

  it('stays exact at magnitudes that would break a double', () => {
    // 2^53 + 1 minor units: a JS number cannot represent this, a bigint can.
    const huge = 9_007_199_254_740_993n;
    expect(() =>
      assertZeroSum(
        [
          { accountCode: ACCOUNT_A, amountMinor: huge },
          { accountCode: ACCOUNT_B, amountMinor: -huge },
        ],
        'NSP',
      ),
    ).not.toThrow();

    const code = codeOf(() =>
      assertZeroSum(
        [
          { accountCode: ACCOUNT_A, amountMinor: huge },
          { accountCode: ACCOUNT_B, amountMinor: -(huge - 1n) },
        ],
        'NSP',
      ),
    );
    expect(code).toBe('LEDGER_UNBALANCED');
  });
});

describe('assertEntryShape', () => {
  it('rejects an entry naming neither an account id nor a code', () => {
    expect(codeOf(() => assertEntryShape({ amountMinor: 1n } as PostingEntry, 0))).toBe(
      'LEDGER_MISSING_ACCOUNT_REF',
    );
  });

  it('rejects an entry naming both', () => {
    const both = {
      accountId: '11111111-1111-4111-8111-111111111111',
      accountCode: ACCOUNT_A,
      amountMinor: 1n,
    } as unknown as PostingEntry;
    expect(codeOf(() => assertEntryShape(both, 0))).toBe('LEDGER_MISSING_ACCOUNT_REF');
  });

  it('rejects a zero-amount entry', () => {
    expect(codeOf(() => assertEntryShape({ accountCode: ACCOUNT_A, amountMinor: 0n }, 3))).toBe(
      'LEDGER_ZERO_AMOUNT_ENTRY',
    );
  });
});

describe('assertValidPosting', () => {
  it('accepts a balanced two-sided posting', () => {
    expect(() =>
      assertValidPosting(
        posting([
          { accountCode: ACCOUNT_A, amountMinor: 250n },
          { accountCode: ACCOUNT_B, amountMinor: -250n },
        ]),
      ),
    ).not.toThrow();
  });

  it('rejects an empty posting', () => {
    expect(codeOf(() => assertValidPosting(posting([])))).toBe('LEDGER_EMPTY_POSTING');
  });

  it('rejects a single-sided posting, matching the database trigger', () => {
    expect(
      codeOf(() => assertValidPosting(posting([{ accountCode: ACCOUNT_A, amountMinor: 250n }]))),
    ).toBe('LEDGER_SINGLE_SIDED');
  });

  it('reports the bad entry before the imbalance it causes', () => {
    const code = codeOf(() =>
      assertValidPosting(
        posting([
          { accountCode: ACCOUNT_A, amountMinor: 250n },
          { amountMinor: -250n } as PostingEntry,
        ]),
      ),
    );
    expect(code).toBe('LEDGER_MISSING_ACCOUNT_REF');
  });
});

describe('netByAccountRef', () => {
  it('nets multiple entries on one account so the sign guard judges the end state', () => {
    const net = netByAccountRef([
      { accountCode: ACCOUNT_A, amountMinor: 900n },
      { accountCode: ACCOUNT_A, amountMinor: -400n },
      { accountCode: ACCOUNT_B, amountMinor: -500n },
    ]);
    expect(net.get(ACCOUNT_A)).toBe(500n);
    expect(net.get(ACCOUNT_B)).toBe(-500n);
  });
});
