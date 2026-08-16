/**
 * The competitor-style activity report, rendered from OUR database.
 *
 * ══ WHY THIS IS A SERVICE AND NOT STILL A TELEGRAM HANDLER ════════════════════════════════════
 * The exact same body has to be reachable from more than one trigger — an operator typing /report
 * and anything else that wants to push the same numbers on a schedule. A second renderer would
 * drift from this one within a release, and two reports that disagree about "الشحن اليوم" are worse
 * than no report at all. The handler in telegram/admin.handlers.ts is now a three-line caller:
 * parse, usage-or-build, reply. Everything a reader could argue about lives here.
 *
 * ══ WHY IT READS PRISMA DIRECTLY ══════════════════════════════════════════════════════════════
 * Same reason as the handlers file it came from: `eslint-plugin-boundaries` makes modules/admin ->
 * modules/deposit a BUILD FAILURE and there is no published read port. Everything below is a
 * read-only projection for a human to look at — no transaction, no money write. The one constant
 * that had to be restated is marked MIRRORS and says what it mirrors.
 *
 * The float figure is the exception and is NOT restated: the ledger side is read through
 * AccountRegistryService in @core/ledger — the same service AgentFloatSyncService uses, from the
 * entries rather than the cached balance, because a stale cache would manufacture a drift.
 *
 * ══ WHY NOTHING HERE CATCHES ══════════════════════════════════════════════════════════════════
 * buildReport() either returns a report or throws. The caller decides what a failure looks like:
 * the Telegram handler answers with one apologetic line, a scheduled sender may want to stay quiet.
 * Swallowing here would hand both of them an empty-looking report instead of an error.
 */
import { Injectable } from '@nestjs/common';
import { DepositStatus, type Prisma } from '@prisma/client';

import { compareMinor } from '@common/helpers/money.util';
import { dualNsp } from '@common/helpers/money-display.util';
import { AppConfigService } from '@core/config/config.service';
import { AccountRegistryService, ichancyAgentFloatCode } from '@core/ledger';
import { PrismaService } from '@core/prisma/prisma.service';

/**
 * MIRRORS `REVIEWABLE_STATUSES` in src/modules/deposit/deposit-state.machine.ts — the default
 * filter of GET /v1/admin/deposits. Restated because of the module boundary; see the header.
 *
 * Exported because /queue in telegram/admin.handlers.ts filters on the SAME definition of
 * "waiting", and a second copy of this list is exactly the drift the MIRRORS note warns about.
 */
export const WAITING_STATUSES: readonly DepositStatus[] = Object.freeze([
  DepositStatus.SUBMITTED,
  DepositStatus.UNDER_REVIEW,
  DepositStatus.PENDING_SECOND_APPROVAL,
]);

/**
 * The two states where a player HAS paid but no money reached his casino account. /report surfaces
 * their count because these are the numbers an operator must not ignore: every one is a person
 * waiting on money we already accepted.
 */
const ATTENTION_STATUSES: readonly DepositStatus[] = Object.freeze([
  DepositStatus.CREDIT_FAILED,
  DepositStatus.NEEDS_RECONCILIATION,
]);

/** Telegram's HTML parse mode needs exactly these three escaped, and nothing else. */
function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// -----------------------------------------------------------------------------------------------
// Period handling
// -----------------------------------------------------------------------------------------------

export type ReportPeriodKey = 'day' | 'week' | 'month';

/**
 * WHAT was asked for, not WHEN — the window is derived from the `now` handed to buildReport(), so
 * one resolved period can be rendered again tomorrow (a scheduled sender resolves 'day' once and
 * passes a fresh clock every tick) without ever re-parsing operator input.
 */
export interface ReportPeriod {
  readonly key: ReportPeriodKey;
  /** Arabic name printed in the report header. */
  readonly label: string;
}

/** The resolved boundaries. `to` is the caller's `now`, captured ONCE by the caller. */
interface ReportRange {
  readonly from: Date;
  /** `now`, captured ONCE — the header and every period-bound query agree to the millisecond. */
  readonly to: Date;
}

/**
 * Liberal aliases: operators type whichever spelling comes to their thumbs (with/without ال and
 * hamza, English word, single letter). Anything not in this map gets the usage text, never a guess.
 */
const REPORT_PERIOD_ALIASES: ReadonlyMap<string, ReportPeriodKey> = new Map<
  string,
  ReportPeriodKey
>([
  ['اليوم', 'day'],
  ['يوم', 'day'],
  ['today', 'day'],
  ['day', 'day'],
  ['d', 'day'],
  ['t', 'day'],
  ['الأسبوع', 'week'],
  ['الاسبوع', 'week'],
  ['أسبوع', 'week'],
  ['اسبوع', 'week'],
  ['week', 'week'],
  ['w', 'week'],
  ['الشهر', 'month'],
  ['شهر', 'month'],
  ['month', 'month'],
  ['m', 'month'],
]);

/** The Arabic name each period prints in the header. */
const REPORT_PERIOD_LABELS: Readonly<Record<ReportPeriodKey, string>> = Object.freeze({
  day: 'اليوم',
  week: 'آخر 7 أيام',
  month: 'الشهر الحالي',
});

