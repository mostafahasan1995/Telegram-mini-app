/**
 * The payment rails an operator starts with, and the one function that writes them.
 *
 * WHY IN core AND WITHOUT NEST: two callers write rails and neither may import the other. The seed
 * (prisma/seed/payment-method.seed.ts) runs outside Nest for the bootstrap operator, and tenant
 * creation (modules/tenant) provisions a new operator's rails. A module may not import another
 * module, and the seed must not drag in the DI graph, so the rails and their writer live here and
 * take a plain Prisma client.
 *
 * WHICH RAILS: the dashboard's mock provisions four for a new operator, "bank, e-wallet, Sham Cash,
 * Syriatel" (manager-account-dashboard src/mocks/db.ts, DEFAULT_RAIL_COUNT), and the contract's
 * `paymentMethodsCreated` reports that number. The bootstrap seed keeps its original two (bank and
 * e-wallet): existing deployments and the composition suite were built on exactly those, and adding
 * rails to a live operator on a redeploy is a decision for that operator, not for a seed.
 *
 * EVERY DESTINATION IS A PLACEHOLDER. `SEED-PLACEHOLDER-…`, account holder `REPLACE ME`. The contract
 * calls this out as the field to act on (`paymentMethodsNeedAccounts`): a player who pays into one has
 * sent money to a string that is not an account. The rows exist so the operator has something to
 * edit, never so a player has somewhere to pay.
 *
 * IDEMPOTENT: `(tenantId, code)` and `(paymentMethodId, accountIdentifier)` are unique, so every write
 * is an upsert keyed on something stable. Amount limits and instructions are configuration and are
 * refreshed on a re-run; `isActive`, `priority` and anything about a destination are not, because an
 * operator who changed them did it on purpose.
 *
 * TENANT ID IS ALWAYS EXPLICIT. The tenant-scope Prisma extension never injects a tenant into a
 * create, and it rewrites a filtered read to the AMBIENT tenant, which during tenant creation is
 * tenant zero. So every row and every filter here names the operator it is for.
 */
import { PaymentRail, VerificationMode, type PrismaClient } from '@prisma/client';

export const BANK_TRANSFER_CODE = 'BANK_TRANSFER_MAIN';
export const EWALLET_CODE = 'EWALLET_MAIN';
export const SHAMCASH_CODE = 'SHAMCASH_MAIN';
export const SYRIATEL_CASH_CODE = 'SYRIATEL_CASH';

/** The prefix every placeholder account identifier carries, so one grep finds what must be fixed. */
export const PLACEHOLDER_ACCOUNT_PREFIX = 'SEED-PLACEHOLDER';
export const PLACEHOLDER_ACCOUNT_HOLDER = 'REPLACE ME';

/** 5,000.00 in a two-decimal currency: below this the manual review costs more than the deposit. */
const MIN_AMOUNT_MINOR = 500_000n;
/** 5,000,000.00 in a two-decimal currency. */
const MAX_AMOUNT_MINOR = 500_000_000n;

export interface PaymentMethodSpec {
  code: string;
  displayName: string;
  rail: PaymentRail;
  sortOrder: number;
  requiresReference: boolean;
  referencePattern: string | null;
  instructions: string;
  destination: {
    label: string;
    accountIdentifier: string;
    accountHolder: string;
  };
}

const BANK_TRANSFER: PaymentMethodSpec = {
  code: BANK_TRANSFER_CODE,
  displayName: 'Bank transfer',
  rail: PaymentRail.BANK_TRANSFER,
  sortOrder: 10,
  // A bank gives the payer a reference; asking for it makes a manual match far quicker.
  requiresReference: true,
  // Bounded and anchored: this pattern is run against player input by the rail driver.
  referencePattern: '^[A-Za-z0-9-]{6,32}$',
  instructions:
    'Transfer the exact amount to the account shown, then upload a photo of the receipt. ' +
    'Enter the bank reference number from the receipt.',
  destination: {
    label: 'Main bank account',
    accountIdentifier: `${PLACEHOLDER_ACCOUNT_PREFIX}-BANK-0000`,
    accountHolder: PLACEHOLDER_ACCOUNT_HOLDER,
  },
};

const EWALLET: PaymentMethodSpec = {
  code: EWALLET_CODE,
  displayName: 'E-wallet',
  rail: PaymentRail.MOBILE_WALLET,
  sortOrder: 20,
  // Wallet receipts vary too much between providers to demand a reference in v1.
  requiresReference: false,
  referencePattern: null,
  instructions:
    'Send the exact amount to the wallet number shown, then upload a screenshot of the ' +
    'confirmation message.',
  destination: {
    label: 'Main wallet',
    accountIdentifier: `${PLACEHOLDER_ACCOUNT_PREFIX}-WALLET-0000`,
    accountHolder: PLACEHOLDER_ACCOUNT_HOLDER,
  },
};

const SHAMCASH: PaymentMethodSpec = {
  code: SHAMCASH_CODE,
  displayName: 'Sham Cash',
  // Sham Cash is a wallet app; the rail enum has no provider-specific value, and it needs none.
  rail: PaymentRail.MOBILE_WALLET,
  sortOrder: 30,
  requiresReference: false,
  referencePattern: null,
  instructions:
    'Send the exact amount to the Sham Cash account shown, then upload a screenshot of the ' +
    'transfer confirmation.',
  destination: {
    label: 'Main Sham Cash account',
    accountIdentifier: `${PLACEHOLDER_ACCOUNT_PREFIX}-SHAMCASH-0000`,
    accountHolder: PLACEHOLDER_ACCOUNT_HOLDER,
  },
};

