import type { PaymentRail } from '@prisma/client';

import { BankTransferDriver } from './bank-transfer.driver';
import { CashAgentDriver } from './cash-agent.driver';
import { CryptoManualDriver } from './crypto-manual.driver';
import { EwalletDriver } from './ewallet.driver';
import { RailDriverRegistry } from './driver-registry';
import {
  RailIssueCodes,
  type RailDriver,
  type RailMethodConfig,
  type RailSubmission,
  type RailValidation,
} from './rail.interface';
import { BusinessRuleError } from '@common/exceptions/app.exception';

function methodConfig(overrides: Partial<RailMethodConfig> = {}): RailMethodConfig {
  return {
    code: 'TEST_METHOD',
    rail: 'BANK_TRANSFER',
    displayName: 'Test Bank',
    currencyCode: 'NSP',
    verificationMode: 'MANUAL_PROOF',
    minAmountMinor: 10_000n,
    maxAmountMinor: 1_000_000n,
    requiresReference: false,
    referencePattern: null,
    instructions: null,
    ...overrides,
  };
}

function submission(overrides: Partial<RailSubmission> = {}): RailSubmission {
  return {
    method: methodConfig(),
    destination: {
      label: 'Main Bank',
      accountIdentifier: 'SY00 1234 5678',
      accountHolder: 'Cashier Ltd',
      notes: null,
    },
    amountMinor: 50_000n,
    externalReference: 'TXN-12345',
    senderAccount: '0955123456',
    proofCount: 1,
    ...overrides,
  };
}

const issueCodes = (result: RailValidation): string[] =>
  result.ok ? [] : result.issues.map((issue) => issue.code);

/**
 * The four rails, with what each one demands as PROOF. The booleans are asserted against
 * `requiredProofFields` below rather than merely trusted, so a driver that gains or loses a field
 * without updating this table fails here instead of silently skipping its own stage tests.
 */
interface RailCase {
  readonly name: string;
  readonly driver: RailDriver;
  readonly rail: PaymentRail;
  readonly needsReference: boolean;
  readonly needsSenderAccount: boolean;
  readonly needsReceiptImage: boolean;
}

const RAIL_CASES: readonly RailCase[] = [
  {
    name: 'bank transfer',
    driver: new BankTransferDriver(),
    rail: 'BANK_TRANSFER',
    needsReference: true,
    needsSenderAccount: true,
    needsReceiptImage: true,
  },
  {
    name: 'e-wallet',
    driver: new EwalletDriver(),
    rail: 'MOBILE_WALLET',
    needsReference: true,
    needsSenderAccount: true,
    needsReceiptImage: true,
  },
  {
    name: 'cash office',
    driver: new CashAgentDriver(),
    rail: 'CASH_OFFICE',
    // Cash has no originating account — see cash-agent.driver.ts.
    needsReference: true,
    needsSenderAccount: false,
    needsReceiptImage: true,
  },
  {
    name: 'crypto',
    driver: new CryptoManualDriver(),
    rail: 'CRYPTO',
    // Crypto identifies the payment by TX_HASH, not by the rail REFERENCE field.
    needsReference: false,
    needsSenderAccount: true,
    needsReceiptImage: true,
  },
];

/** Everything a player can possibly have when they OPEN a deposit: an amount and a destination. */
function openIntent(rail: PaymentRail, overrides: Partial<RailSubmission> = {}): RailSubmission {
  return {
    ...submission({ method: methodConfig({ rail }) }),
    externalReference: null,
    senderAccount: null,
    proofCount: 0,
    stage: 'CREATE',
    ...overrides,
  };
}

/** A complete claim: reference, sender and a receipt attached. */
function completeProof(rail: PaymentRail, overrides: Partial<RailSubmission> = {}): RailSubmission {
  return {
    ...submission({ method: methodConfig({ rail }) }),
    stage: 'SUBMIT',
    ...overrides,
  };
}

