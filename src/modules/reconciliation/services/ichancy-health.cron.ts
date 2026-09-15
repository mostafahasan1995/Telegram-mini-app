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
 * separate atomic claim — `SET key in-flight EX 600 NX`, rewritten as `sent` for a day once delivered
 (below) — keyed by the operator, the state AND the timestamp it began,
 * exactly as AgentFloatSyncService.warnLowFloat and ReportScheduleCron.postIfDue do it. Without it
 * a one-minute cron would post twelve times an hour for the whole outage, which is how operators
 * learn to skim past alarms.
 *
 * ══ WHO IS TOLD ═══════════════════════════════════════════════════════════════════════════════
 * Every ACTIVE operator, in its own admin group, through its own bot. The agent API is shared today
 * (one session, one set of credentials), so its outage stops every operator's registrations and
 * credits at once, and the people who field the players' complaints are each operator's staff. The
 * dashboard's own notification model agrees: SYSTEM_ALERT is a category an OPERATOR's destinations
 * subscribe to (API-CONTRACT.md, "Telegram destinations"); there is no platform chat and no platform
 * bot. Each operator gets its own claim marker, so one whose bot or chat is broken is retried on the
 * next tick without re-alerting the operators that already heard, and the recovery is retired only
 * once no operator is still owed it. The pending-player counts in the recovery message are computed
 * inside each operator's context, so an operator sees its own players and nobody else's.
 *
 * ══ AN UNSET ADMIN CHAT IS NOT A FAILED SEND ══════════════════════════════════════════════════
 * `admin_chat_id = 0` is how the seed and the multi-tenant migration create an operator, and it can
 * stay that way for good. Treating it like an unreachable chat meant claiming, releasing and logging
 * an ERROR every minute, and a recovery that was never retired — so once the day-long markers ran
 * out, every OTHER operator was told about the same recovery again, daily. Such an operator is
 * skipped: no claim, a warning once per transition, and it owes nothing. If a chat is set while the
 * transition is still current, the next tick tells it.
 *
 * ══ A CLAIM IS NOT A DELIVERY ═════════════════════════════════════════════════════════════════
 * The marker is written as IN_FLIGHT when claimed and rewritten as SENT only after Telegram accepted
 * the message. A replica that finds another's IN_FLIGHT claim does not send, but counts the operator
 * as still owed: if that send then fails and releases the claim, the recovery must not already have
 * been retired on the strength of it.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { LockService } from '@core/cache/lock.service';
import { RedisService } from '@core/cache/redis.service';
import { AppConfigService } from '@core/config/config.service';
import { IchancyHealthService, type IchancyHealthSnapshot } from '@core/ichancy';
import { PrismaService } from '@core/prisma/prisma.service';
import { BotService } from '@core/telegram/services/bot.service';
import { TenantRegistryService, runWithTenant } from '@core/tenant';

import {
  ICHANCY_HEALTH_ALERT_INTERVAL_MS,
  ICHANCY_HEALTH_ALERT_LOCK_TTL_MS,
  ICHANCY_HEALTH_ANNOUNCE_TTL_SECONDS,
  ICHANCY_HEALTH_IN_FLIGHT_TTL_SECONDS,
} from '../reconciliation.constants';

/** Twelve, matching PLAYER_LINK_MAX_ATTEMPTS — restated rather than imported: modules/A -> modules/B. */
const PARKED_ATTEMPTS = 12;

/** Marker values. Anything but SENT — including a claim that vanished — means "still owed". */
const MARKER_IN_FLIGHT = 'in-flight';
const MARKER_SENT = 'sent';

/**
 * What happened for one operator on one tick.
 * - posted:  this tick delivered the message.
 * - already: an earlier send completed (marker SENT).
 * - owed:    not delivered yet — this send failed, or another replica's send has not completed.
 * - skipped: the operator has no admin chat; nobody to tell, and nothing owed.
 */
