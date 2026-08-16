/**
 * Posts the activity report on its own, every REPORT_SCHEDULE_HOURS, so the numbers arrive without
 * anybody having to remember to type /report. The report itself is ActivityReportService's — this
 * class owns only WHEN it goes out and WHERE, and it renders byte-identical numbers to the command
 * because there is exactly one renderer.
 *
 * ══ WHY A FIXED TICK + A REDIS MARKER, NOT A DYNAMIC SchedulerRegistry INTERVAL ═══════════════
 * `@Interval` takes a compile-time constant, and the cadence is configuration. The obvious
 * alternative is to skip the decorator and call `SchedulerRegistry.addInterval()` at boot with a
 * `setInterval` of the configured period. That is rejected for three reasons, in order of how badly
 * they bite:
 *
 *  1. A setInterval's phase is PROCESS START TIME. Every deploy re-anchors the schedule, and a
 *     worker that restarts more often than the period — a rolling deploy, an OOM kill, a crash loop
 *     — would post NEVER, while looking perfectly healthy. Here the schedule lives in Redis, so a
 *     restart neither re-posts nor resets anything: the marker just keeps counting down.
 *  2. It is per-process. Two worker replicas each get their own timer on their own phase and both
 *     fire. The cron lock does not fix that on its own — it SERIALISES two ticks, it does not
 *     remember that the first one already posted. The marker is what makes "already posted" a fact
 *     the whole cluster shares; the lock is what stops two ticks racing to claim it in the same
 *     millisecond. Both are needed, and neither replaces the other.
 *  3. Nothing durable would record that a post happened, so the only way to answer "is it due?"
 *     would be process memory — which is exactly what a restart destroys.
 *
 * The cost of this shape is that the schedule has a resolution of one tick (REPORT_SCHEDULE_TICK_MS,
 * ten minutes) instead of being exact. On a 1..168 hour cadence that is invisible.
 *
 * ══ WHY SET NX EX AND NOT GET-THEN-SET ════════════════════════════════════════════════════════
 * `SET key <now> EX <window> NX` is the check AND the claim in one atomic round trip. A GET followed
 * by a SET would let two workers that both read "no marker" in the same millisecond each decide the
 * report is due, and the operator would get it twice. The TTL is what expires the claim, so there is
 * also no clock arithmetic to get wrong and no timestamp to compare across two machines' clocks.
 *
 * ══ WHY THE MARKER IS RELEASED ON A BUILD FAILURE BUT NOT ON A SEND FAILURE ═══════════════════
 * If buildReport() throws, nothing was sent, so giving the claim back is free: the next tick retries
 * ten minutes later instead of one slow database costing the whole window. If the SEND throws, we do
 * not know whether Telegram delivered it — grammY retries 429/5xx internally, and a timeout on the
 * far side of a successful send looks identical to a failure. Re-posting on a maybe would put the
 * same report in the group twice; staying quiet costs one period of an informational message that
 * any admin can reproduce with /report. So the ambiguous case keeps the claim.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { LockService } from '@core/cache/lock.service';
import { RedisService } from '@core/cache/redis.service';
import { AppConfigService } from '@core/config/config.service';
import { BotService } from '@core/telegram/services/bot.service';

import {
  REPORT_LAST_POSTED_KEY,
  REPORT_SCHEDULE_INTERVAL_NAME,
  REPORT_SCHEDULE_LOCK_TTL_MS,
  REPORT_SCHEDULE_TICK_MS,
} from '../admin.constants';
import { ActivityReportService, type ReportPeriodKey } from './activity-report.service';

/**
 * WHICH report goes out: "اليوم", since 00:00 UTC.
 *
 * WHY the day and not the month (which is /report's default): a message that arrives every few hours
 * is a running score of the shift it belongs to. The month-to-date figure barely moves between two
 * posts six hours apart, so it would read as the same message resent — and the operator would learn
 * to ignore it. Anyone who wants the wider window still types `/report الشهر`.
 *
 * Typed as ReportPeriodKey so this can only ever be a period the report service actually has; it is
 * resolved through resolveReportPeriod() so the Arabic label comes from the ONE table that owns it.
 */
