/**
 * Compares what Ichancy says our agent wallet holds against what our ICHANCY_AGENT_FLOAT account
 * says it holds, and opens a break on any difference.
 *
 * WHY this number matters more than any other reconciliation figure: the float is what PAYS for every
 * credit. The ledger refuses a T2 posting that would drive it below zero (NON_NEGATIVE sign policy),
 * so if our figure is too HIGH we approve deposits we cannot fund and discover it after the player
 * has been told they were approved; if it is too LOW we refuse credits we could have made. Both are
 * outages, and neither is visible from anywhere else.
 *
 * WHY drift opens a break instead of auto-posting a correction: a difference means one of two things
 * — someone moved money in the Ichancy panel outside this system (a manual top-up, a withdrawal to
 * the agent), or we have a bug. The first needs a ledger entry describing what actually happened; the
 * second must not be papered over by an entry that makes the books agree with a number we do not
 * understand. So the cron DETECTS and a human DECIDES; `applyCorrection` exists for when they have.
 *
 * WHY the correction posts against HOUSE_ROUNDING: a float correction must balance somewhere, and
 * HOUSE_ROUNDING is the only account with an ANY sign policy — every other account would refuse one
 * of the two directions. The posting is labelled AGENT_FLOAT_SYNC and carries the operator's note, so
 * it is never mistaken for a real movement.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { BreakCategory, LedgerTxKind } from '@prisma/client';

import type { AuthenticatedAdmin } from '@common/decorators/auth.types';
import { BusinessRuleError } from '@common/exceptions/app.exception';
import { formatMinorToDecimal } from '@common/helpers/money.util';
import { dualNsp } from '@common/helpers/money-display.util';
import { adminActor } from '@common/types/actor.type';
import { LockService } from '@core/cache/lock.service';
import { RedisService } from '@core/cache/redis.service';
import { AppConfigService } from '@core/config/config.service';
import { ICHANCY_PORT, type IchancyPort } from '@core/ichancy';
import {
  AccountRegistryService,
  houseRoundingCode,
  ichancyAgentFloatCode,
  LedgerService,
  type Posting,
} from '@core/ledger';
import { PrismaService } from '@core/prisma/prisma.service';
import { BotService } from '@core/telegram/services/bot.service';

import { ReconciliationErrorCodes } from '../enums/reconciliation-error-code.enum';
import {
  AGENT_FLOAT_SYNC_INTERVAL_MS,
  AGENT_FLOAT_TOLERANCE_MINOR,
  breakKeys,
  RECON_LOCK_TTL_MS,
  utcDay,
} from '../reconciliation.constants';
import { ReconciliationBreakService } from './reconciliation-break.service';

export interface FloatSyncResult {
  currencyCode: string;
  /** What our ledger believes. */
  ledgerMinor: bigint;
  /** What Ichancy reports as the agent wallet balance. Null when it could not be read. */
  ichancyMinor: bigint | null;
  /** ichancy - ledger. Positive means they hold MORE than our books say. */
  deltaMinor: bigint | null;
  breakId: string | null;
  belowWatermark: boolean;
}

/** Money is missing or unexplained. Not the top severity — the books are still internally consistent. */
const SEVERITY_FLOAT_DRIFT = 4;

/** One low-float warning per this window (6 h); /float shows the live figure on demand anytime. */
const LOW_FLOAT_WARN_WINDOW_SECONDS = 6 * 60 * 60;

@Injectable()
export class AgentFloatSyncService {
  private readonly logger = new Logger(AgentFloatSyncService.name);

