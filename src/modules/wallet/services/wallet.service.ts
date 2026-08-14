/**
 * One read that answers "where is my money?" from three different sources, none of which is allowed
 * to break the other two.
 *
 * WHY the ledger numbers come from the ENTRIES and not from `cached_balance_minor`: the cache is
 * advisory (its drift is reconciliation invariant I3), and this is the number a player will compare
 * against their bank app. A stale cache here reads as us losing their money.
 *
 * WHY an Ichancy failure degrades instead of failing the request: the ledger half and the pending
 * half are ours and are always available. Returning 503 because a third party is slow would hide the
 * two numbers we can actually stand behind. The response says `available: false` and the client
 * renders "temporarily unavailable" — NEVER a zero.
 *
 * WHY there is no cross-module import: wallet needs a couple of deposit COLUMNS, not deposit
 * BEHAVIOUR, and eslint-plugin-boundaries forbids modules/A -> modules/B for exactly this reason —
 * a read that reaches into another module's service is one refactor away from being a write.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DepositStatus } from '@prisma/client';

import { NotFoundError } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';
import { AccountRegistryService, casinoMirrorCode, playerLiabilityCode } from '@core/ledger';
import { ICHANCY_PORT, type IchancyPort } from '@core/ichancy';
import { PrismaService } from '@core/prisma/prisma.service';

import { money, type PendingDepositView, type WalletView } from '../dtos/wallet.view';

/** Everything a player can still see money moving through. Terminal states are history. */
const PENDING_STATUSES: readonly DepositStatus[] = Object.freeze([
  DepositStatus.AWAITING_PROOF,
  DepositStatus.SUBMITTED,
  DepositStatus.UNDER_REVIEW,
  DepositStatus.PENDING_SECOND_APPROVAL,
  DepositStatus.APPROVED,
  DepositStatus.CREDITING,
  DepositStatus.NEEDS_RECONCILIATION,
]);

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountRegistryService,
    @Inject(ICHANCY_PORT) private readonly ichancy: IchancyPort,
  ) {}

  async getWallet(playerId: string): Promise<WalletView> {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      select: { id: true, currencyCode: true, ichancyPlayerId: true },
    });
    if (player === null) {
      throw new NotFoundError(CommonErrorCodes.RESOURCE_NOT_FOUND, 'Player not found.');
    }

    const currency = player.currencyCode;

    // A liability rests NEGATIVE (we owe), so the player-facing number is its negation. Clamped at
    // zero because a positive liability would mean the player owes US, which this product cannot
    // express and must not render as a negative wallet.
    const liability = await this.balanceOf(playerLiabilityCode(player.id, currency));
    const owed = liability < 0n ? -liability : 0n;
    const casinoMirror = await this.balanceOf(casinoMirrorCode(player.id, currency));

    const casino = await this.readCasinoBalance(player.ichancyPlayerId, player.id);

    const pendingRows = await this.prisma.depositRequest.findMany({
      where: { playerId: player.id, status: { in: [...PENDING_STATUSES] } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        shortId: true,
        status: true,
        claimedAmountMinor: true,
        verifiedAmountMinor: true,
        createdAt: true,
        expiresAt: true,
      },
    });

    const items: PendingDepositView[] = pendingRows.map((row) => ({
      shortId: row.shortId,
      status: row.status,
      // Show what we VERIFIED once somebody has verified it; the claim until then. Anything else
      // would tell a player their deposit is worth more than we accepted.
      amount: money(row.verifiedAmountMinor ?? row.claimedAmountMinor),
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
    }));

    const pendingTotal = items.reduce((sum, item) => sum + BigInt(item.amount.minor), 0n);

    return {
      currency,
      ledger: { owed: money(owed), casinoMirror: money(casinoMirror) },
      casino,
      pending: { count: items.length, total: money(pendingTotal), items },
    };
  }

  /** Sum of the account's entries, or 0 when the account has never been used. */
  private async balanceOf(code: string): Promise<bigint> {
    const account = await this.accounts.findByCode(this.prisma, code);
    if (account === null) return 0n;
    return this.accounts.computeBalanceFromEntries(this.prisma, account.id);
  }

  private async readCasinoBalance(
    ichancyPlayerId: string | null,
    playerId: string,
  ): Promise<WalletView['casino']> {
    const readAt = new Date().toISOString();

    // No mirror yet is a KNOWN zero, not an unknown: the account does not exist, so there is
    // nothing in it. That is different from "we could not ask".
    if (ichancyPlayerId === null) {
      return { available: true, balance: money(0n), readAt };
    }

    const result = await this.ichancy.getPlayerBalance(ichancyPlayerId, { playerId });
    if (result.kind === 'ok') {
      return { available: true, balance: money(result.data.balanceMinor), readAt };
    }

    this.logger.warn(
      `could not read the casino balance for player ${playerId}: ` +
        (result.kind === 'rejected' ? `${result.code} ${result.message}` : result.cause),
    );
    // NEVER a zero — see the header.
    return { available: false, balance: null, readAt };
  }
}
