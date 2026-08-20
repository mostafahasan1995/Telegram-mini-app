/**
 * TELL A HUMAN WHEN ICHANCY GOES DOWN — once per state change, never once per failure.
 *
 * ══ WHY THIS EXISTS ═══════════════════════════════════════════════════════════════════════════
 * On 2026-08-20 the integration answered every call with a Cloudflare challenge for HOURS and no
 * alarm existed to fire. The one cron that touches Ichancy — the 5-minute agent float sync —
 * detected the outage twelve times an hour and, correctly, opened no break: a failed wallet read
 * tells you nothing about the float. Nobody ever wrote the other half, which is saying that we
 * could not look. The owner found out by noticing a player who had no casino account.
 *
 * ══ WHY IT IS A SEPARATE CRON AND NOT A LINE IN THE FLOAT SYNC ════════════════════════════════
 * The float sync sees one endpoint. The breaker it reads (IchancyHealthService) is fed from
 * IchancyHttpClient, which every agent-API call in both roles passes through — so a burst of failed
 * player registrations trips it just as a failed wallet read does, and the alert can name which
 * endpoint died.
 *
 * ══ WHY THE MARKER AND THE LOCK ARE BOTH NEEDED ═══════════════════════════════════════════════
 * The cron lock serialises two ticks; it does NOT remember that the first one posted (spelled out
 * at the top of report-schedule.cron.ts). "Announce this transition exactly once, cluster-wide" is a
 * separate atomic claim — `SET key iso EX 86400 NX` — keyed by the state AND the timestamp it began,
 * exactly as AgentFloatSyncService.warnLowFloat and ReportScheduleCron.postIfDue do it. Without it
 * a one-minute cron would post twelve times an hour for the whole outage, which is how operators
 * learn to skim past alarms.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { LockService } from '@core/cache/lock.service';
import { RedisService } from '@core/cache/redis.service';
import { AppConfigService } from '@core/config/config.service';
import { IchancyHealthService, type IchancyHealthSnapshot } from '@core/ichancy';
import { PrismaService } from '@core/prisma/prisma.service';
import { BotService } from '@core/telegram/services/bot.service';

import {
  ICHANCY_HEALTH_ALERT_INTERVAL_MS,
  ICHANCY_HEALTH_ALERT_LOCK_TTL_MS,
  ICHANCY_HEALTH_ANNOUNCE_TTL_SECONDS,
} from '../reconciliation.constants';

/** Twelve, matching PLAYER_LINK_MAX_ATTEMPTS — restated rather than imported: modules/A -> modules/B. */
const PARKED_ATTEMPTS = 12;

const formatDuration = (ms: number): string => {
  // Math.floor throughout: the repo bans Math.round because rounding MONEY with it is a bug, and an
  // outage duration is not worth weakening that rule for.
  if (ms < 60_000) return `${String(Math.max(1, Math.floor(ms / 1000)))} ثانية`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${String(minutes)} دقيقة`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${String(hours)} ساعة` : `${String(hours)} ساعة و${String(rest)} دقيقة`;
};

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

@Injectable()
export class IchancyHealthAlertCron {
  private readonly logger = new Logger(IchancyHealthAlertCron.name);