describe('rail drivers', () => {
  const bank = new BankTransferDriver();
  const ewallet = new EwalletDriver();
  const cash = new CashAgentDriver();
  const crypto = new CryptoManualDriver();

  describe('shared validation', () => {
    it('accepts a complete submission', () => {
      expect(bank.validateSubmission(submission())).toEqual({ ok: true });
    });

    it('enforces the method amount bounds', () => {
      expect(issueCodes(bank.validateSubmission(submission({ amountMinor: 9_999n })))).toContain(
        RailIssueCodes.AMOUNT_BELOW_MINIMUM,
      );
      expect(
        issueCodes(bank.validateSubmission(submission({ amountMinor: 1_000_001n }))),
      ).toContain(RailIssueCodes.AMOUNT_ABOVE_MAXIMUM);
    });

    it('accepts the exact boundaries', () => {
      expect(bank.validateSubmission(submission({ amountMinor: 10_000n })).ok).toBe(true);
      expect(bank.validateSubmission(submission({ amountMinor: 1_000_000n })).ok).toBe(true);
    });

    it('rejects a non-positive amount', () => {
      expect(issueCodes(bank.validateSubmission(submission({ amountMinor: 0n })))).toContain(
        RailIssueCodes.AMOUNT_NOT_POSITIVE,
      );
      expect(issueCodes(bank.validateSubmission(submission({ amountMinor: -1n })))).toContain(
        RailIssueCodes.AMOUNT_NOT_POSITIVE,
      );
    });

    it('reports a missing destination rather than rendering "pay to null"', () => {
      expect(issueCodes(bank.validateSubmission(submission({ destination: null })))).toContain(
        RailIssueCodes.DESTINATION_MISSING,
      );
    });

    it('requires the proof image every manual rail depends on', () => {
      expect(issueCodes(bank.validateSubmission(submission({ proofCount: 0 })))).toContain(
        RailIssueCodes.PROOF_REQUIRED,
      );
    });
  });

  describe('reference handling', () => {
    it('requires a reference when the rail asks for one', () => {
      expect(
        issueCodes(bank.validateSubmission(submission({ externalReference: '   ' }))),
      ).toContain(RailIssueCodes.REFERENCE_REQUIRED);
    });

    it('enforces the operator-configured pattern', () => {
      const method = methodConfig({ referencePattern: '^TXN-\\d{5}$' });
      expect(bank.validateSubmission(submission({ method })).ok).toBe(true);
      expect(
        issueCodes(bank.validateSubmission(submission({ method, externalReference: 'nope' }))),
      ).toContain(RailIssueCodes.REFERENCE_MALFORMED);
    });

    it('treats an UNCOMPILABLE operator pattern as no pattern instead of throwing', () => {
      // An admin's typo must fail the config, not every player's deposit with a 500.
      const method = methodConfig({ referencePattern: '([unclosed' });
      expect(() => bank.validateSubmission(submission({ method }))).not.toThrow();
      expect(bank.validateSubmission(submission({ method })).ok).toBe(true);
    });

    it('bounds the reference length BEFORE running the regex (ReDoS guard)', () => {
      // A catastrophic-backtracking pattern against a long attacker-controlled string would pin
      // the event loop of a single-threaded process. The length check must fire first.
      const method = methodConfig({ referencePattern: '^(a+)+$' });
      const evil = 'a'.repeat(5_000) + 'b';

      const started = Date.now();
      const result = bank.validateSubmission(submission({ method, externalReference: evil }));
      const elapsed = Date.now() - started;

      expect(issueCodes(result)).toContain(RailIssueCodes.REFERENCE_MALFORMED);
      expect(elapsed).toBeLessThan(250);
    });
  });

  describe('per-rail required fields', () => {
    it('asks a bank transfer for the sender account and name', () => {
      expect(bank.requiredProofFields).toEqual(
        expect.arrayContaining(['REFERENCE', 'SENDER_ACCOUNT', 'SENDER_NAME', 'RECEIPT_IMAGE']),
      );
      expect(issueCodes(bank.validateSubmission(submission({ senderAccount: '' })))).toContain(
        RailIssueCodes.SENDER_ACCOUNT_REQUIRED,
      );
    });

    it('does NOT ask a cash payment for a sender account — cash has none', () => {
      expect(cash.requiredProofFields).not.toContain('SENDER_ACCOUNT');
      const result = cash.validateSubmission(
        submission({ method: methodConfig({ rail: 'CASH_OFFICE' }), senderAccount: null }),
      );
      expect(issueCodes(result)).not.toContain(RailIssueCodes.SENDER_ACCOUNT_REQUIRED);
    });

    it('asks crypto for the network, because an address exists on several chains', () => {
      expect(crypto.requiredProofFields).toEqual(
        expect.arrayContaining(['TX_HASH', 'NETWORK', 'SENDER_ACCOUNT']),
      );
    });

    it('asks an e-wallet for the sending number', () => {
      expect(ewallet.requiredProofFields).toContain('SENDER_ACCOUNT');
    });
  });

  describe('tryAutoVerify', () => {
    it('returns null for every v1 rail — all are verified by a human', async () => {
      for (const driver of [bank, ewallet, cash, crypto]) {
        await expect(driver.tryAutoVerify(submission())).resolves.toBeNull();
      }
    });
  });

  describe('renderInstructions', () => {
    const input = {
      method: methodConfig(),
      destination: submission().destination,
      amountMinor: 50_000n,
      shortId: 'K7Q2ZP9V3M',
    };

    it('shows the amount, the destination and the reference', () => {
      const text = bank.renderInstructions(input);
      expect(text).toContain('500.00 NSP');
      expect(text).toContain('SY00 1234 5678');
      expect(text).toContain('K7Q2ZP9V3M');
    });

    it('appends operator copy without replacing the generated details', () => {
      const text = bank.renderInstructions({
        ...input,
        method: methodConfig({ instructions: 'Branch closes at 17:00.' }),
      });
      expect(text).toContain('Branch closes at 17:00.');
      expect(text).toContain('SY00 1234 5678');
    });

    it('degrades to a clear message when no destination is available', () => {
      const text = bank.renderInstructions({ ...input, destination: null });
      expect(text).toMatch(/no bank account is available/i);
    });

    it('warns crypto users about the network', () => {
      const text = crypto.renderInstructions({
        ...input,
        method: methodConfig({ rail: 'CRYPTO' }),
      });
      expect(text).toMatch(/network/i);
    });
  });
});

