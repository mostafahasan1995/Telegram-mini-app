/**
 * Chooses which of a method's destinations a given player should pay into.
 *
 * Three properties, in priority order — later ones may never break earlier ones:
 *
 *  1. STICKY PER PLAYER FOR 24 HOURS. A player told "pay to wallet A", who pays and comes back an
 *     hour later to upload the receipt, must still see wallet A. Showing them wallet B would make
 *     them believe they paid the wrong place, and we could not prove otherwise.
 *  2. WEIGHTED ROTATION. Volume is spread across destinations in proportion to their weight, so no
 *     single account absorbs a day's ingress and trips a bank limit.
 *  3. SOFT DAILY CAPS. A destination over its `dailyCapMinor` steps aside — unless they ALL have,
 *     in which case the cap is ignored rather than leaving the player with nowhere to pay. The
 *     schema calls this a soft cap and it is treated as one.
 *
 * WHY a monotonic counter instead of a weighted random draw: random selection clumps. Over a quiet
 * morning of twenty deposits, one destination can easily take three times its intended share — and
 * the caps in (3) exist precisely because that matters. A counter gives the exact ratio.
 *
 * WHY the sticky key is written with SET NX and the loser re-reads: two deposits opened in two tabs
 * at the same instant would otherwise be handed different destinations, which is the very confusion
 * (1) exists to prevent. NX makes one of them win and the other adopt the winner's answer.
 *
 * WHY stickiness is NOT refreshed on every read: a sliding window would pin a frequent depositor to
 * one destination forever, defeating (2) exactly for the players who move the most money.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { PaymentDestination } from '@prisma/client';

import { RedisService } from '@core/cache/redis.service';
import { BusinessRuleError } from '@common/exceptions/app.exception';

import {
  DESTINATION_STICKY_TTL_SECONDS,
  MAX_ROTATION_WEIGHT,
  PaymentMethodErrorCodes,
  destinationRotationKey,
  destinationStickyKey,
} from '../payment-method.constants';
import { PaymentDestinationRepository } from '../repositories/payment-destination.repository';

interface WeightedDestination {
  destination: PaymentDestination;
  weight: number;
}

@Injectable()
export class DestinationPickerService {
  private readonly logger = new Logger(DestinationPickerService.name);

  constructor(
    private readonly destinations: PaymentDestinationRepository,
    private readonly redis: RedisService,
  ) {}

  /**
   * The destination this player should use for this method right now.
   * Throws 422 NO_DESTINATION_AVAILABLE when the method has no active destination at all — that is
   * a configuration failure and must be loud, not silently papered over.
   */
  async pickFor(paymentMethodId: string, playerId: string): Promise<PaymentDestination> {
    const candidates = await this.destinations.listForMethod(paymentMethodId, true);
    if (candidates.length === 0) {
      throw new BusinessRuleError(
        PaymentMethodErrorCodes.NO_DESTINATION_AVAILABLE,
        'This payment method is temporarily unavailable. Please choose another one.',
        { paymentMethodId },
      );
    }

    const stickyKey = destinationStickyKey(paymentMethodId, playerId);

    const remembered = await this.readSticky(stickyKey, candidates);
    if (remembered !== null) return remembered;

    const chosen = await this.rotate(paymentMethodId, candidates);

    // NX: whoever writes first owns this player's 24 hours.
    const claimed = await this.redis
      .set(stickyKey, chosen.id, 'EX', DESTINATION_STICKY_TTL_SECONDS, 'NX')
      .catch((error: unknown) => {
        // Redis being down must not stop a player depositing; they simply lose stickiness.
        this.logger.error(
          `Could not persist destination stickiness for player ${playerId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return 'OK';
      });

    if (claimed === 'OK') return chosen;

    // Someone beat us to it in the last few milliseconds. Their choice is the one the player may
    // already have been shown.
    const winner = await this.readSticky(stickyKey, candidates);
    return winner ?? chosen;
  }

  /** The remembered destination, or null when there is none or it is no longer offerable. */
  async peekSticky(paymentMethodId: string, playerId: string): Promise<PaymentDestination | null> {
    const candidates = await this.destinations.listForMethod(paymentMethodId, true);
    return this.readSticky(destinationStickyKey(paymentMethodId, playerId), candidates);
  }

  /**
   * Forgets a player's assignment. For support: "they were given a wallet we have since retired".
   */
  async clearSticky(paymentMethodId: string, playerId: string): Promise<void> {
    await this.redis.del(destinationStickyKey(paymentMethodId, playerId));
  }

  private async readSticky(
    key: string,
    candidates: readonly PaymentDestination[],
  ): Promise<PaymentDestination | null> {
    let stored: string | null;
    try {
      stored = await this.redis.get(key);
    } catch (error: unknown) {
      this.logger.error(
        `Could not read destination stickiness: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
    if (stored === null) return null;

    // Re-validated against the CURRENT candidate list: a destination deactivated since the sticky
    // was written must not be handed out for the rest of its 24 hours.
    return candidates.find((candidate) => candidate.id === stored) ?? null;
  }

  /** Weighted round-robin over the cap-eligible candidates. */
  private async rotate(
    paymentMethodId: string,
    candidates: readonly PaymentDestination[],
  ): Promise<PaymentDestination> {
    const eligible = await this.applySoftCaps(candidates);
    const weighted = eligible.map((destination) => ({
      destination,
      weight: this.weightOf(destination),
    }));

    const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
    const first = weighted[0];
    // Defensive: weightOf() has a floor of 1, so this cannot be reached with a non-empty list.
    if (first === undefined || totalWeight <= 0) {
      const fallback = candidates[0];
      if (fallback === undefined) {
        throw new BusinessRuleError(
          PaymentMethodErrorCodes.NO_DESTINATION_AVAILABLE,
          'This payment method is temporarily unavailable. Please choose another one.',
        );
      }
      return fallback;
    }

    const cursor = await this.nextCursor(paymentMethodId);
    return this.atWeightedIndex(weighted, cursor % totalWeight, first.destination);
  }

  /**
   * Drops destinations that are over today's soft cap. If that would leave nobody, the caps are
   * ignored: a player with nowhere to pay is strictly worse than a slightly over-loaded account.
   */
  private async applySoftCaps(
    candidates: readonly PaymentDestination[],
  ): Promise<PaymentDestination[]> {
    const capped = candidates.filter((candidate) => candidate.dailyCapMinor !== null);
    if (capped.length === 0) return [...candidates];

    const now = new Date();
    const dayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
    );

    let volumes: Map<string, bigint>;
    try {
      volumes = await this.destinations.volumeSince(
        capped.map((candidate) => candidate.id),
        dayStart,
      );
    } catch (error: unknown) {
      // The cap is advisory. Failing to measure it must not fail the deposit.
      this.logger.warn(
        `Could not measure destination volumes; ignoring daily caps: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [...candidates];
    }

    const eligible = candidates.filter((candidate) => {
      if (candidate.dailyCapMinor === null) return true;
      return (volumes.get(candidate.id) ?? 0n) < candidate.dailyCapMinor;
    });

    if (eligible.length > 0) return eligible;

    this.logger.warn(
      'Every destination is over its daily cap; ignoring caps so deposits can continue',
    );
    return [...candidates];
  }

  /**
   * `priority` is "lower is offered first", so weight must invert it. Clamped at both ends: a
   * negative priority cannot buy unbounded share, and a very large one still gets a slot rather
   * than being silently excluded (exclusion is what `isActive` is for).
   */
  private weightOf(destination: PaymentDestination): number {
    const weight = MAX_ROTATION_WEIGHT - destination.priority;
    if (!Number.isFinite(weight) || weight < 1) return 1;
    return Math.min(weight, MAX_ROTATION_WEIGHT);
  }

  private atWeightedIndex(
    weighted: readonly WeightedDestination[],
    index: number,
    fallback: PaymentDestination,
  ): PaymentDestination {
    let remaining = index;
    for (const entry of weighted) {
      if (remaining < entry.weight) return entry.destination;
      remaining -= entry.weight;
    }
    return fallback;
  }

  /**
   * Monotonic per method. Returns 0 on a Redis failure, which degrades rotation to "always the
   * highest-weighted destination" — worse spreading, but never a failed deposit.
   */
  private async nextCursor(paymentMethodId: string): Promise<number> {
    const key = destinationRotationKey(paymentMethodId);
    try {
      const value = await this.redis.incr(key);
      // Give the counter a lifetime only when we created it, so this stays one round trip in the
      // steady state. A reset merely restarts the rotation; it never mis-assigns anything.
      if (value === 1) await this.redis.expire(key, DESTINATION_STICKY_TTL_SECONDS * 7);
      return value - 1;
    } catch (error: unknown) {
      this.logger.error(
        `Destination rotation counter unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }
}