  constructor(
    private readonly health: IchancyHealthService,
    private readonly bot: BotService,
    private readonly locks: LockService,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  @Interval('ichancy-health-alert', ICHANCY_HEALTH_ALERT_INTERVAL_MS)
  async tick(): Promise<void> {
    if (!this.config.app.isWorker) return;
    // The fake adapter cannot be down, so a verdict about it would be a verdict about a fixture —
    // and an alarm on every dev boot is how operators learn to ignore alarms.
    if (this.config.ichancy.fake) return;

    const handle = await this.locks.acquire(
      LockService.key('cron', 'ichancy-health-alert'),
      ICHANCY_HEALTH_ALERT_LOCK_TTL_MS,
    );
    if (handle === null) return;

    try {
      await this.announceIfChanged();
    } catch (cause) {
      this.logger.error(
        `ichancy health alert failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      await this.locks.release(handle).catch(() => false);
    }
  }

  /** Exposed for the admin endpoint and for tests. */
  async announceIfChanged(): Promise<'posted' | 'quiet'> {
    const snapshot = await this.health.snapshot();

    // A steady UP with nothing ever having failed is the overwhelmingly common case; leave without
    // touching Redis or Telegram.
    if (snapshot.state === 'UP' && snapshot.recoveredAt === null) return 'quiet';

    const anchor = snapshot.state === 'DOWN' ? snapshot.since : snapshot.recoveredAt;
    if (anchor === null) return 'quiet';

    // CLAIMED BEFORE POSTING, atomically: two replicas that both slipped past the lock must not both
    // announce. Keyed by state + anchor so the next transition is a different key.
    const markerKey = `ichancy:health:announced:${snapshot.state}:${anchor.toISOString()}`;
    const claimed = await this.redis.set(
      markerKey,
      new Date().toISOString(),
      'EX',
      ICHANCY_HEALTH_ANNOUNCE_TTL_SECONDS,
      'NX',
    );
    if (claimed !== 'OK') return 'quiet';

    const text =
      snapshot.state === 'DOWN' ? this.downMessage(snapshot) : await this.upMessage(snapshot);

    // notifyAdmins ONLY, never notifyFeed: the feed chat may contain customers, and "the casino
    // integration is down" reads to them as "my money is gone".
    const sent = await this.bot.notifyAdmins(text, { parseMode: 'HTML', linkPreview: false });
    if (sent === null) {
      // notifyAdmins returns null rather than throwing when the chat is unreachable. Keeping the
      // marker would mean we had "alerted" into a void and would never try again — so drop it and
      // let the next tick retry.
      await this.redis.del(markerKey).catch(() => 0);
      this.logger.error(
        `Ichancy is ${snapshot.state} but the admin chat is unreachable; will retry next tick`,
      );
      return 'quiet';
    }

    if (snapshot.state === 'UP' && snapshot.recoveredAt !== null) {
      // Retire the transition now that a human has actually received it. The marker above only
      // stops a BURST — it expires after a day, while `recoveredAt` lived in the hash forever, so
      // without this the same recovery was re-announced every 24 hours until the next outage.
      // Deliberately AFTER a successful send: an unreachable admin chat leaves it pending so the
      // next tick tries again.
      await this.health.acknowledgeRecovery(snapshot.recoveredAt);
    }

    this.logger.warn(`announced Ichancy ${snapshot.state} to the admin group`);
    return 'posted';
  }

  // ── messages ─────────────────────────────────────────────────────────────────────────────────

  private downMessage(snapshot: IchancyHealthSnapshot): string {
    const since = snapshot.since;
    const lines = [
      '🚨 <b>تكامل Ichancy متوقف</b>',
      `النوع: <code>${escapeHtml(snapshot.kind ?? 'UNKNOWN')}</code>`,
      `عدد المحاولات الفاشلة المتتالية: ${String(snapshot.consecutive)}`,
      `منذ: ${since === null ? 'غير معروف' : since.toISOString()}`,
      `آخر نداء: <code>${escapeHtml(snapshot.lastEndpoint ?? 'unknown')}</code>`,
    ];
    if (snapshot.lastMessage !== null) {
      lines.push(`الرسالة: <code>${escapeHtml(snapshot.lastMessage)}</code>`);
    }
    lines.push(
      '',
      // The consequence operators actually care about, stated before the checklist: nobody has to
      // guess whether players are being lost while this is happening.
      '⏸ تسجيل اللاعبين الجدد <b>متوقف مؤقتاً</b> وسيُستأنف تلقائياً عند عودة الخدمة.',
      '',
      '<b>ما الذي يجب فعله:</b>',
      '• تأكد أن <code>ICHANCY_TRANSPORT=browser</code>.',
      '• شغّل <code>npm run ichancy:check:signin</code>.',
      '• تأكد من تثبيت Chromium: <code>npm run playwright:install</code>.',
      '• اطلب من Ichancy إضافة عنوان IP الخادم إلى القائمة البيضاء.',
    );
    return lines.join('\n');
  }

  private async upMessage(snapshot: IchancyHealthSnapshot): Promise<string> {
    const outage =
      snapshot.since !== null && snapshot.recoveredAt !== null
        ? formatDuration(snapshot.recoveredAt.getTime() - snapshot.since.getTime())
        : null;

    const [pending, parked] = await Promise.all([
      this.prisma.player.count({ where: { status: 'PENDING_ICHANCY', ichancyPlayerId: null } }),
      this.prisma.player.count({
        where: {
          status: 'PENDING_ICHANCY',
          ichancyPlayerId: null,
          ichancyLinkAttempts: { gte: PARKED_ATTEMPTS },
        },
      }),
    ]);

    const lines = [
      '✅ <b>عاد تكامل Ichancy للعمل</b>',
      outage === null ? 'مدة الانقطاع: غير معروفة' : `مدة الانقطاع: ${outage}`,
      // So an operator can watch the backfill drain instead of wondering whether it ran.
      `لاعبون بانتظار فتح الحساب: ${String(pending)}`,
    ];
    if (parked > 0) {
      // A parked player is the one case the backfill will NOT rescue on its own — it needs a human.
      lines.push(
        `⚠️ منهم <b>${String(parked)}</b> متوقفون بعد استنفاد المحاولات ويحتاجون تدخلاً يدوياً ` +
          '(<code>npm run player:register -- --player-id …</code>).',
      );
    }
    return lines.join('\n');
  }
}
