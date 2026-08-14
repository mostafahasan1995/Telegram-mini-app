/**
 * The on-call operator's commands, in the same chat where the deposit cards already live.
 *
 * ══ WHY A NON-ADMIN GETS SILENCE, NOT A REFUSAL ═══════════════════════════════════════════════
 * Replying "you are not an admin" confirms that the command exists to anyone who guesses it, which
 * turns the bot into an oracle for the staff surface. Every handler here resolves ctx.from.id
 * through AdminIdentityService and simply RETURNS when that comes back null — indistinguishable
 * from a command the bot does not have. The resolve happens on EVERY invocation, never once at
 * registration: an offboarded admin (`isActive: false`) must stop seeing the float within the 60s
 * identity cache, not at the next deploy.
 *
 * ══ WHY THIS READS PRISMA DIRECTLY INSTEAD OF DepositRepository / ReconciliationBreakService ═══
 * `eslint-plugin-boundaries` makes modules/admin -> modules/deposit and modules/admin ->
 * modules/reconciliation a BUILD FAILURE, and there is no published port for either read (the
 * existing tokens — PLAYER_LINK_PORT, PAYMENT_METHOD_PORT, APPROVAL_LIMIT_PORT — are all write
 * paths). Everything below is a read-only projection for a human to look at: no transaction, no
 * money write, nothing that needs the invariants those services own. The two constants that had to
 * be restated are marked MIRRORS and say what they mirror; if either drifts, this bot under-reports
 * a queue, which is the failure mode a comment can at least make findable.
 *
 * The float figure is the exception and is NOT restated: the ledger side is read through
 * AccountRegistryService in @core/ledger — the same service AgentFloatSyncService uses, from the
 * entries rather than the cached balance, because a stale cache would manufacture a drift.
 *
 * ══ WHY NOTHING HERE THROWS ═══════════════════════════════════════════════════════════════════
 * Same contract as every other handler in this project: the registrar swallows and logs, so a
 * throw would only cost the operator their answer. Each command degrades to a plain message.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { BreakStatus, DepositStatus, type Prisma } from '@prisma/client';
import type { Context } from 'grammy';

import type { AuthenticatedAdmin } from '@common/decorators/auth.types';
import { compareMinor, formatMinorToDecimal } from '@common/helpers/money.util';
import { AdminIdentityService } from '@core/auth/services/admin-identity.service';
import { AppConfigService } from '@core/config/config.service';
import { ICHANCY_PORT, type IchancyPort, isIchancyOk } from '@core/ichancy';
import { AccountRegistryService, ichancyAgentFloatCode } from '@core/ledger';
import { PrismaService } from '@core/prisma/prisma.service';
import { OnCommand } from '@core/telegram/decorators/handlers.decorator';

import { dualNsp } from '@common/helpers/money-display.util';

/**
 * MIRRORS `REVIEWABLE_STATUSES` in src/modules/deposit/deposit-state.machine.ts — the default
 * filter of GET /v1/admin/deposits. Restated because of the module boundary; see the header.
 */
const WAITING_STATUSES: readonly DepositStatus[] = Object.freeze([
  DepositStatus.SUBMITTED,
  DepositStatus.UNDER_REVIEW,
  DepositStatus.PENDING_SECOND_APPROVAL,
]);

/**
 * MIRRORS the default `where` of GET /v1/admin/reconciliation/breaks: work that still needs doing,
 * not the whole history. INVESTIGATING is included because somebody having opened a break does not
 * make it closed.
 */