const DAY_MS = 86_400_000;

/**
 * Boundaries are computed in UTC and LABELED UTC in the header — the report is honest about its
 * clock. Damascus-local boundaries are a later nicety; wrong-but-unlabeled is the only failure mode.
 *
 * day   = since 00:00 UTC today.
 * week  = the last 7 calendar days (00:00 UTC six days ago → now), rolling — not "since Monday",
 *         because which day a Syrian week starts on is genuinely contested (Fri/Sat weekend).
 * month = since the 1st of the current month, 00:00 UTC. The default.
 */
function reportRange(period: ReportPeriod, now: Date): ReportRange {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  switch (period.key) {
    case 'day':
      return { from: new Date(todayUtc), to: now };
    case 'week':
      return { from: new Date(todayUtc - 6 * DAY_MS), to: now };
    case 'month':
      return {
        from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
        to: now,
      };
  }
}

/** "2026-08-14 09:57:17" — the competitor's timestamp shape. Always UTC; the caller labels it so. */
function formatUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** Printed verbatim when the argument is not a period we recognise. */
export const REPORT_USAGE = [
  '<b>/report</b> — تقرير النشاط',
  'الاستخدام: <code>/report [اليوم | الأسبوع | الشهر]</code>',
  '• اليوم — منذ منتصف الليل (UTC)',
  '• الأسبوع — آخر 7 أيام',
  '• الشهر — منذ أول الشهر الحالي (الافتراضي)',
].join('\n');

@Injectable()
export class ActivityReportService {
  /** Same string as the exported const — reachable from an injected instance. */
  readonly REPORT_USAGE = REPORT_USAGE;

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountRegistryService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Whatever followed "/report", or nothing at all. An absent/blank argument is the month — the
   * documented default — and anything unrecognised is null so the caller can print the usage text
   * rather than silently reporting a period nobody asked for.
   */
  resolveReportPeriod(raw: string | undefined): ReportPeriod | null {
    const token = (raw ?? '').trim().toLowerCase();
    const key: ReportPeriodKey | undefined =
      token === '' ? 'month' : REPORT_PERIOD_ALIASES.get(token);
    if (key === undefined) return null;

    return { key, label: REPORT_PERIOD_LABELS[key] };
  }

  /**
   * WHY sections vanish instead of printing zeros: a "0.00" row for a thing that simply did not
   * happen reads like an anomaly and trains the operator to skim. A section that exists always
   * means something. (And there is deliberately NO withdrawals section — withdrawals do not exist
   * in this system yet, and a fake zero would claim they do.)
   *
   * WHY the deposit sections filter on creditedAt/decidedAt rather than createdAt: "الشحن اليوم"
   * means money that LANDED today. A deposit opened last night and credited this morning belongs
   * to this morning's number — that is how the competitor's report reads and how the operator
   * reconciles it against the Ichancy panel.
   */
  async buildReport(period: ReportPeriod, now: Date): Promise<string> {
    const range = reportRange(period, now);
    const inPeriod = { gte: range.from, lt: range.to };

    const [newPlayers, totalPlayers, credited, rejected, waiting, attention, floatMinor] =
      await Promise.all([
        this.prisma.player.count({ where: { createdAt: inPeriod } }),
        this.prisma.player.count(),
        this.creditedByMethod({ status: DepositStatus.CREDITED, creditedAt: inPeriod }),
        // decidedAt IS the rejection moment — the state machine stamps it on every decision.
        this.countAndSumDeposits({ status: DepositStatus.REJECTED, decidedAt: inPeriod }),
        // The queue sections are CURRENT state, not period-bound: a stuck deposit from last week
        // must not fall out of today's report.
        this.prisma.depositRequest.count({ where: { status: { in: [...WAITING_STATUSES] } } }),
        this.prisma.depositRequest.count({ where: { status: { in: [...ATTENTION_STATUSES] } } }),
        this.ledgerFloatMinor(),
      ]);

    const lines = [
      `📊 <b>تقرير النشاط — ${period.label}</b>`,
      `📅 من: ${formatUtc(range.from)} (UTC)`,
      `📅 إلى: ${formatUtc(range.to)} (UTC)`,
      '',
      '👥 <b>المستخدمين</b>',
      `🆕 لاعبون جدد خلال الفترة: ${newPlayers}`,
      `👤 إجمالي اللاعبين: ${totalPlayers}`,
    ];

    if (credited.length > 0) {
      lines.push('', '💳 <b>الشحن</b>');
      let totalCount = 0;
      let totalMinor = 0n;
      for (const row of credited) {
        totalCount += row.count;
        totalMinor += row.sumMinor;
        lines.push(`• ${esc(row.displayName)}: ${row.count} عملية — ${dualNsp(row.sumMinor)}`);
      }
      lines.push(`💰 إجمالي الشحن: ${totalCount} عملية — <b>${dualNsp(totalMinor)}</b>`);
    }

    // Shown whenever EITHER number is non-zero — and then both are shown, because "0 failed" next
    // to "5 waiting" is real information, not a fake zero.
    if (waiting > 0 || attention > 0) {
      lines.push(
        '',
        '📋 <b>حالة الطابور</b> <i>(الوضع الحالي)</i>',
        `⏳ بانتظار المراجعة: ${waiting}`,
        `🚨 فشل شحن / بحاجة تدقيق: ${attention}`,
      );
    }

    if (rejected.count > 0) {
      lines.push(
        '',
        '❌ <b>المرفوضة</b>',
        `عدد المرفوضة: ${rejected.count} — ${dualNsp(rejected.sumMinor)}`,
      );
    }

    lines.push(
      '',
      '📊 <b>رصيد الكاشيرة</b>',
      `💰 <code>ICHANCY_AGENT_FLOAT</code>: <b>${dualNsp(floatMinor)}</b>`,
    );

    return lines.join('\n');
  }

