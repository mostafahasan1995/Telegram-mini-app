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
 * money write, nothing that needs the invariants those services own. The constants that had to be
 * restated are marked MIRRORS and say what they mirror; if either drifts, this bot under-reports a
 * queue, which is the failure mode a comment can at least make findable. WAITING_STATUSES is one of
 * them and is IMPORTED from ActivityReportService rather than copied, because /queue and /report
 * must mean the same thing by "waiting".
 *
 * The float figure is the exception and is NOT restated: the ledger side is read through
 * ActivityReportService.ledgerFloatMinor(), which reads AccountRegistryService in @core/ledger —
 * the same service AgentFloatSyncService uses, from the entries rather than the cached balance,
 * because a stale cache would manufacture a drift. /float and /report share that one method so the
 * two commands can never disagree about which account "the float" is.
 *
 * ══ WHY /report IS THREE LINES HERE ═══════════════════════════════════════════════════════════
 * Its body lives in ActivityReportService so a scheduled sender can render byte-identical numbers
 * without a second copy of the report. This file owns only the Telegram-shaped part: read the
 * argument, print the usage text or the report, never throw.
 *
 * ══ WHY NOTHING HERE THROWS ═══════════════════════════════════════════════════════════════════
 * Same contract as every other handler in this project: the registrar swallows and logs, so a
 * throw would only cost the operator their answer. Each command degrades to a plain message.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { BreakStatus } from '@prisma/client';
import type { Context } from 'grammy';

import type { AuthenticatedAdmin } from '@common/decorators/auth.types';
import { formatMinorToDecimal } from '@common/helpers/money.util';
import { AdminIdentityService } from '@core/auth/services/admin-identity.service';
import { AppConfigService } from '@core/config/config.service';
import { ICHANCY_PORT, type IchancyPort, isIchancyOk } from '@core/ichancy';
import { PrismaService } from '@core/prisma/prisma.service';
import { OnCommand } from '@core/telegram/decorators/handlers.decorator';

import {
  AdminLoginCodeService,
  LOGIN_CODE_TTL_MINUTES,
} from '../services/admin-login-code.service';
import {
  ActivityReportService,
  REPORT_USAGE,
  WAITING_STATUSES,
} from '../services/activity-report.service';

/**
 * MIRRORS the default `where` of GET /v1/admin/reconciliation/breaks: work that still needs doing,
 * not the whole history. INVESTIGATING is included because somebody having opened a break does not
 * make it closed.
 */
const UNRESOLVED_BREAK_STATUSES: readonly BreakStatus[] = Object.freeze([
  BreakStatus.OPEN,
  BreakStatus.INVESTIGATING,
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

@Injectable()
export class AdminTelegramHandlers {
  private readonly logger = new Logger(AdminTelegramHandlers.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admins: AdminIdentityService,
    private readonly activityReport: ActivityReportService,
    private readonly config: AppConfigService,
    private readonly loginCodes: AdminLoginCodeService,
    @Inject(ICHANCY_PORT) private readonly ichancy: IchancyPort,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // /login — hand this Telegram account a one-time code for the manager console
  // ---------------------------------------------------------------------------------------------

  /**
   * WHY THIS COMMAND EXISTS: the native admin console cannot produce Telegram initData, so it has no
   * way to prove who it is. This bot already knows — Telegram signed the update, and
   * AdminIdentityService mapped it to active staff. The code carries that proof to the app.
   *
   * WHY IT IS `/console` AND NOT `/login`: `/login` belongs to the PLAYER app, which every user of
   * this bot can reach. grammY's `bot.command()` registers middleware, so two handlers on the same
   * command means only the first-registered one ever runs — and since this handler returns silently
   * for non-admins, a player sending /login would have got nothing at all. Most people here are
   * players, so they keep the obvious verb; staff type a word that names the thing they are opening.
   * A person who is BOTH (the owner is) then gets to say which credential they want, instead of the
   * bot guessing.
   *
   * WHY IT REFUSES OUTSIDE A PRIVATE CHAT, LOUDLY: a login code posted in the admin supergroup is a
   * credential handed to everyone in it, and `ctx.reply` answers wherever the command was sent. The
   * group check is therefore not politeness, it is the security boundary. This is also the ONE place
   * in this file that answers a non-private chat instead of returning silently — the caller is
   * already a confirmed admin, so there is no surface to leak, and silence here would read as "the
   * bot is broken" and get retried in the group.
   */
  @OnCommand('console')
  async onConsoleLogin(ctx: Context): Promise<void> {
    const admin = await this.requireAdmin(ctx);
    if (admin === null) return;

    if (ctx.chat?.type !== 'private') {
      await ctx.reply(
        'Not here — a login code must never be posted in a group. ' +
          // /console, not /login: /login is the PLAYER command and would hand an admin a player
          // code, redeemable only on the player route (LoginCodeService scopes the two apart).
          'Open a direct chat with me and send /console there.',
      );
      return;
    }

    try {
      const { code } = await this.loginCodes.mint(admin);

      await ctx.reply(
        `<b>Manager console login</b>\n\n` +
          `<code>${esc(code)}</code>\n\n` +
          `Valid for ${LOGIN_CODE_TTL_MINUTES} minutes, once. ` +
          `Type it into the console's sign-in screen.\n\n` +
          `If you did not ask for this, ignore it — a code is useless without the app, ` +
          `and sending /console again cancels this one.`,
        { parse_mode: 'HTML' },
      );
    } catch (error: unknown) {
      // Same contract as every handler here: never throw, always leave the operator an answer.
      this.logger.error(`/login failed for ${admin.adminUserId}: ${describeError(error)}`);
      await ctx.reply('Could not issue a code right now. Try again in a moment.');
    }
  }

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

    const ledgerMinor = await this.activityReport.ledgerFloatMinor();

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
   * The report itself is ActivityReportService's — see that file for why sections vanish instead of
   * printing zeros and why the deposit numbers filter on creditedAt/decidedAt.
   *
   * WHY this one wraps its body in try/catch where /queue does not: the report is seven reads, and
   * the registrar's swallow would turn any one hiccup into silence. An explicit failure message
   * costs three lines and tells the operator to simply try again.
   */
  @OnCommand('report')
  async onReport(ctx: Context): Promise<void> {
    const admin = await this.requireAdmin(ctx);
    if (admin === null) return;

    // Captured before parsing so the header and every period-bound query share one instant.
    const now = new Date();
    // `ctx.match` is whatever followed "/report"; grammY types it string | RegExpMatchArray.
    const raw = typeof ctx.match === 'string' ? ctx.match : undefined;
    const period = this.activityReport.resolveReportPeriod(raw);
    if (period === null) {
      await this.reply(ctx, REPORT_USAGE);
      return;
    }

    try {
      await this.reply(ctx, await this.activityReport.buildReport(period, now));
    } catch (error: unknown) {
      this.logger.warn(`/report failed: ${describeError(error)}`);
      await this.reply(ctx, '⚠️ تعذر إنشاء التقرير — حاول مرة أخرى بعد قليل.');
    }
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
