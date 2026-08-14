/**
 * Domain codes and tuning constants for payment methods, destinations and the rotation.
 */
import type { AdminRole } from '@prisma/client';

export const PaymentMethodErrorCodes = {
  PAYMENT_METHOD_NOT_FOUND: 'PAYMENT_METHOD_NOT_FOUND',
  PAYMENT_METHOD_INACTIVE: 'PAYMENT_METHOD_INACTIVE',
  PAYMENT_METHOD_ALREADY_EXISTS: 'PAYMENT_METHOD_ALREADY_EXISTS',
  PAYMENT_METHOD_INVALID: 'PAYMENT_METHOD_INVALID',

  DESTINATION_NOT_FOUND: 'DESTINATION_NOT_FOUND',
  DESTINATION_ALREADY_EXISTS: 'DESTINATION_ALREADY_EXISTS',
  /** Every destination for this method is inactive — a player cannot be told where to pay. */
  NO_DESTINATION_AVAILABLE: 'NO_DESTINATION_AVAILABLE',

  /** A rail with no driver (INTERNAL, or one not yet implemented). */
  RAIL_NOT_SUPPORTED: 'RAIL_NOT_SUPPORTED',
  SUBMISSION_INVALID: 'SUBMISSION_INVALID',
} as const;

export type PaymentMethodErrorCode =
  (typeof PaymentMethodErrorCodes)[keyof typeof PaymentMethodErrorCodes];

/**
 * How long a player keeps the same destination.
 *
 * WHY stickiness exists at all: a player who is told "pay to wallet A", pays, and then reopens the
 * app to upload the receipt must not be shown "pay to wallet B". They would reasonably believe they
 * had paid the wrong place — and support cannot disprove it. 24 hours comfortably covers the
 * pay-then-upload gap, including someone who pays at night and uploads the next morning.
 */
export const DESTINATION_STICKY_TTL_SECONDS = 24 * 60 * 60;

export const destinationStickyKey = (paymentMethodId: string, playerId: string): string =>
  `paydest:sticky:${paymentMethodId}:${playerId}`;

/**
 * Rotation cursor per method. A monotonic counter, not a random draw: random selection clumps, and
 * a destination that receives three times its share on a quiet morning can hit a bank's daily
 * ingress limit that the weights were chosen to respect.
 */
export const destinationRotationKey = (paymentMethodId: string): string =>
  `paydest:rotation:${paymentMethodId}`;

/**
 * `priority` is "lower is offered first". Weight must therefore INVERT it, and the span bounds how
 * lopsided the split can get: with priorities 0 and 4, weights are 5 and 1.
 */
export const MAX_ROTATION_WEIGHT = 16;

/** Roles allowed to configure payment methods and destinations. */
export const PAYMENT_METHOD_MANAGER_ROLES: readonly AdminRole[] = Object.freeze([
  'SUPER_ADMIN',
  'FINANCE_ADMIN',
]);

/** Roles allowed to read the configuration, including inactive rows. */
export const PAYMENT_METHOD_READER_ROLES: readonly AdminRole[] = Object.freeze([
  'SUPER_ADMIN',
  'FINANCE_ADMIN',
  'REVIEWER',
  'SUPPORT',
]);