  /**
   * The ledger side of the agent float — THE account-code logic, shared by /float and /report so
   * the two commands can never disagree about which account "the float" is. From the entries, not
   * the cached balance: the figure is about to be compared against an outside source, and a stale
   * cache would invent a drift that does not exist.
   */
  async ledgerFloatMinor(): Promise<bigint> {
    const currency = this.config.ichancy.currency;
    const account = await this.accounts.findByCode(this.prisma, ichancyAgentFloatCode(currency));
    // A float account that has never been posted to is genuinely zero, not missing.
    return account === null ? 0n : this.accounts.computeBalanceFromEntries(this.prisma, account.id);
  }

  /**
   * Per-method totals with the SAME amount precedence the admin card and /queue use: the verified
   * figure once an admin set one, the player's claim until then. Prisma's groupBy cannot express
   * that COALESCE inside _sum, so the period is split into two exact partitions (verified set /
   * verified null) and the partitions are summed SQL-side — correctness over cleverness, and no
   * unbounded row fetch. The third query only resolves displayName for the ids that appeared.
   */
  private async creditedByMethod(
    where: Prisma.DepositRequestWhereInput,
  ): Promise<{ displayName: string; count: number; sumMinor: bigint }[]> {
    const [verified, claimedOnly] = await Promise.all([
      this.prisma.depositRequest.groupBy({
        by: ['paymentMethodId'],
        where: { ...where, verifiedAmountMinor: { not: null } },
        _count: { _all: true },
        _sum: { verifiedAmountMinor: true },
      }),
      this.prisma.depositRequest.groupBy({
        by: ['paymentMethodId'],
        where: { ...where, verifiedAmountMinor: null },
        _count: { _all: true },
        _sum: { claimedAmountMinor: true },
      }),
    ]);

    const totals = new Map<string, { count: number; sumMinor: bigint }>();
    const add = (methodId: string, count: number, sum: bigint | null): void => {
      const entry = totals.get(methodId) ?? { count: 0, sumMinor: 0n };
      entry.count += count;
      entry.sumMinor += sum ?? 0n;
      totals.set(methodId, entry);
    };
    for (const group of verified) {
      add(group.paymentMethodId, group._count._all, group._sum.verifiedAmountMinor);
    }
    for (const group of claimedOnly) {
      add(group.paymentMethodId, group._count._all, group._sum.claimedAmountMinor);
    }

    if (totals.size === 0) return [];

    const methods = await this.prisma.paymentMethod.findMany({
      where: { id: { in: [...totals.keys()] } },
      select: { id: true, displayName: true },
    });
    const names = new Map(methods.map((method) => [method.id, method.displayName]));

    return [...totals.entries()]
      .map(([methodId, entry]) => ({
        // A deleted method cannot happen (onDelete: Restrict), but a fallback beats a crash.
        displayName: names.get(methodId) ?? methodId,
        count: entry.count,
        sumMinor: entry.sumMinor,
      }))
      .sort((a, b) => {
        // Biggest rail first — that is the line the operator is looking for. Name breaks ties so
        // the order is stable between runs.
        const bySum = compareMinor(b.sumMinor, a.sumMinor);
        return bySum !== 0 ? bySum : a.displayName.localeCompare(b.displayName);
      });
  }

  /** Ungrouped count + sum with the same verified-over-claimed precedence as creditedByMethod. */
  private async countAndSumDeposits(
    where: Prisma.DepositRequestWhereInput,
  ): Promise<{ count: number; sumMinor: bigint }> {
    const [verified, claimedOnly] = await Promise.all([
      this.prisma.depositRequest.aggregate({
        where: { ...where, verifiedAmountMinor: { not: null } },
        _count: { _all: true },
        _sum: { verifiedAmountMinor: true },
      }),
      this.prisma.depositRequest.aggregate({
        where: { ...where, verifiedAmountMinor: null },
        _count: { _all: true },
        _sum: { claimedAmountMinor: true },
      }),
    ]);

    return {
      count: verified._count._all + claimedOnly._count._all,
      sumMinor:
        (verified._sum.verifiedAmountMinor ?? 0n) + (claimedOnly._sum.claimedAmountMinor ?? 0n),
    };
  }
}