type AnnounceOutcome = 'posted' | 'already' | 'owed' | 'skipped';

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

  /**
   * tenantId -> the transition it was last warned about for having no admin chat. One entry per
   * operator at most, so it cannot grow with time, and a new transition warns again.
   */
  private readonly warnedNoChat = new Map<string, string>();

  constructor(
    private readonly health: IchancyHealthService,
    private readonly bot: BotService,
    private readonly locks: LockService,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly tenants: TenantRegistryService,
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

    const operators = await this.tenants.listActiveOperators();
    if (operators.length === 0) {
      // Nobody is taking money, so nobody is waiting on the agent API. Not an error, and the
      // recovery is left pending, so an operator activated before it is retired still hears it.
      this.logger.debug(`Ichancy is ${snapshot.state}, but there is no ACTIVE operator to tell`);
      return 'quiet';
    }

    let posted = 0;
    let owed = 0;
    for (const operator of operators) {
      const outcome = await this.announceTo(operator.id, snapshot, anchor);
      if (outcome === 'posted') posted += 1;
      if (outcome === 'owed') owed += 1;
    }

    if (snapshot.state === 'UP' && snapshot.recoveredAt !== null && owed === 0) {
      // Retire the transition now that every operator with an admin chat has actually received it.
      // The markers only stop a BURST — they expire after a day, while `recoveredAt` lived in the
      // hash forever, so without this the same recovery was re-announced every 24 hours until the
      // next outage. Deliberately AFTER the sends: an operator whose chat is unreachable, or whose
      // message another replica is still sending, leaves it pending so the next tick looks again.
      // An operator with no chat at all does not hold it up (see the header).
      await this.health.acknowledgeRecovery(snapshot.recoveredAt);
    }

    if (posted === 0) return 'quiet';
    this.logger.warn(`announced Ichancy ${snapshot.state} to ${posted} operator admin group(s)`);
    return 'posted';
  }

  /** Tell one operator, at most once per transition. See AnnounceOutcome. */
  private async announceTo(
    tenantId: string,
    snapshot: IchancyHealthSnapshot,
    anchor: Date,
  ): Promise<AnnounceOutcome> {
    const transition = `${snapshot.state}:${anchor.toISOString()}`;

    // Read BEFORE claiming: an operator with no admin chat has nobody to tell, and claiming for it
    // would only be released again — every minute, forever (see the header).
    const { adminChatId } = await this.bot.chatsOf(tenantId);
    if (adminChatId === null) {
      if (this.warnedNoChat.get(tenantId) !== transition) {
        this.warnedNoChat.set(tenantId, transition);
        this.logger.warn(
          `Ichancy is ${snapshot.state}, but tenant ${tenantId} has no admin chat set; it is not ` +
            'told, and does not hold up the others',
        );
      }
      return 'skipped';
    }
    this.warnedNoChat.delete(tenantId);

    // CLAIMED BEFORE POSTING, atomically: two replicas that both slipped past the lock must not both
    // announce. Keyed by operator + state + anchor, so the next transition is a different key and
    // one operator's delivery never stands in for another's.
    const markerKey = `ichancy:health:announced:${tenantId}:${transition}`;
    const claimed = await this.redis.set(
      markerKey,
      MARKER_IN_FLIGHT,
      'EX',
      ICHANCY_HEALTH_IN_FLIGHT_TTL_SECONDS,
      'NX',
    );
    if (claimed !== 'OK') {
      // Somebody holds the claim. Only a COMPLETED send counts as told; an in-flight one may still
      // fail and release it, and a claim that vanished between the two calls was just released.
      return (await this.redis.get(markerKey)) === MARKER_SENT ? 'already' : 'owed';
    }

    try {
      // Built inside the operator's context: the recovery message counts pending players, and those
      // counts must be this operator's.
      const text = await runWithTenant(tenantId, () =>
        snapshot.state === 'DOWN'
          ? Promise.resolve(this.downMessage(snapshot))
          : this.upMessage(snapshot),
      );

      // Admins ONLY, never the feed: the feed chat may contain customers, and "the casino
      // integration is down" reads to them as "my money is gone".
      const sent = await this.bot.notifyAdmins(tenantId, text, {
        parseMode: 'HTML',
        linkPreview: false,
      });
      if (sent !== null) {
        // Delivered: now, and only now, the marker says so, for the full announce window.
        await this.redis.set(markerKey, MARKER_SENT, 'EX', ICHANCY_HEALTH_ANNOUNCE_TTL_SECONDS);
        return 'posted';
      }

      // notifyAdmins returns null rather than throwing when the chat is unreachable (or was cleared
      // since the read above). Keeping the marker would mean we had "alerted" into a void and would
      // never try again.
      this.logger.error(
        `Ichancy is ${snapshot.state} but the admin chat of tenant ${tenantId} is unreachable; ` +
          'will retry next tick',
      );
    } catch (cause) {
      // The operator's bot cannot be used, or Telegram failed after its retries. Same answer: this
      // operator is still owed the message, and the others are unaffected.
      this.logger.error(
        `Ichancy ${snapshot.state} alert for tenant ${tenantId} failed; will retry next tick: ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    await this.redis.del(markerKey).catch(() => 0);
    return 'owed';
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