/**
 * THE STAGE SPLIT. Opening a deposit and proving one was paid are different questions, and the bug
 * these tests exist to prevent is answering the first with the second's rules: a receipt image
 * cannot exist before the deposit does, so a rail that demands one at CREATE can never be opened.
 *
 * Read the two blocks together — the CREATE block says what stops being required, the SUBMIT block
 * says, one field at a time, that nothing stopped being required THERE.
 */
describe('validation stages', () => {
  describe.each(RAIL_CASES)(
    '$name',
    ({ driver, rail, needsReference, needsSenderAccount, needsReceiptImage }) => {
      it('declares the proof fields this table assumes', () => {
        expect(driver.requiredProofFields.includes('REFERENCE')).toBe(needsReference);
        expect(driver.requiredProofFields.includes('SENDER_ACCOUNT')).toBe(needsSenderAccount);
        expect(driver.requiredProofFields.includes('RECEIPT_IMAGE')).toBe(needsReceiptImage);
      });

      // ── CREATE ───────────────────────────────────────────────────────────────────────────────

      it('CREATE accepts an amount and a destination and nothing else', () => {
        expect(driver.validateSubmission(openIntent(rail))).toEqual({ ok: true });
      });

      it('CREATE accepts an intent even when the method demands a reference', () => {
        // requiresReference is about the PROOF, not about permission to open the intent.
        const method = methodConfig({ rail, requiresReference: true });
        expect(driver.validateSubmission(openIntent(rail, { method }))).toEqual({ ok: true });
      });

      it('CREATE still rejects a zero amount', () => {
        expect(
          issueCodes(driver.validateSubmission(openIntent(rail, { amountMinor: 0n }))),
        ).toEqual([RailIssueCodes.AMOUNT_NOT_POSITIVE]);
      });

      it('CREATE still rejects an amount below the method minimum', () => {
        expect(
          issueCodes(driver.validateSubmission(openIntent(rail, { amountMinor: 9_999n }))),
        ).toEqual([RailIssueCodes.AMOUNT_BELOW_MINIMUM]);
      });

      it('CREATE still rejects an amount above the method maximum', () => {
        expect(
          issueCodes(driver.validateSubmission(openIntent(rail, { amountMinor: 1_000_001n }))),
        ).toEqual([RailIssueCodes.AMOUNT_ABOVE_MAXIMUM]);
      });

      it('CREATE still rejects a missing destination', () => {
        expect(
          issueCodes(driver.validateSubmission(openIntent(rail, { destination: null }))),
        ).toEqual([RailIssueCodes.DESTINATION_MISSING]);
      });

      it('CREATE rejects a MALFORMED reference when the player supplied one', () => {
        // Absence is fine at this stage; nonsense is not. A reference is stored on the row and a
        // partial unique index depends on it, so it has to be well-formed the moment it arrives.
        const method = methodConfig({ rail, referencePattern: '^TXN-\\d{5}$' });
        expect(
          issueCodes(
            driver.validateSubmission(openIntent(rail, { method, externalReference: 'nope' })),
          ),
        ).toEqual([RailIssueCodes.REFERENCE_MALFORMED]);
        expect(
          driver.validateSubmission(openIntent(rail, { method, externalReference: 'TXN-12345' }))
            .ok,
        ).toBe(true);
      });

      it('CREATE rejects an over-long sender account when the player supplied one', () => {
        const senderAccount = '9'.repeat(129);
        const codes = issueCodes(driver.validateSubmission(openIntent(rail, { senderAccount })));
        // Only rails that collect a sender account look at it at all. The code says MALFORMED:
        // a client renders the CODE, and "tell us which account you sent from" is the wrong thing
        // to show somebody who supplied one.
        expect(codes).toEqual(needsSenderAccount ? [RailIssueCodes.SENDER_ACCOUNT_MALFORMED] : []);
      });

      it('SUBMIT reports an over-long sender account as MALFORMED, never as REQUIRED', () => {
        const codes = issueCodes(
          driver.validateSubmission(completeProof(rail, { senderAccount: '9'.repeat(129) })),
        );
        expect(codes).toEqual(needsSenderAccount ? [RailIssueCodes.SENDER_ACCOUNT_MALFORMED] : []);
        expect(codes).not.toContain(RailIssueCodes.SENDER_ACCOUNT_REQUIRED);
      });

      // ── SUBMIT ───────────────────────────────────────────────────────────────────────────────

      it('SUBMIT accepts a complete claim', () => {
        expect(driver.validateSubmission(completeProof(rail))).toEqual({ ok: true });
      });

      it(`SUBMIT ${needsReference ? 'rejects' : 'allows'} a missing REFERENCE`, () => {
        const codes = issueCodes(
          driver.validateSubmission(completeProof(rail, { externalReference: '   ' })),
        );
        if (needsReference) expect(codes).toContain(RailIssueCodes.REFERENCE_REQUIRED);
        else expect(codes).not.toContain(RailIssueCodes.REFERENCE_REQUIRED);
      });

      it(`SUBMIT ${needsSenderAccount ? 'rejects' : 'allows'} a missing SENDER_ACCOUNT`, () => {
        const codes = issueCodes(
          driver.validateSubmission(completeProof(rail, { senderAccount: null })),
        );
        if (needsSenderAccount) expect(codes).toContain(RailIssueCodes.SENDER_ACCOUNT_REQUIRED);
        else expect(codes).not.toContain(RailIssueCodes.SENDER_ACCOUNT_REQUIRED);
      });

      it(`SUBMIT ${needsReceiptImage ? 'rejects' : 'allows'} a RECEIPT_IMAGE that is not attached`, () => {
        const codes = issueCodes(driver.validateSubmission(completeProof(rail, { proofCount: 0 })));
        if (needsReceiptImage) expect(codes).toContain(RailIssueCodes.PROOF_REQUIRED);
        else expect(codes).not.toContain(RailIssueCodes.PROOF_REQUIRED);
      });

      it('SUBMIT still enforces the amount bounds and the destination', () => {
        const codes = issueCodes(
          driver.validateSubmission(
            completeProof(rail, { amountMinor: 9_999n, destination: null }),
          ),
        );
        expect(codes).toEqual(
          expect.arrayContaining([
            RailIssueCodes.AMOUNT_BELOW_MINIMUM,
            RailIssueCodes.DESTINATION_MISSING,
          ]),
        );
      });

      // ── the default ──────────────────────────────────────────────────────────────────────────

      it('FAILS CLOSED: omitting the stage behaves exactly like SUBMIT', () => {
        const bare: RailSubmission = {
          method: methodConfig({ rail, requiresReference: true }),
          destination: submission().destination,
          amountMinor: 50_000n,
          proofCount: 0,
        };
        expect('stage' in bare).toBe(false);

        const explicit = driver.validateSubmission({ ...bare, stage: 'SUBMIT' });
        expect(driver.validateSubmission(bare)).toEqual(explicit);
        // And that is the STRICT answer, not the permissive one.
        expect(explicit.ok).toBe(false);
        expect(issueCodes(explicit)).toContain(RailIssueCodes.REFERENCE_REQUIRED);
      });

      it('FAILS CLOSED: a stage value outside the union is treated as SUBMIT, not as CREATE', () => {
        const bare = {
          method: methodConfig({ rail, requiresReference: true }),
          destination: submission().destination,
          amountMinor: 50_000n,
          proofCount: 0,
        };
        // The cast is the point of the test: `stage` crosses a JSON boundary in the port, and a
        // typo or an injected value must not switch the evidence gate off. Only a literal 'CREATE'
        // may do that.
        for (const smuggled of ['create', 'CREATE ', '', 'SUBMIT_BUT_NOT_REALLY']) {
          const result = driver.validateSubmission({
            ...bare,
            stage: smuggled,
          } as unknown as RailSubmission);
          expect(result).toEqual(driver.validateSubmission({ ...bare, stage: 'SUBMIT' }));
          expect(result.ok).toBe(false);
        }
      });
    },
  );
});

