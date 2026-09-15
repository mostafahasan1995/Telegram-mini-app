import {
  BOOTSTRAP_SEED_PAYMENT_METHODS,
  OPERATOR_DEFAULT_PAYMENT_METHODS,
  PLACEHOLDER_ACCOUNT_PREFIX,
  ensurePaymentMethods,
  type PaymentMethodWriter,
} from './default-payment-methods';

const TENANT_ID = '22222222-2222-4222-8222-222222222222';

function fakeDb(existingCodes: string[]) {
  const findMany = jest.fn().mockResolvedValue(existingCodes.map((code) => ({ code })));
  const methodUpsert = jest.fn((args: { create: { code: string } }) =>
    Promise.resolve({ id: `method-${args.create.code}`, code: args.create.code }),
  );
  const destinationUpsert = jest.fn().mockResolvedValue({ id: 'destination' });
  const count = jest.fn().mockResolvedValue(1);
  const db = {
    paymentMethod: { findMany, upsert: methodUpsert },
    paymentDestination: { upsert: destinationUpsert, count },
  };
  return { db: db as unknown as PaymentMethodWriter, findMany, methodUpsert, destinationUpsert, count };
}

describe('ensurePaymentMethods', () => {
  it('provisions the dashboard’s four rails for a new operator: bank, e-wallet, Sham Cash, Syriatel', () => {
    expect(OPERATOR_DEFAULT_PAYMENT_METHODS.map((spec) => spec.code)).toEqual([
      'BANK_TRANSFER_MAIN',
      'EWALLET_MAIN',
      'SHAMCASH_MAIN',
      'SYRIATEL_CASH',
    ]);
    // The bootstrap seed keeps the two it always wrote.
    expect(BOOTSTRAP_SEED_PAYMENT_METHODS.map((spec) => spec.code)).toEqual([
      'BANK_TRANSFER_MAIN',
      'EWALLET_MAIN',
    ]);
    for (const spec of OPERATOR_DEFAULT_PAYMENT_METHODS) {
      expect(spec.destination.accountIdentifier.startsWith(PLACEHOLDER_ACCOUNT_PREFIX)).toBe(true);
      expect(spec.destination.accountHolder).toBe('REPLACE ME');
    }
  });

  it('names the operator on every row and every filter, never relying on the ambient tenant', async () => {
    const h = fakeDb([]);

    const result = await ensurePaymentMethods(h.db, TENANT_ID, 'NSP', OPERATOR_DEFAULT_PAYMENT_METHODS);

    expect(h.findMany.mock.calls[0]?.[0]).toMatchObject({ where: { tenantId: TENANT_ID } });
    for (const [args] of h.methodUpsert.mock.calls) {
      expect(args).toMatchObject({
        where: { tenantId_code: { tenantId: TENANT_ID } },
        create: { tenantId: TENANT_ID, currencyCode: 'NSP', verificationMode: 'MANUAL_PROOF' },
      });
    }
    for (const call of h.destinationUpsert.mock.calls) {
      expect(call[0]).toMatchObject({ create: { tenantId: TENANT_ID } });
    }
    for (const call of h.count.mock.calls) {
      expect(call[0]).toMatchObject({ where: { tenantId: TENANT_ID, isActive: true } });
    }
    expect(result).toHaveLength(4);
    expect(result.every((row) => row.created && row.destinationIsPlaceholder)).toBe(true);
  });

  it('reports a method that already existed as not created', async () => {
    const h = fakeDb(['BANK_TRANSFER_MAIN']);
    const result = await ensurePaymentMethods(h.db, TENANT_ID, 'NSP', BOOTSTRAP_SEED_PAYMENT_METHODS);
    expect(result.map((row) => [row.code, row.created])).toEqual([
      ['BANK_TRANSFER_MAIN', false],
      ['EWALLET_MAIN', true],
    ]);
  });
});
