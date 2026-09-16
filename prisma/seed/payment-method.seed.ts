/**
 * Two rails, both manual, so a fresh install has a working deposit flow end to end: one bank
 * transfer and one e-wallet. `VerificationMode.MANUAL_PROOF` for both — v1 has no statement
 * ingestion, and `PaymentGatewayService.tryAutoVerify()` returns null for every rail on purpose.
 *
 * READ THIS BEFORE POINTING A REAL PLAYER AT A SEEDED ENVIRONMENT:
 * the destinations carry PLACEHOLDER account identifiers. They exist so the mini-app has something
 * to render and the review queue has something to review. A player who pays into
 * "SEED-PLACEHOLDER-…" has sent money nowhere. Replace them through
 * `POST /v1/admin/payment-methods/:id/destinations` before taking real deposits; the seed prints a
 * warning saying exactly that, and re-running it never overwrites a destination you have edited.
 *
 * WHOSE RAILS THESE ARE: the bootstrap operator's. A payment method is an operator's own bank
 * account, not the platform's — nobody pays into tenant zero — so these belong to the tenant that
 * was already taking deposits, never to the tenant that holds the platform logins.
 *
 * WHERE THE RAILS ARE DEFINED: src/core/payment-rails/default-payment-methods.ts, shared with tenant
 * creation, which provisions a new operator's rails through the same writer. This seed keeps its
 * original two; see that file for why a new operator gets four.
 */
import { type PrismaClient } from '@prisma/client';

import {
  BOOTSTRAP_SEED_PAYMENT_METHODS,
  ensurePaymentMethods,
} from '@core/payment-rails/default-payment-methods';
import { TENANT_BOOTSTRAP_ID } from '@core/tenant/tenant.constants';

export { BANK_TRANSFER_CODE, EWALLET_CODE } from '@core/payment-rails/default-payment-methods';

export interface SeededPaymentMethod {
  id: string;
  code: string;
  destinationIsPlaceholder: boolean;
}

export async function seedPaymentMethods(
  prisma: PrismaClient,
  currencyCode: string,
): Promise<SeededPaymentMethod[]> {
  const ensured = await ensurePaymentMethods(
    prisma,
    TENANT_BOOTSTRAP_ID,
    currencyCode,
    BOOTSTRAP_SEED_PAYMENT_METHODS,
  );
  return ensured.map(({ id, code, destinationIsPlaceholder }) => ({
    id,
    code,
    destinationIsPlaceholder,
  }));
}