const SYRIATEL_CASH: PaymentMethodSpec = {
  code: SYRIATEL_CASH_CODE,
  displayName: 'Syriatel Cash',
  rail: PaymentRail.MOBILE_WALLET,
  sortOrder: 40,
  requiresReference: false,
  referencePattern: null,
  instructions:
    'Send the exact amount to the Syriatel Cash number shown, then upload a screenshot of the ' +
    'confirmation message.',
  destination: {
    label: 'Main Syriatel Cash number',
    accountIdentifier: `${PLACEHOLDER_ACCOUNT_PREFIX}-SYRIATEL-0000`,
    accountHolder: PLACEHOLDER_ACCOUNT_HOLDER,
  },
};

/** What a NEW operator is provisioned with: the dashboard mock's four rails, in its order. */
export const OPERATOR_DEFAULT_PAYMENT_METHODS: readonly PaymentMethodSpec[] = Object.freeze([
  BANK_TRANSFER,
  EWALLET,
  SHAMCASH,
  SYRIATEL_CASH,
]);

/** What the bootstrap seed has always written for the legacy operator. See the header for why two. */
export const BOOTSTRAP_SEED_PAYMENT_METHODS: readonly PaymentMethodSpec[] = Object.freeze([
  BANK_TRANSFER,
  EWALLET,
]);

export interface EnsuredPaymentMethod {
  id: string;
  code: string;
  /** False when a method with this code already existed for the operator. */
  created: boolean;
  /** True while an ACTIVE destination of this method still points at a placeholder account. */
  destinationIsPlaceholder: boolean;
}

/**
 * The two delegates this needs. A structural type rather than PrismaClient, so the seed's client, the
 * app's PrismaService and a transaction client are all accepted.
 */
export type PaymentMethodWriter = Pick<PrismaClient, 'paymentMethod' | 'paymentDestination'>;

export async function ensurePaymentMethods(
  db: PaymentMethodWriter,
  tenantId: string,
  currencyCode: string,
  specs: readonly PaymentMethodSpec[],
): Promise<EnsuredPaymentMethod[]> {
  const existing = await db.paymentMethod.findMany({
    where: { tenantId, code: { in: specs.map((spec) => spec.code) } },
    select: { code: true },
  });
  const existingCodes = new Set(existing.map((row) => row.code));

  const results: EnsuredPaymentMethod[] = [];
  for (const spec of specs) {
    const method = await db.paymentMethod.upsert({
      where: { tenantId_code: { tenantId, code: spec.code } },
      create: {
        tenantId,
        code: spec.code,
        displayName: spec.displayName,
        rail: spec.rail,
        currencyCode,
        verificationMode: VerificationMode.MANUAL_PROOF,
        isActive: true,
        sortOrder: spec.sortOrder,
        minAmountMinor: MIN_AMOUNT_MINOR,
        maxAmountMinor: MAX_AMOUNT_MINOR,
        feeFixedMinor: 0n,
        feeBps: 0,
        requiresReference: spec.requiresReference,
        referencePattern: spec.referencePattern,
        instructions: spec.instructions,
      },
      update: {
        // Configuration that a re-run is allowed to refresh. `isActive` is NOT here: turning a rail
        // off is an operational decision nothing automatic may silently reverse.
        displayName: spec.displayName,
        rail: spec.rail,
        verificationMode: VerificationMode.MANUAL_PROOF,
        sortOrder: spec.sortOrder,
        minAmountMinor: MIN_AMOUNT_MINOR,
        maxAmountMinor: MAX_AMOUNT_MINOR,
        requiresReference: spec.requiresReference,
        referencePattern: spec.referencePattern,
        instructions: spec.instructions,
      },
      select: { id: true, code: true },
    });

    await db.paymentDestination.upsert({
      where: {
        paymentMethodId_accountIdentifier: {
          paymentMethodId: method.id,
          accountIdentifier: spec.destination.accountIdentifier,
        },
      },
      create: {
        // The method's operator, never the ambient one: a destination on a different operator than
        // its rail would take a player's money to the wrong bank.
        tenantId,
        paymentMethodId: method.id,
        label: spec.destination.label,
        accountIdentifier: spec.destination.accountIdentifier,
        accountHolder: spec.destination.accountHolder,
        isActive: true,
        priority: 0,
        // No soft cap: caps rotate between destinations, and there is only one.
        dailyCapMinor: null,
        notes: 'A placeholder. Replace it with a real account before taking deposits.',
      },
      // Nothing is refreshed: an operator editing an account number, a label or the active flag is
      // the one case where the database is more correct than this file.
      update: {},
    });

    // A real destination may have been added later; only an active placeholder is a warning.
    const activePlaceholders = await db.paymentDestination.count({
      where: {
        tenantId,
        paymentMethodId: method.id,
        isActive: true,
        accountIdentifier: { startsWith: PLACEHOLDER_ACCOUNT_PREFIX },
      },
    });

    results.push({
      id: method.id,
      code: method.code,
      created: !existingCodes.has(method.code),
      destinationIsPlaceholder: activePlaceholders > 0,
    });
  }

  return results;
}
