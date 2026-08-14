/**
 * WHY the wallet response has THREE numbers and not one:
 *
 *   owedMinor      what we hold for the player and have not yet credited (the PLAYER_LIABILITY
 *                  balance, negated — a liability rests negative in the ledger).
 *   casinoMinor    what Ichancy says the player actually has, right now.
 *   pendingMinor   money the player says they have sent and we have not accepted yet.
 *
 * Collapsing them into a single "balance" would be a lie in every direction: the owed amount is real
 * money we hold but the player cannot bet with; the casino balance is spendable but not ours to
 * report authoritatively; the pending amount may never exist at all. A cashier UI that shows one
 * number is a cashier UI that will be argued about.
 *
 * `casino.available` is FALSE when Ichancy could not be reached. The client must render "temporarily
 * unavailable", never 0 — showing a zero balance to a player who has money is the single worst thing
 * this endpoint could do.
 */
import { formatMinorToDecimal } from '@common/helpers/money.util';
import type { DepositStatus } from '@prisma/client';

export interface WalletMoney {
  minor: string;
  amount: string;
}

export const money = (minor: bigint): WalletMoney => ({
  minor: minor.toString(),
  amount: formatMinorToDecimal(minor),
});

export interface PendingDepositView {
  shortId: string;
  status: DepositStatus;
  amount: WalletMoney;
  createdAt: string;
  expiresAt: string | null;
}

export interface WalletView {
  currency: string;
  /** From OUR books: what we owe this player but have not yet pushed into the casino. */
  ledger: {
    owed: WalletMoney;
    /** Our mirror of the casino balance, from the CASINO_MIRROR account. Advisory. */
    casinoMirror: WalletMoney;
  };
  /** From Ichancy, live. `available: false` means we could not read it — NOT that it is zero. */
  casino: {
    available: boolean;
    balance: WalletMoney | null;
    readAt: string;
  };
  pending: {
    count: number;
    total: WalletMoney;
    items: PendingDepositView[];
  };
}
