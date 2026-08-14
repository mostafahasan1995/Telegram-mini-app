/**
 * WHY the policy checks run on CREATE and not on approval: a player who is self-excluded must be
 * told so before they send money to a bank account, not after. By approval time the cash has already
 * left their hands and refusing it creates a refund problem instead of preventing a harm.
 *
 * WHY self-exclusion is checked first and cannot be outweighed by anything: it is the one control
 * that exists for the player's protection rather than ours. Every other check here is a limit, and
 * limits have exceptions; this one does not.
 *
 * WHY the checks take `tx`: the cap is a SUM over a rolling window, and the row that would breach it
 * is inserted by the caller in the same transaction. Reading the sum outside that transaction leaves
 * a window in which two concurrent deposits each see a compliant total.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PlayerStatus, type PlayerLimit } from '@prisma/client';

import { BusinessRuleError } from '@common/exceptions/app.exception';
import { formatMinorToDecimal } from '@common/helpers/money.util';
import type { Tx } from '@core/prisma/tx.type';

import { DEPOSIT_CAP_WINDOW_HOURS, MAX_OPEN_DEPOSITS_PER_PLAYER } from '../deposit.constants';
import { DepositErrorCodes } from '../enums/deposit-error-code.enum';
import { DepositRepository } from '../repositories/deposit.repository';

export interface PolicyCheckInput {
  playerId: string;
  currencyCode: string;
  amountMinor: bigint;
  now?: Date;
}

export interface PolicyDecision {
  /** Effective limit row that applied, if any. Recorded on the audit trail of the created deposit. */
  appliedLimitId: string | null;
  /** Sum already accepted inside the rolling window, before this deposit. */
  windowUsedMinor: bigint;
  windowCapMinor: bigint | null;
}

const HOUR_MS = 60 * 60 * 1000;

@Injectable()
export class DepositPolicyService {
  private readonly logger = new Logger(DepositPolicyService.name);

  constructor(private readonly deposits: DepositRepository) {}

  /** Throws a 422 BusinessRuleError on the first rule that says no. Returns context otherwise. */
  async assertMayDeposit(tx: Tx, input: PolicyCheckInput): Promise<PolicyDecision> {
    const now = input.now ?? new Date();

    await this.assertNotSelfExcluded(tx, input.playerId, now);
    await this.assertPlayerActive(tx, input.playerId);
    await this.assertNotTooManyOpen(tx, input.playerId);

    const limit = await this.effectiveLimit(tx, input.playerId, input.currencyCode, now);

    this.assertSingleDepositLimit(limit, input.amountMinor, input.currencyCode);
    await this.assertCooldown(tx, limit, input.playerId, now);

    const { usedMinor, capMinor } = await this.assertRollingCap(tx, limit, input, now);

    return {
      appliedLimitId: limit?.id ?? null,
      windowUsedMinor: usedMinor,
      windowCapMinor: capMinor,
    };
  }

  /**
   * An exclusion is active when it has started, has not been revoked, and either has no end date
   * (permanent) or has not reached it. prisma/sql/004 guarantees at most one un-revoked row per
   * player, so `findFirst` is not hiding a second one.
   */
  private async assertNotSelfExcluded(tx: Tx, playerId: string, now: Date): Promise<void> {
    const exclusion = await tx.selfExclusion.findFirst({
      where: {
        playerId,
        revokedAt: null,
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      },
      select: { id: true, endsAt: true },
    });
    if (exclusion === null) return;

    throw new BusinessRuleError(
      DepositErrorCodes.PLAYER_SELF_EXCLUDED,
      'Deposits are blocked while a self-exclusion is active.',
      { until: exclusion.endsAt?.toISOString() ?? null },
    );
  }

  private async assertPlayerActive(tx: Tx, playerId: string): Promise<void> {
    const player = await tx.player.findUniqueOrThrow({
      where: { id: playerId },
      select: { status: true },
    });
    // PENDING_ICHANCY is fine: the mirror account is created lazily by the credit worker, and
    // refusing deposits until then would make the first deposit impossible.
    if (
      player.status === PlayerStatus.SUSPENDED ||
      player.status === PlayerStatus.CLOSED ||
      player.status === PlayerStatus.SELF_EXCLUDED
    ) {
      throw new BusinessRuleError(
        DepositErrorCodes.PLAYER_SUSPENDED,
        'This account cannot make deposits at the moment.',
        { status: player.status },
      );
    }
  }