export const SCHEDULED_REPORT_PERIOD: ReportPeriodKey = 'day';

/**
 * The one line that separates this from a report an admin ran by hand. It matters: /report is often
 * typed to check something specific, and an unexplained report appearing next to it would read as
 * somebody else's answer to somebody else's question.
 */
export const SCHEDULED_REPORT_HEADER = '🕒 <b>تقرير دوري</b>';

const SECONDS_PER_HOUR = 3600;

/**
 * THE PURE PART OF THE SCHEDULE, and the only part with arithmetic worth testing: how long the
 * marker must live, given the configured interval. Returns null when the schedule is OFF
 * (REPORT_SCHEDULE_HOURS=0 or blank), so the caller has exactly one branch to write.
 *
 * WHY the TTL is the interval MINUS one tick, and not the interval: the marker expiring is what
 * lets the next tick post, and ticks fire on their own fixed phase. With a TTL of exactly N hours
 * the marker expires just AFTER the tick that should have posted, so the post lands on the FOLLOWING
 * tick — and since each post re-arms the marker from its own (now later) timestamp, the report walks
 * later by up to a tick every single period. Subtracting one tick keeps every post inside
 * (interval − tick, interval] of the previous one, so the configured interval stays an UPPER bound
 * and the schedule stays anchored. Erring a few minutes early is the right side to err on; erring
 * late compounds.
 *
 * The floor of one second is not reachable with the configured range (the smallest interval is an
 * hour and the tick is ten minutes) — it is there so a future, longer tick can never ask Redis for
 * an `EX 0`, which is an error, or a negative TTL, which is an instant expiry and therefore a report
 * on every tick.
 */
export function reportMarkerTtlSeconds(
  hours: number,
  tickMs: number = REPORT_SCHEDULE_TICK_MS,
): number | null {
  if (!Number.isFinite(hours) || hours <= 0) return null;

  const intervalSeconds = Math.floor(hours * SECONDS_PER_HOUR);
  // Ceil the tick: a marker must never outlive its window by a rounding remainder.
  const tickSeconds = Math.ceil(tickMs / 1000);
  return Math.max(1, intervalSeconds - tickSeconds);
}

@Injectable()
export class ReportScheduleCron {
  private readonly logger = new Logger(ReportScheduleCron.name);

  constructor(
    private readonly reports: ActivityReportService,
    private readonly locks: LockService,
    private readonly redis: RedisService,
    private readonly bot: BotService,
    private readonly config: AppConfigService,
  ) {}