describe('RailDriverRegistry', () => {
  const registry = new RailDriverRegistry(
    new BankTransferDriver(),
    new EwalletDriver(),
    new CashAgentDriver(),
    new CryptoManualDriver(),
  );

  it('resolves each implemented rail to its own driver', () => {
    expect(registry.get('BANK_TRANSFER')).toBeInstanceOf(BankTransferDriver);
    expect(registry.get('MOBILE_WALLET')).toBeInstanceOf(EwalletDriver);
    expect(registry.get('CASH_OFFICE')).toBeInstanceOf(CashAgentDriver);
    expect(registry.get('CRYPTO')).toBeInstanceOf(CryptoManualDriver);
  });

  it('has no driver for INTERNAL, by design', () => {
    // INTERNAL is for corrections that never touched a payment network: no player, no receipt.
    expect(registry.find('INTERNAL')).toBeUndefined();
    expect(() => registry.get('INTERNAL')).toThrow(BusinessRuleError);
  });

  it('lists exactly the four player-facing rails', () => {
    expect(registry.supportedRails().sort()).toEqual([
      'BANK_TRANSFER',
      'CASH_OFFICE',
      'CRYPTO',
      'MOBILE_WALLET',
    ]);
  });

  it('refuses to boot if two drivers claim the same rail', () => {
    expect(
      () =>
        new RailDriverRegistry(
          new BankTransferDriver(),
          new EwalletDriver(),
          new CashAgentDriver(),
          // A second driver claiming BANK_TRANSFER; without the guard the winner would depend on
          // provider order.
          new BankTransferDriver() as unknown as CryptoManualDriver,
        ),
    ).toThrow(/claim/i);
  });
});