  /**
   * A bounded number of open deposits per player. Without it, a client bug (or a bored user) can
   * open hundreds of AWAITING_PROOF rows, each of which is a card an admin has to dismiss.
   */
  private async assertNotTooManyOpen(tx: Tx, playerId: string): Promise<void> {
    const open = await this.deposits.countOpenForPlayer(tx, playerId);
    if (open >= MAX_OPEN_DEPOSITS_PER_PLAYER) {
      throw new BusinessRuleError(
        DepositErrorCodes.DEPOSIT_TOO_MANY_OPEN,
        'You already have deposits waiting to be processed. Finish or cancel one first.',
        { open, max: MAX_OPEN_DEPOSITS_PER_PLAYER },
      );
    }
  }

  /**
   * Limits are versioned, not mutated (see the schema), so "the limit" is the newest row whose
   * window contains `now`. Ordering by effectiveFrom DESC makes a scheduled loosening take effect on
   * its own date without anyone editing the old row.
   */
  private effectiveLimit(
    tx: Tx,
    playerId: string,
    currencyCode: string,
    now: Date,
  ): Promise<PlayerLimit | null> {
    return tx.playerLimit.findFirst({
      where: {
        playerId,
        currencyCode,
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      orderBy: { effectiveFrom: 'desc' },
    });
  }

  private assertSingleDepositLimit(
    limit: PlayerLimit | null,
    amountMinor: bigint,
    currencyCode: string,
  ): void {
    const max = limit?.maxSingleDepositMinor;
    if (max === null || max === undefined) return;
    if (amountMinor <= max) return;
    throw new BusinessRuleError(
      DepositErrorCodes.SINGLE_DEPOSIT_LIMIT_EXCEEDED,
      `This deposit is larger than your per-deposit limit of ${formatMinorToDecimal(max)} ${currencyCode}.`,
      { maxSingleDepositMinor: max.toString(), amountMinor: amountMinor.toString() },
    );
  }

  private async assertCooldown(
    tx: Tx,
    limit: PlayerLimit | null,
    playerId: string,
    now: Date,
  ): Promise<void> {
    const cooldown = limit?.cooldownMinutes;
    if (cooldown === null || cooldown === undefined || cooldown <= 0) return;

    const last = await this.deposits.lastSubmissionAt(tx, playerId);
    if (last === null) return;

    const readyAt = new Date(last.createdAt.getTime() + cooldown * 60_000);
    if (readyAt <= now) return;

    throw new BusinessRuleError(
      DepositErrorCodes.DEPOSIT_COOLDOWN_ACTIVE,
      'Please wait a little before starting another deposit.',
      { readyAt: readyAt.toISOString(), cooldownMinutes: cooldown },
    );
  }

  /**
   * The 24h cap. `dailyDepositCapMinor` from the player's limit row wins; with no row there is no
   * cap, which is deliberate — a cap that appears out of nowhere would block legitimate players the
   * first time someone forgets to seed limits.
   */
  private async assertRollingCap(
    tx: Tx,
    limit: PlayerLimit | null,
    input: PolicyCheckInput,
    now: Date,
  ): Promise<{ usedMinor: bigint; capMinor: bigint | null }> {
    const cap = limit?.dailyDepositCapMinor ?? null;
    const since = new Date(now.getTime() - DEPOSIT_CAP_WINDOW_HOURS * HOUR_MS);
    const usedMinor = await this.deposits.sumAcceptedSince(tx, input.playerId, since);

    if (cap === null) return { usedMinor, capMinor: null };

    const projected = usedMinor + input.amountMinor;
    if (projected <= cap) return { usedMinor, capMinor: cap };

    this.logger.warn(
      `player ${input.playerId} hit the ${DEPOSIT_CAP_WINDOW_HOURS}h cap: ` +
        `${projected.toString()} > ${cap.toString()}`,
    );
    throw new BusinessRuleError(
      DepositErrorCodes.DEPOSIT_CAP_EXCEEDED,
      `This deposit would take you over your ${DEPOSIT_CAP_WINDOW_HOURS}-hour limit of ` +
        `${formatMinorToDecimal(cap)} ${input.currencyCode}.`,
      {
        capMinor: cap.toString(),
        usedMinor: usedMinor.toString(),
        requestedMinor: input.amountMinor.toString(),
        windowHours: DEPOSIT_CAP_WINDOW_HOURS,
      },
    );
  }
}