  /** So the fake-mode skip announces itself once, not every 5 minutes. */
  private fakeSkipLogged = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountRegistryService,
    private readonly ledger: LedgerService,
    private readonly breaks: ReconciliationBreakService,
    private readonly locks: LockService,
    private readonly bot: BotService,
    private readonly config: AppConfigService,
    private readonly redis: RedisService,
    @Inject(ICHANCY_PORT) private readonly ichancy: IchancyPort,
  ) {}

  @Interval('agent-float-sync', AGENT_FLOAT_SYNC_INTERVAL_MS)
  async tick(): Promise<void> {
    if (!this.config.app.isWorker) return;

    // The fake adapter's wallet is a hardcoded default, so comparing it against the ledger
    // manufactures a "drift" that is pure noise — an ERROR log and an admin-group warning every
    // five minutes, none of it actionable. An alarm that is never real teaches operators to skim
    // past alarms, so in fake mode the whole sync is inert. The admin /float command still works
    // and says the wallet read comes from the fake.
    if (this.config.ichancy.fake) {
      if (!this.fakeSkipLogged) {
        this.logger.log('agent float sync skipped: Ichancy is FAKE (no real wallet to compare)');
        this.fakeSkipLogged = true;
      }
      return;
    }

    const handle = await this.locks.acquire(
      LockService.key('cron', 'agent-float-sync'),
      RECON_LOCK_TTL_MS,
    );
    if (handle === null) return;

    try {
      await this.sync(this.config.ichancy.currency);
    } catch (cause) {
      this.logger.error(
        `agent float sync failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      await this.locks.release(handle).catch(() => false);
    }
  }

  /** Read both sides, compare, and record. Safe to call from an admin endpoint. */
  async sync(currencyCode: string): Promise<FloatSyncResult> {
    const ledgerMinor = await this.ledgerFloat(currencyCode);

    const wallet = await this.ichancy.getAgentWallet({ correlationId: 'agent-float-sync' });
    if (wallet.kind !== 'ok') {
      const cause = wallet.kind === 'rejected' ? `${wallet.code} ${wallet.message}` : wallet.cause;
      this.logger.error(`could not read the Ichancy agent wallet: ${cause}`);
      // Not a break: we learned nothing about the float, only about the API. Inventing a delta from
      // a failed read would be worse than reporting that we could not look.
      return {
        currencyCode,
        ledgerMinor,
        ichancyMinor: null,
        deltaMinor: null,
        breakId: null,
        belowWatermark: ledgerMinor < this.config.limits.agentFloatLowWatermarkMinor,
      };
    }

    // `availableWallet` is what we can actually spend, which is what limits approvals — `balance`
    // can include credit lines we must not treat as ours.
    const ichancyMinor = wallet.data.availableMinor;
    const deltaMinor = ichancyMinor - ledgerMinor;
    const belowWatermark = ichancyMinor < this.config.limits.agentFloatLowWatermarkMinor;

    if (belowWatermark) {
      await this.warnLowFloat(currencyCode, ichancyMinor);
    }

    if (absolute(deltaMinor) <= AGENT_FLOAT_TOLERANCE_MINOR) {
      this.logger.debug(
        `agent float in sync: ${formatMinorToDecimal(ledgerMinor)} ${currencyCode}`,
      );
      return { currencyCode, ledgerMinor, ichancyMinor, deltaMinor, breakId: null, belowWatermark };
    }

    const account = await this.accounts.findByCode(
      this.prisma,
      ichancyAgentFloatCode(currencyCode),
    );
    const opened = await this.breaks.observeStandalone({
      category: BreakCategory.AGENT_FLOAT_MISMATCH,
      severity: SEVERITY_FLOAT_DRIFT,
      currencyCode,
      dedupeKey: breakKeys.agentFloat(currencyCode, utcDay()),
      // "expected" is OUR number: the ledger is the thing we control and can be held to.
      expectedMinor: ledgerMinor,
      actualMinor: ichancyMinor,
      ...(account === null ? {} : { ledgerAccountId: account.id }),
      detail: {
        ledgerMinor: ledgerMinor.toString(),
        ichancyAvailableMinor: ichancyMinor.toString(),
        ichancyBalanceMinor: wallet.data.balanceMinor.toString(),
        deltaMinor: deltaMinor.toString(),
        hint:
          deltaMinor > 0n
            ? 'Ichancy holds MORE than our books: an out-of-band top-up was probably made.'
            : 'Ichancy holds LESS than our books: money left the agent wallet outside this system.',
      },
    });

    this.logger.error(
      `agent float DRIFT ${formatMinorToDecimal(deltaMinor)} ${currencyCode} ` +
        `(ledger ${formatMinorToDecimal(ledgerMinor)}, ichancy ${formatMinorToDecimal(ichancyMinor)})`,
    );

    return {
      currencyCode,
      ledgerMinor,
      ichancyMinor,
      deltaMinor,
      breakId: opened.id,
      belowWatermark,
    };
  }

  /**
   * Post the correction a human has decided on. Separate from detection on purpose: this is the only
   * place in the system where a number is changed to match an outside source, and it must always be
   * an explicit act with an operator's name and note attached.
   */
  async applyCorrection(input: {
    breakId: string;
    admin: AuthenticatedAdmin;
    note: string;
  }): Promise<{ ledgerTransactionId: string; deltaMinor: bigint }> {
    const record = await this.prisma.reconciliationBreak.findUnique({
      where: { id: input.breakId },
    });
    if (record === null || record.category !== BreakCategory.AGENT_FLOAT_MISMATCH) {
      throw new BusinessRuleError(
        ReconciliationErrorCodes.CORRECTION_NOT_ALLOWED,
        'Only an agent float mismatch can be corrected this way.',
      );
    }
    const delta = record.deltaMinor;
    if (delta === null || delta === 0n) {
      throw new BusinessRuleError(
        ReconciliationErrorCodes.NOTHING_TO_CORRECT,
        'That break has no outstanding difference to correct.',
      );
    }

    const posting: Posting = {
      idempotencyKey: `ledger:agent-float-sync:${input.breakId}`,
      kind: LedgerTxKind.AGENT_FLOAT_SYNC,
      refType: 'RECONCILIATION',
      refId: input.breakId,
      currency: record.currencyCode,
      entries: [
        { accountCode: ichancyAgentFloatCode(record.currencyCode), amountMinor: delta },
        { accountCode: houseRoundingCode(record.currencyCode), amountMinor: -delta },
      ],
      description: `Agent float correction ${formatMinorToDecimal(delta)} ${record.currencyCode}`,
      actor: adminActor(input.admin.adminUserId),
      externalRef: input.breakId,
      // The counter-entry is the rounding sink, which is unguarded; the float side may legitimately
      // move in either direction and must not be refused by a sign policy while being corrected.
      allowNegative: true,
      metadata: {
        breakId: input.breakId,
        note: input.note,
        expectedMinor: record.expectedMinor?.toString() ?? null,
        actualMinor: record.actualMinor?.toString() ?? null,
      },
    };

    const posted = await this.ledger.postWithRetry(this.prisma, posting);

    await this.breaks.resolve({
      breakId: input.breakId,
      admin: input.admin,
      status: 'RESOLVED',
      note: input.note,
      resolutionTxId: posted.transactionId,
    });

    this.logger.warn(
      `agent float corrected by ${formatMinorToDecimal(delta)} ${record.currencyCode} ` +
        `(${input.admin.displayName}: ${input.note})`,
    );
    return { ledgerTransactionId: posted.transactionId, deltaMinor: delta };
  }

  private async ledgerFloat(currencyCode: string): Promise<bigint> {
    const account = await this.accounts.findByCode(
      this.prisma,
      ichancyAgentFloatCode(currencyCode),
    );
    if (account === null) return 0n;
    // From the entries, not the cache: this number is compared against an external source and a
    // stale cache would manufacture a drift that does not exist.
    return this.accounts.computeBalanceFromEntries(this.prisma, account.id);
  }

  /**
   * The low-float warning, competitor-style Arabic, throttled to once per window via SET NX.
   *
   * WHY throttled here and not at the caller: the sync runs every 5 minutes and the float stays low
   * until a human tops it up — un-throttled, that is 72 identical warnings a day, and the 73rd is
   * the one nobody reads. One warning per window keeps the signal; /float always shows the live
   * number on demand.
   */
  private async warnLowFloat(currencyCode: string, availableMinor: bigint): Promise<void> {
    const first = await this.redis.set(
      `recon:float-low-warned:${currencyCode}`,
      new Date().toISOString(),
      'EX',
      LOW_FLOAT_WARN_WINDOW_SECONDS,
      'NX',
    );
    if (first === null) return; // warned recently; stay quiet until the window expires

    const watermarkMinor = this.config.limits.agentFloatLowWatermarkMinor;
    const shortfallMinor = watermarkMinor - availableMinor;
    // notifyAdmins ONLY — never notifyFeed: this is our working capital and the fact that we are
    // nearly out of it. The feed group may contain customers, for whom it is a run signal.
    await this.bot.notifyAdmins(
      [
        '⚠️ <b>تنبيه: رصيد الكاشيرة منخفض</b>',
        '━━━━━━━━━━━━━━━━━━━━',
        `📊 الرصيد المتاح: <b>${dualNsp(availableMinor)}</b>`,
        `📉 حد الأمان: ${dualNsp(watermarkMinor)}`,
        `🔻 النقص: <b>${dualNsp(shortfallMinor)}</b>`,
        '━━━━━━━━━━━━━━━━━━━━',
        '⛔ عند نفاد الرصيد ستُرفض عمليات الشحن تلقائياً',
        '💡 اشحن رصيد الوكيل في أقرب وقت — ثم /float للتأكد',
      ].join('\n'),
      { parseMode: 'HTML', linkPreview: false },
    );
  }
}

const absolute = (value: bigint): bigint => (value < 0n ? -value : value);
