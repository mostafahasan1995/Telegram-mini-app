/**
 * The accounts that are not created on demand.
 *
 * Player-scoped accounts (PLAYER_LIABILITY, CASINO_MIRROR) are minted by
 * `AccountRegistryService.resolveOrCreate` the first time a player moves money, so they are
 * deliberately absent here. What IS seeded is everything a deposit needs to exist BEFORE anybody
 * has registered: the agent float, the rounding sink, and the three per-rail accounts.
 *
 * WHY the account definitions are derived from `parseAccountCode` instead of written out:
 * the code IS the definition — `ICHANCY_AGENT_FLOAT:NSP` fully determines the kind, the sign
 * convention, the display name and which scope column gets filled. Restating those here would
 * create a second source of truth that only disagrees with the ledger's when it matters.
 *
 * WHY `cachedBalanceMinor` is never in the update clause: it is an advisory cache maintained by
 * every posting and rewritten by the reconciliation job. A re-run of the seed that reset it to zero
 * would make the approval path believe the agent float is empty and refuse every credit until the
 * next reconciliation pass.
 */
import type { PrismaClient } from '@prisma/client';

import {
  houseCashCode,
  houseRoundingCode,
  ichancyAgentFloatCode,
  parseAccountCode,
  railClearingCode,
  suspenseUnidentifiedCode,
} from '@core/ledger/account-codes';

export interface SeededLedgerAccount {
  code: string;
  created: boolean;
}

export interface LedgerAccountSeedInput {
  currencyCode: string;
  /** Every active payment method: each one owns a clearing, a house-cash and a suspense account. */
  paymentMethodIds: readonly string[];
}

export function ledgerAccountCodesFor(input: LedgerAccountSeedInput): string[] {
  const { currencyCode, paymentMethodIds } = input;

  const singletons = [ichancyAgentFloatCode(currencyCode), houseRoundingCode(currencyCode)];

  const perRail = paymentMethodIds.flatMap((paymentMethodId) => [
    // Money the player says they sent, not yet confirmed as ours.
    railClearingCode(paymentMethodId, currencyCode),
    // Confirmed receipts.
    houseCashCode(paymentMethodId, currencyCode),
    // Arrived, but we cannot tell whose it is.
    suspenseUnidentifiedCode(paymentMethodId, currencyCode),
  ]);

  return [...singletons, ...perRail];
}

export async function seedLedgerAccounts(
  prisma: PrismaClient,
  input: LedgerAccountSeedInput,
): Promise<SeededLedgerAccount[]> {
  const results: SeededLedgerAccount[] = [];

  for (const code of ledgerAccountCodesFor(input)) {
    const parsed = parseAccountCode(code);

    const existing = await prisma.ledgerAccount.findUnique({
      where: { code },
      select: { id: true },
    });

    if (existing === null) {
      await prisma.ledgerAccount.create({
        data: {
          code: parsed.code,
          kind: parsed.kind,
          name: parsed.name,
          currencyCode: parsed.currencyCode,
          playerId: parsed.playerId,
          paymentMethodId: parsed.paymentMethodId,
          isDebitNormal: parsed.spec.isDebitNormal,
          isActive: true,
          // Explicitly zero on CREATE only: a brand-new account has posted nothing.
          cachedBalanceMinor: 0n,
        },
      });
      results.push({ code, created: true });
      continue;
    }

    await prisma.ledgerAccount.update({
      where: { code },
      // Name and active flag only — see the header on cachedBalanceMinor.
      data: { name: parsed.name, isActive: true },
    });
    results.push({ code, created: false });
  }

  return results;
}
