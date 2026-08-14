/**
 * Two rails, both manual, so a fresh install has a working deposit flow end to end: one bank
 * transfer and one e-wallet. `VerificationMode.MANUAL_PROOF` for both — v1 has no statement
 * ingestion, and `PaymentGatewayService.tryAutoVerify()` returns null for every rail on purpose.
 *
 * READ THIS BEFORE POINTING A REAL PLAYER AT A SEEDED ENVIRONMENT:
 * the destinations below carry PLACEHOLDER account identifiers. They exist so the mini-app has
 * something to render and the review queue has something to review. A player who pays into
 * "SEED-PLACEHOLDER-…" has sent money nowhere. Replace them through
 * `POST /v1/admin/payment-methods/:id/destinations` before taking real deposits; the seed prints a
 * warning saying exactly that, and re-running it never overwrites a destination you have edited.
 *
 * Idempotency: `code` and `(paymentMethodId, accountIdentifier)` are unique, so every write here is
 * an upsert keyed on something stable. Amount limits and instructions ARE refreshed on re-run
 * (they are configuration); `isActive` and `priority` are NOT, because an operator who deactivated
 * a destination did it for a reason and a redeploy must not undo that.
 */
import { PaymentRail, VerificationMode, type PrismaClient } from '@prisma/client';

export const BANK_TRANSFER_CODE = 'BANK_TRANSFER_MAIN';
export const EWALLET_CODE = 'EWALLET_MAIN';

/** 5,000.00 NSP — below this the manual review effort costs more than the deposit. */
const MIN_AMOUNT_MINOR = 500_000n;
/** 5,000,000.00 NSP. */
const MAX_AMOUNT_MINOR = 500_000_000n;

const PLACEHOLDER_PREFIX = 'SEED-PLACEHOLDER';

interface MethodSpec {
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

const METHODS: readonly MethodSpec[] = [
  {
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
      accountIdentifier: `${PLACEHOLDER_PREFIX}-BANK-0000`,
      accountHolder: 'REPLACE ME',
    },
  },
  {
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
      accountIdentifier: `${PLACEHOLDER_PREFIX}-WALLET-0000`,
      accountHolder: 'REPLACE ME',
    },
  },
];

export interface SeededPaymentMethod {
  id: string;
  code: string;
  destinationIsPlaceholder: boolean;
}

export async function seedPaymentMethods(
  prisma: PrismaClient,
  currencyCode: string,
): Promise<SeededPaymentMethod[]> {
  const results: SeededPaymentMethod[] = [];

  for (const spec of METHODS) {
    const method = await prisma.paymentMethod.upsert({
      where: { code: spec.code },
      create: {
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
        // Configuration that a redeploy is allowed to refresh. `isActive` is NOT here: turning a
        // rail off is an operational decision the seed must not silently reverse.
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

    await prisma.paymentDestination.upsert({
      where: {
        paymentMethodId_accountIdentifier: {
          paymentMethodId: method.id,
          accountIdentifier: spec.destination.accountIdentifier,
        },
      },
      create: {
        paymentMethodId: method.id,
        label: spec.destination.label,
        accountIdentifier: spec.destination.accountIdentifier,
        accountHolder: spec.destination.accountHolder,
        isActive: true,
        priority: 0,
        // No soft cap on a seed destination: caps are a rotation tool and there is nothing to
        // rotate between until a second destination exists.
        dailyCapMinor: null,
        notes: 'Created by the seed. Replace with a real account before taking deposits.',
      },
      // Nothing is refreshed: an operator editing an account number, a label or the active flag is
      // the one case where the database is more correct than this file.
      update: {},
    });

    // A real destination may have been added later; only the placeholder itself is a warning.
    const activePlaceholders = await prisma.paymentDestination.count({
      where: {
        paymentMethodId: method.id,
        isActive: true,
        accountIdentifier: { startsWith: PLACEHOLDER_PREFIX },
      },
    });

    results.push({
      id: method.id,
      code: method.code,
      destinationIsPlaceholder: activePlaceholders > 0,
    });
  }

  return results;
}