const UNRESOLVED_BREAK_STATUSES: readonly BreakStatus[] = Object.freeze([
  BreakStatus.OPEN,
  BreakStatus.INVESTIGATING,
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

/** Severity at which a break stops being informational and starts meaning money is missing. */
const LOUD_SEVERITY = 4;

/** A phone screen, not a report. Anything longer belongs in the admin panel. */
const LIST_LIMIT = 5;

/** Telegram's HTML parse mode needs exactly these three escaped, and nothing else. */
function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * "How long has this been sitting there" at the resolution an operator acts on. Deliberately coarse:
 * nobody triages on seconds, and a compact age keeps each queue row to two short lines.
 */
function formatAge(since: Date, now: Date): string {
  const totalMinutes = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h ${totalMinutes % 60}m`;

  return `${Math.floor(totalHours / 24)}d ${totalHours % 24}h`;
}

// -----------------------------------------------------------------------------------------------
// /report period handling
// -----------------------------------------------------------------------------------------------

type ReportPeriodKey = 'day' | 'week' | 'month';

interface ReportPeriod {
  /** Arabic name printed in the report header. */
  readonly label: string;
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
function resolveReportPeriod(raw: string, now: Date): ReportPeriod | null {
  const token = raw.trim().toLowerCase();
  const key: ReportPeriodKey | undefined =
    token === '' ? 'month' : REPORT_PERIOD_ALIASES.get(token);
  if (key === undefined) return null;

  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  switch (key) {
    case 'day':
      return { label: 'اليوم', from: new Date(todayUtc), to: now };
    case 'week':
      return { label: 'آخر 7 أيام', from: new Date(todayUtc - 6 * DAY_MS), to: now };
    case 'month':
      return {
        label: 'الشهر الحالي',
        from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
        to: now,
      };
  }
}

/** "2026-08-14 09:57:17" — the competitor's timestamp shape. Always UTC; the caller labels it so. */
function formatUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

const REPORT_USAGE = [
  '<b>/report</b> — تقرير النشاط',
  'الاستخدام: <code>/report [اليوم | الأسبوع | الشهر]</code>',
  '• اليوم — منذ منتصف الليل (UTC)',
  '• الأسبوع — آخر 7 أيام',
  '• الشهر — منذ أول الشهر الحالي (الافتراضي)',
].join('\n');

@Injectable()
export class AdminTelegramHandlers {
  private readonly logger = new Logger(AdminTelegramHandlers.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admins: AdminIdentityService,
    private readonly accounts: AccountRegistryService,
    private readonly config: AppConfigService,
    @Inject(ICHANCY_PORT) private readonly ichancy: IchancyPort,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // /queue — the review backlog (mirrors GET /v1/admin/deposits)
  // ---------------------------------------------------------------------------------------------

  /**
   * WHY it counts and lists in the same breath: the count answers "is anyone waiting?" and the
   * oldest five answer "for how long?". A queue of 40 that is all four minutes old is healthy; a
   * queue of 3 whose oldest is six hours old is a player who thinks we took their money.
   *
   * Ordered OLDEST first, which is the opposite of the API's default `newest` — a bot is read on a
   * phone at 9am to find what has been ignored, not to see what just came in.
   */
  @OnCommand('queue')
  async onQueue(ctx: Context): Promise<void> {
    const admin = await this.requireAdmin(ctx);
    if (admin === null) return;

    const where = { status: { in: [...WAITING_STATUSES] } };

    const [waiting, unclaimed, oldest] = await Promise.all([
      this.prisma.depositRequest.count({ where }),
      // reviewStartedAt IS NULL means nobody has claimed it — the rows with no owner at all.
      this.prisma.depositRequest.count({ where: { ...where, reviewStartedAt: null } }),
      this.prisma.depositRequest.findMany({
        where,
        // id last so the ordering is total and two rows sharing a timestamp cannot swap places.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: LIST_LIMIT,
        select: {
          shortId: true,
          status: true,
          currencyCode: true,
          claimedAmountMinor: true,
          verifiedAmountMinor: true,
          createdAt: true,
          submittedAt: true,
          player: { select: { telegramUserId: true, telegramUsername: true } },
        },
      }),
    ]);

    if (waiting === 0) {
      await this.reply(ctx, '✅ <b>Queue is empty.</b>\nلا يوجد طلبات بانتظار المراجعة.');
      return;
    }

    const now = new Date();
    const lines = [
      `<b>Review queue</b> — ${waiting} waiting, ${unclaimed} unclaimed`,
      '<i>oldest first</i>',
      '',
    ];

    for (const row of oldest) {
      // The verified figure once an admin has set one, the player's claim until then — the same
      // precedence the admin card uses, so the two never disagree about "the amount".
      const amountMinor = row.verifiedAmountMinor ?? row.claimedAmountMinor;
      // Waiting starts when the player submitted, not when the draft was opened: an abandoned draft
      // that was finished an hour later has not been ignored for a day.
      const since = row.submittedAt ?? row.createdAt;
      const who =
        row.player.telegramUsername === null
          ? `id ${row.player.telegramUserId.toString()}`
          : `@${row.player.telegramUsername}`;

      lines.push(
        `<code>${esc(row.shortId)}</code> · <b>${formatMinorToDecimal(amountMinor)} ${esc(row.currencyCode)}</b>`,
        `   ${esc(who)} · ${formatAge(since, now)} · ${esc(row.status)}`,
      );
    }

    if (waiting > oldest.length) {
      lines.push('', `<i>… and ${waiting - oldest.length} more.</i>`);
    }
    lines.push('', '<i>The cards with Claim/Approve/Reject are in the admin group.</i>');

    await this.reply(ctx, lines.join('\n'));
  }

  // ---------------------------------------------------------------------------------------------
  // /float — what pays for every credit (mirrors POST /v1/admin/reconciliation/agent-float/sync)
  // ---------------------------------------------------------------------------------------------

  /**
   * WHY this READS and never records: the endpoint it mirrors opens an AGENT_FLOAT_MISMATCH break
   * when the two sides disagree, and a break is a piece of work assigned to a human. Someone
   * checking a number from their phone must not be able to manufacture one by accident, so the
   * hourly AgentFloatSyncService tick keeps sole ownership of opening breaks and this command only
   * reports what it would see.
   *
   * WHY the ledger figure is computed from the entries: it is about to be compared against an
   * outside source, and the cached balance would invent a drift that does not exist.
   */
  @OnCommand('float')
  async onFloat(ctx: Context): Promise<void> {
    const admin = await this.requireAdmin(ctx);
    if (admin === null) return;

    const currency = this.config.ichancy.currency;
    const watermark = this.config.limits.agentFloatLowWatermarkMinor;

    const ledgerMinor = await this.ledgerFloatMinor();

    const wallet = await this.ichancy.getAgentWallet({ correlationId: 'telegram:/float' });

    const lines = [
      `<b>Agent float</b> — ${esc(currency)}`,
      '',
      `Ledger <code>ICHANCY_AGENT_FLOAT</code>: <b>${formatMinorToDecimal(ledgerMinor)}</b>`,
    ];

    // What we judge against the watermark: the spendable figure Ichancy reports when we could read
    // it, because that is what an approval is actually drawn against. Our books are the fallback.
    let spendableMinor = ledgerMinor;

    if (isIchancyOk(wallet)) {
      // `availableWallet`, not `balance` — a credit line we may not spend is not our float.
      const availableMinor = wallet.data.availableMinor;
      spendableMinor = availableMinor;

      const deltaMinor = availableMinor - ledgerMinor;
      lines.push(
        `Ichancy available: <b>${formatMinorToDecimal(availableMinor)}</b>`,
        `Ichancy balance: ${formatMinorToDecimal(wallet.data.balanceMinor)}`,
        `Difference (ichancy − ledger): <b>${formatMinorToDecimal(deltaMinor)}</b>`,
      );

      if (deltaMinor !== 0n) {
        lines.push(
          deltaMinor > 0n
            ? '<i>They hold MORE than our books: probably an out-of-band top-up.</i>'
            : '<i>They hold LESS than our books: money left the agent wallet outside this system.</i>',
        );
      }
    } else {
      const cause = wallet.kind === 'rejected' ? `${wallet.code}: ${wallet.message}` : wallet.cause;
      // Never present the ledger figure as if both sides agreed. We learned nothing about Ichancy.
      lines.push(
        '',
        '⚠️ <b>Ledger figure only</b> — the live Ichancy wallet could not be read,',
        'so there is no difference to show.',
        `<code>${esc(cause)}</code>`,
      );
    }

    lines.push('', `Low watermark: ${formatMinorToDecimal(watermark)} ${esc(currency)}`);

    if (spendableMinor < watermark) {
      lines.unshift(
        '🚨🚨 <b>AGENT FLOAT IS BELOW THE WATERMARK</b> 🚨🚨',
        'الرصيد منخفض — عبّي الحساب.',
        'Approvals will start failing with <code>AGENT_FLOAT_INSUFFICIENT</code> once it runs out,',
        'and a failed credit lands on a player who has already paid.',
        '',
      );
    }

    lines.push('<i>Read-only: the hourly sync is what opens a break.</i>');

    await this.reply(ctx, lines.join('\n'));
  }

  // ---------------------------------------------------------------------------------------------
  // /breaks — the morning number (mirrors GET /v1/admin/reconciliation/breaks)
  // ---------------------------------------------------------------------------------------------

  /**
   * OPEN and INVESTIGATING are counted separately and listed together: the split says whether
   * anyone has picked the work up, but an unfinished investigation is still unfinished money.
   */
  @OnCommand('breaks')
  async onBreaks(ctx: Context): Promise<void> {
    const admin = await this.requireAdmin(ctx);
    if (admin === null) return;

    const [open, investigating, oldest] = await Promise.all([
      this.prisma.reconciliationBreak.count({ where: { status: BreakStatus.OPEN } }),
      this.prisma.reconciliationBreak.count({ where: { status: BreakStatus.INVESTIGATING } }),
      this.prisma.reconciliationBreak.findMany({
        where: { status: { in: [...UNRESOLVED_BREAK_STATUSES] } },
        // Oldest first: the API pages newest-first for browsing, but the break nobody has touched
        // since Tuesday is the one that has been costing us for the longest.
        orderBy: [{ detectedAt: 'asc' }, { id: 'asc' }],
        take: LIST_LIMIT,
        select: {
          id: true,
          category: true,
          status: true,
          severity: true,
          currencyCode: true,
          deltaMinor: true,
          detectedAt: true,
        },
      }),
    ]);

    if (open === 0 && investigating === 0) {
      await this.reply(ctx, '✅ <b>No open reconciliation breaks.</b>\nالحسابات مضبوطة.');
      return;
    }

    const now = new Date();
    const lines = [
      `<b>Reconciliation breaks</b> — ${open} open, ${investigating} investigating`,
      '<i>oldest first</i>',
      '',
    ];

    for (const row of oldest) {
      const marker = row.severity >= LOUD_SEVERITY ? '🔴' : '🟡';
      // A break carries a delta only when it was detected by comparing two numbers; a STUCK_DEPOSIT
      // has nothing to subtract, and printing "0.00" there would read as "nothing is wrong".
      const delta =
        row.deltaMinor === null
          ? 'no delta'
          : `Δ ${formatMinorToDecimal(row.deltaMinor)} ${esc(row.currencyCode)}`;

      lines.push(
        `${marker} <b>${esc(row.category)}</b> · sev ${row.severity}`,
        `   ${delta} · ${formatAge(row.detectedAt, now)} old · ${esc(row.status)}`,
        // The uuid prefix is enough to find the row and short enough to read aloud on a call.
        `   <code>${esc(row.id.slice(0, 8))}</code>`,
      );
    }

    const unresolved = open + investigating;
    if (unresolved > oldest.length) {
      lines.push('', `<i>… and ${unresolved - oldest.length} more.</i>`);
    }
    lines.push('', '<i>Resolve them in the admin panel — a break is closed with a note.</i>');

    await this.reply(ctx, lines.join('\n'));
  }

  // ---------------------------------------------------------------------------------------------
  // /report — the competitor-style activity report, from OUR database
  // ---------------------------------------------------------------------------------------------

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
   *
   * WHY this one wraps its body in try/catch where /queue does not: the report is seven reads, and
   * the registrar's swallow would turn any one hiccup into silence. An explicit failure message
   * costs three lines and tells the operator to simply try again.
   */
  @OnCommand('report')
  async onReport(ctx: Context): Promise<void> {
    const admin = await this.requireAdmin(ctx);
    if (admin === null) return;

    // `ctx.match` is whatever followed "/report"; grammY types it string | RegExpMatchArray.
    const raw = typeof ctx.match === 'string' ? ctx.match : '';
    const period = resolveReportPeriod(raw, new Date());
    if (period === null) {
      await this.reply(ctx, REPORT_USAGE);
      return;
    }

    try {
      await this.reply(ctx, await this.buildReport(period));
    } catch (error: unknown) {
      this.logger.warn(`/report failed: ${describeError(error)}`);
      await this.reply(ctx, '⚠️ تعذر إنشاء التقرير — حاول مرة أخرى بعد قليل.');
    }
  }

  private async buildReport(period: ReportPeriod): Promise<string> {
    const inPeriod = { gte: period.from, lt: period.to };

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
      `📅 من: ${formatUtc(period.from)} (UTC)`,
      `📅 إلى: ${formatUtc(period.to)} (UTC)`,
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

  /**
   * The ledger side of the agent float — THE account-code logic, shared by /float and /report so
   * the two commands can never disagree about which account "the float" is. From the entries, not
   * the cached balance, for the reason documented on /float.
   */
  private async ledgerFloatMinor(): Promise<bigint> {
    const currency = this.config.ichancy.currency;
    const account = await this.accounts.findByCode(this.prisma, ichancyAgentFloatCode(currency));
    // A float account that has never been posted to is genuinely zero, not missing.
    return account === null
      ? 0n
      : this.accounts.computeBalanceFromEntries(this.prisma, account.id);
  }

  // ---------------------------------------------------------------------------------------------
  // Shared
  // ---------------------------------------------------------------------------------------------

  /**
   * THE authority check for every command in this file. Returns null for a bot, for a user we
   * cannot identify, for someone who is not staff, and for a lookup that failed — and the caller
   * answers all four the same way, with silence. See the header for why.
   */
  private async requireAdmin(ctx: Context): Promise<AuthenticatedAdmin | null> {
    const from = ctx.from;
    if (from === undefined || from.is_bot) return null;

    try {
      return await this.admins.resolve(BigInt(from.id));
    } catch (error: unknown) {
      // Failing CLOSED: a database or cache hiccup must not hand out the float, so an unreadable
      // identity is treated as "not an admin" rather than surfaced to the caller.
      this.logger.warn(`Admin lookup failed for Telegram user ${from.id}: ${describeError(error)}`);
      return null;
    }
  }

  private async reply(ctx: Context, text: string): Promise<void> {
    try {
      await ctx.reply(text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (error: unknown) {
      // Blocked bot, deleted chat, a rate limit that survived autoRetry — none of these mean the
      // command failed, and none of them may reach the registrar as a throw.
      this.logger.warn(`Reply failed for update ${ctx.update.update_id}: ${describeError(error)}`);
    }
  }
}