  @Interval(REPORT_SCHEDULE_INTERVAL_NAME, REPORT_SCHEDULE_TICK_MS)
  async tick(): Promise<void> {
    // Belt and braces: ScheduleModule is worker-only, so in the api role this decorator is inert.
    if (!this.config.app.isWorker) return;

    const markerTtlSeconds = reportMarkerTtlSeconds(this.config.telegram.reportScheduleHours);
    // REPORT_SCHEDULE_HOURS=0 (or blank). The /report command is unaffected.
    if (markerTtlSeconds === null) return;

    const handle = await this.locks.acquire(
      LockService.key('cron', REPORT_SCHEDULE_INTERVAL_NAME),
      REPORT_SCHEDULE_LOCK_TTL_MS,
    );
    if (handle === null) return;

    try {
      // Captured ONCE: the same instant is the report's clock and the marker's value, so "last
      // posted at" and the header of the thing that was posted can never disagree.
      await this.postIfDue(markerTtlSeconds, new Date());
    } catch (cause) {
      // A cron that throws is an unhandled rejection. It must be visible, and it must stop here.
      this.logger.error(
        `scheduled report failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      await this.locks.release(handle).catch(() => false);
    }
  }

  /** Claim the window, or find out somebody already has. See the header for why SET NX EX. */
  private async postIfDue(markerTtlSeconds: number, now: Date): Promise<void> {
    const claimed = await this.redis.set(
      REPORT_LAST_POSTED_KEY,
      now.toISOString(),
      'EX',
      markerTtlSeconds,
      'NX',
    );
    // The marker is still alive: less than REPORT_SCHEDULE_HOURS have passed since the last post,
    // OR another replica claimed this window a moment ago. Either way, nothing to do.
    if (claimed === null) return;

    const period = this.reports.resolveReportPeriod(SCHEDULED_REPORT_PERIOD);
    if (period === null) {
      // Unreachable: every period key is one of its own aliases, which report-schedule.cron.spec.ts
      // pins. Throwing beats posting a report for a period nobody chose.
      throw new Error(`unknown scheduled report period "${SCHEDULED_REPORT_PERIOD}"`);
    }

    let body: string;
    try {
      body = await this.reports.buildReport(period, now);
    } catch (cause) {
      // The ONE place the claim is handed back — nothing has been sent, so a retry cannot duplicate.
      await this.redis.del(REPORT_LAST_POSTED_KEY);
      throw cause;
    }

    const delivered = await this.post(`${SCHEDULED_REPORT_HEADER}\n\n${body}`);
    if (!delivered) {
      // BotService swallows "chat not found" / "not enough rights" and returns null, because for a
      // deposit notification that is not a failure of the deposit. For THIS it is the whole job, and
      // it means a chat id is wrong or the bot was removed from the group — say so.
      this.logger.warn('scheduled report was not delivered: the target chat is unreachable');
      return;
    }

    this.logger.log(
      `scheduled report posted (${period.key}); next in ${this.config.telegram.reportScheduleHours}h`,
    );
  }

  /**
   * WHERE IT POSTS: the feed group when one is configured, the ADMIN group when none is.
   *
   * WHY NOT simply notifyFeed(): that call is a NO-OP when TELEGRAM_FEED_CHAT_ID is unset, and the
   * deployment this was built for runs a SINGLE group. A scheduled report that silently posts
   * nowhere because an OPTIONAL second group was never configured is a feature that does not exist,
   * and nothing in the logs would say so. So the target is `feedChatId ?? adminChatId`, spelled as
   * two calls because BotService is the only thing allowed to know the chat ids.
   *
   * THE FLOAT RULE — why the feed branch also requires feedFullDetail:
   * this report contains رصيد الكاشيرة, the ICHANCY_AGENT_FLOAT balance. That is the exact figure
   * the masked feed card strips out on purpose, and the reason the low-float warning is
   * notifyAdmins-only. Sending the masked card and then the unmasked number to the same chat would
   * mask nothing while looking like it did — the worst kind of security control. So a feed group
   * receives this report ONLY when it has been declared staff-only via TELEGRAM_FEED_FULL_DETAIL;
   * a masked (customer-visible) feed falls back to the admin group, which always gets it.
   *
   * The two flags therefore mean one coherent thing: feedFullDetail is "this chat may see money",
   * and every float-bearing message honours it.
   *
   * Returns false when Telegram says the chat cannot receive messages at all. The feed branch is
   * only taken when a feed chat IS configured, so a false from it means "unreachable" and never
   * "unconfigured" — the ambiguity notifyFeed() normally carries cannot arise here.
   */
  private async post(text: string): Promise<boolean> {
    const options = { parseMode: 'HTML', linkPreview: false } as const;
    const { feedChatId, feedFullDetail } = this.config.telegram;

    const sent =
      feedChatId !== null && feedFullDetail
        ? await this.bot.notifyFeed(text, options)
        : await this.bot.notifyAdmins(text, options);

    return sent !== null;
  }
}
