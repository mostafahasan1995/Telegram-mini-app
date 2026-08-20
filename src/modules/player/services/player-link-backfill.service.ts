/**
 * SELF-HEALING FOR STRANDED REGISTRATIONS — one pass, worker-driven.
 *
 * ══ THE INCIDENT THIS EXISTS FOR ══════════════════════════════════════════════════════════════
 * 2026-08-19T15:22 a player pressed /start. Cloudflare answered the registerPlayer call with a
 * challenge, PlayerLinkService correctly persisted NOTHING, and the row sat at
 * `PENDING_ICHANCY / ichancy_player_id = NULL` for nineteen hours. Nothing in this system retried
 * it: the crons are the idempotency reaper, the outbox relay and reaper, the report schedule, the
 * deposit sweep, the agent float sync, the ledger invariants and the rail ageing — none of which
 * looks at players. The failure would next have surfaced when that person tried to deposit, i.e.
 * while somebody was already waiting for their money.
 *
 * ══ WHY THIS CLASS DOES NOT CONTAIN A REGISTRATION ════════════════════════════════════════════
 * Ichancy's registerPlayer is NOT idempotent and has no key we can dedupe on, and a duplicate
 * cannot be undone — their agent API has no deletePlayer. So the ONLY outbound thing this file does
 * is call `PlayerLinkService.ensureLinked`, which is the single registration path in the system.
 * That is how it inherits, without re-implementing any of them:
 *   1. the per-player lock `lock:player-link:<id>` (PLAYER_LINK_LOCK_TTL_MS);
 *   2. the re-read of the row INSIDE that lock, so a player linked between selection and execution
 *      is returned rather than re-registered;
 *   3. the compare-and-set persist, `updateMany({ id, ichancyPlayerId: null })`, which is the real
 *      safety net — the lock TTL (30 s) can expire mid-flight while ensurePlayer makes up to four
 *      bounded calls, so nothing here assumes "lock held ⇒ safe".
 *
 * ══ WHY RETRYING AT ALL IS SAFE, GIVEN THAT ═══════════════════════════════════════════════════
 * The credentials are DERIVED deterministically from `players.id` + `telegram_user_id`, so a retry
 * presents the SAME login. HttpIchancyAdapter.ensurePlayer treats "Duplicate login" as
 * success-in-disguise and resolves the id through getPlayersForCurrentAgent, and an AMBIGUOUS
 * registerPlayer is resolved by that same lookup rather than by a second register. A retry
 * therefore converges on the existing account instead of minting a second one.
 *
 * ══ WHY IT DOES NOT MESSAGE THE PLAYER ════════════════════════════════════════════════════════
 * modules/player must not import TelegramModule (the Bot factory calls getMe at construction — see
 * player.handlers.ts and src/modules/modules.int.spec.ts). A rescued player sees their credentials
 * under 👤 حسابي, and the admin group is told by IchancyHealthAlertCron. DMing them would be an
 * outbox topic plus a handler in OutboxModule.forWorker — a separable follow-up.
 */
import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '@core/config/config.service';
import { IchancyHealthService } from '@core/ichancy';
import { PrismaService } from '@core/prisma/prisma.service';
import { isAppException } from '@common/exceptions/app.exception';

import {
  PLAYER_LINK_BACKFILL_BATCH,
  PLAYER_LINK_BACKFILL_BUDGET_MS,
  PLAYER_LINK_BACKFILL_CORRELATION,
  PLAYER_LINK_BACKFILL_GRACE_MS,
  PLAYER_LINK_BACKOFF_BASE_MS,
  PLAYER_LINK_BACKOFF_MAX_MS,
  PLAYER_LINK_MAX_ATTEMPTS,
  PlayerErrorCodes,
} from '../player.constants';
import { PlayerLinkService } from './player-link.service';

/**
 * The four ways an ensureLinked attempt can fail, from the backfill's point of view.
 *
 * This taxonomy is the heart of the file, because getting it wrong in EITHER direction is expensive:
 * treating a terminal rejection as retryable hammers Ichancy forever, and treating a transport
 * failure as terminal strands exactly the population this class exists to rescue.
 */
type LinkFailureKind = 'IN_PROGRESS' | 'TRANSPORT' | 'SESSION' | 'TERMINAL';

/**
 * A 422 ICHANCY_LINK_REJECTED whose reason is one of these did NOT come from Ichancy refusing the
 * player — it came from us failing to obtain a session at all (http-ichancy.adapter.ts turns a
 * session failure into `rejected`, because nothing was sent). A Cloudflare-blocked SIGN-IN lands
 * here, so without this set the backfill would file the outage's own victims under "do not retry".
 */
const SESSION_FAILURE_REASONS: ReadonlySet<string> = new Set([
  'ICHANCY_SESSION_MISSING',
  'ICHANCY_SESSION_REAUTH_REQUIRED',
  'ICHANCY_SIGNIN_REJECTED',
  'ICHANCY_SIGNIN_AMBIGUOUS',
  'ICHANCY_SESSION_LOCK_TIMEOUT',
]);

/** A contended per-player lock is not a failure; it is somebody else doing this exact work. */
const IN_PROGRESS_RETRY_MS = 60_000;

/** ±20%, so N workers that all backed off together do not return together. */
const JITTER_FRACTION = 0.2;

export interface BackfillPassResult {
  readonly scanned: number;
  readonly linked: number;
  /** Failed but retryable: attempts incremented, next attempt scheduled. */
  readonly deferred: number;
  /** Failed terminally, or out of attempts: parked for a human. */
  readonly parked: number;
  /** Set when the pass did no work at all, with the reason. */
  readonly skipped: string | null;
}

const EMPTY_PASS: BackfillPassResult = Object.freeze({
  scanned: 0,
  linked: 0,
  deferred: 0,
  parked: 0,
  skipped: null,
});

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Exported for the spec: the backoff curve is the anti-hammer property, so it is pinned. */
export function backoffMsFor(attempts: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, attempts - 1);
  const base = Math.min(PLAYER_LINK_BACKOFF_BASE_MS * 2 ** exponent, PLAYER_LINK_BACKOFF_MAX_MS);
  const jitter = 1 + (random() * 2 - 1) * JITTER_FRACTION;
  // Math.floor, not Math.round: the repo bans Math.round outright because rounding MONEY with it is
  // a bug, and a milliseconds-until-retry value has no reason to be the exception that weakens it.
  return Math.floor(base * jitter);
}

/** Exported for the spec: this is the classification the incident turned on. */
export function classifyLinkFailure(error: unknown): LinkFailureKind {
  if (!isAppException(error)) {
    // An unexpected throw (a bug, a dead database) tells us nothing about Ichancy. Back off rather
    // than park: parking would need a human for a problem that may clear on its own.
    return 'TRANSPORT';
  }

  if (error.errorCode === PlayerErrorCodes.ICHANCY_LINK_IN_PROGRESS) return 'IN_PROGRESS';

  // 503 ICHANCY_LINK_AMBIGUOUS. A Cloudflare 403 arrives here, and it is the ONE ambiguous case
  // this system retries. The house rule is that AMBIGUOUS is never blindly retried — it means "we
  // do not know whether it landed" — and that rule is kept: what makes this narrower and safe is
  // that a Cloudflare EDGE 403 carries Cloudflare's own interstitial as its body, which is proof
  // the request never reached Ichancy's application. Nothing can have been created by it. And even
  // if it somehow had been, the retry presents the same DERIVED login, so ensurePlayer resolves the
  // existing account through getPlayersForCurrentAgent instead of registering a second one.
  if (error.errorCode === PlayerErrorCodes.ICHANCY_LINK_AMBIGUOUS) return 'TRANSPORT';

  if (error.errorCode === PlayerErrorCodes.ICHANCY_LINK_REJECTED) {
    const reason = readReason(error.details);
    return reason !== null && SESSION_FAILURE_REASONS.has(reason) ? 'SESSION' : 'TERMINAL';
  }

  // PLAYER_NOT_FOUND and anything else: retrying unchanged cannot help.
  return 'TERMINAL';
}

function readReason(details: unknown): string | null {
  if (typeof details !== 'object' || details === null) return null;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : null;
}

@Injectable()
export class PlayerLinkBackfillService {
  private readonly logger = new Logger(PlayerLinkBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly links: PlayerLinkService,
    private readonly health: IchancyHealthService,
    private readonly config: AppConfigService,
  ) {}

  /** One pass. Safe to call from an admin endpoint or a test; the schedule lives in the cron class. */
  async runOnce(limit?: number): Promise<BackfillPassResult> {
    if (this.config.ichancy.fake) {
      // The fake adapter registers everyone instantly, so a backfill over it is a loop that proves
      // nothing. Skipping keeps every dev boot and every test run inert.
      return { ...EMPTY_PASS, skipped: 'ichancy-fake' };
    }

    // THE ANTI-HAMMER GATE, and the reason this cron cannot make an outage worse. While the breaker
    // says DOWN we issue ZERO requests, so the backfill cannot keep failing challenges and dragging
    // the IP's Cloudflare trust score lower — the mechanism that turned twenty minutes of failure
    // into hours. The only prober left is the 5-minute agent float sync, which is exactly enough to
    // notice recovery and reopen this gate.
    if (await this.health.isDown()) {
      this.logger.debug('player-link backfill skipped: Ichancy is DOWN');
      return { ...EMPTY_PASS, skipped: 'ichancy-down' };
    }

    const now = new Date();
    const candidates = await this.prisma.player.findMany({
      where: {
        // LOAD-BEARING, not cosmetic. linkIchancyAccount force-sets `status: 'ACTIVE'` with a WHERE
        // of only `{ id, ichancyPlayerId: null }`, so a selector of `ichancyPlayerId: null` alone
        // would mint a casino account for a SUSPENDED / SELF_EXCLUDED / CLOSED player and silently
        // reactivate them — irreversibly, because there is no deletePlayer.
        status: 'PENDING_ICHANCY',
        ichancyPlayerId: null,
        ichancyLinkAttempts: { lt: PLAYER_LINK_MAX_ATTEMPTS },
        OR: [{ ichancyLinkNextAttemptAt: null }, { ichancyLinkNextAttemptAt: { lte: now } }],
        // Do not race /start's own attempt; see PLAYER_LINK_BACKFILL_GRACE_MS.
        createdAt: { lte: new Date(now.getTime() - PLAYER_LINK_BACKFILL_GRACE_MS) },
      },
      // Oldest first, and totally ordered so an interrupted pass resumes predictably: the people who
      // have been waiting longest are rescued first.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit ?? PLAYER_LINK_BACKFILL_BATCH,
      select: { id: true, telegramUserId: true, ichancyLinkAttempts: true },
    });

    if (candidates.length === 0) return EMPTY_PASS;

    const deadline = Date.now() + PLAYER_LINK_BACKFILL_BUDGET_MS;
    let scanned = 0;
    let linked = 0;
    let deferred = 0;
    let parked = 0;

    for (const candidate of candidates) {
      if (Date.now() > deadline) {
        this.logger.warn(
          `player-link backfill stopped at the ${String(PLAYER_LINK_BACKFILL_BUDGET_MS)}ms budget ` +
            `after ${String(scanned)} of ${String(candidates.length)} player(s)`,
        );
        break;
      }
      scanned += 1;

      try {
        const link = await this.links.ensureLinked(candidate.id, PLAYER_LINK_BACKFILL_CORRELATION);
        linked += 1;
        this.logger.log(
          `backfilled player ${candidate.id} (tg:${candidate.telegramUserId.toString()}) -> ` +
            `ichancy ${link.ichancyPlayerId}`,
        );
        await this.clearBookkeeping(candidate.id);
      } catch (error: unknown) {
        const kind = classifyLinkFailure(error);
        const outcome = await this.recordFailure(candidate.id, candidate.ichancyLinkAttempts, kind, error);
        if (outcome === 'parked') parked += 1;
        else deferred += 1;

        if (kind === 'TRANSPORT' || kind === 'SESSION') {
          // ABORT THE PASS on the first sign that Ichancy itself is unreachable: at most ONE failed
          // request per tick while the integration is unhealthy, which is what lets the breaker trip
          // on the ambient float sync instead of on a burst of our own making.
          this.logger.warn(
            `player-link backfill stopping this pass: ${kind} on player ${candidate.id} — ` +
              describeError(error),
          );
          break;
        }
        this.logger.warn(`player-link backfill ${kind} on player ${candidate.id}: ${describeError(error)}`);
      }
    }

    return { scanned, linked, deferred, parked, skipped: null };
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────

  /**
   * Every bookkeeping write is guarded on the ichancy column rather than on the id alone, so it can
   * never stamp a row whose state changed underneath us — the same compare-and-set discipline the
   * link itself uses.
   */
  private async clearBookkeeping(playerId: string): Promise<void> {
    await this.prisma.player.updateMany({
      where: { id: playerId, ichancyPlayerId: { not: null } },
      // `attempts` is deliberately KEPT: "this one took nine tries" is forensics an operator wants
      // after an outage, and nothing reads it once ichancyPlayerId is set.
      data: { ichancyLinkNextAttemptAt: null, ichancyLinkLastError: null },
    });
  }

  private async recordFailure(
    playerId: string,
    attempts: number,
    kind: LinkFailureKind,
    error: unknown,
  ): Promise<'deferred' | 'parked'> {
    const now = new Date();

    if (kind === 'IN_PROGRESS') {
      // Somebody else holds the per-player lock and is doing this work. Charging the player an
      // attempt for our own contention would burn their twelve tries on nothing.
      await this.prisma.player.updateMany({
        where: { id: playerId, ichancyPlayerId: null },
        data: { ichancyLinkNextAttemptAt: new Date(now.getTime() + IN_PROGRESS_RETRY_MS) },
      });
      return 'deferred';
    }

    if (kind === 'TERMINAL') {
      // Park immediately rather than counting up to twelve: the port's contract for a rejection is
      // "do not retry unchanged", and nothing about waiting changes the request.
      await this.prisma.player.updateMany({
        where: { id: playerId, ichancyPlayerId: null },
        data: {
          ichancyLinkAttempts: PLAYER_LINK_MAX_ATTEMPTS,
          ichancyLinkLastAttemptAt: now,
          ichancyLinkNextAttemptAt: null,
          ichancyLinkLastError: describeError(error).slice(0, 500),
        },
      });
      return 'parked';
    }

    const nextAttempts = attempts + 1;
    const parked = nextAttempts >= PLAYER_LINK_MAX_ATTEMPTS;
    await this.prisma.player.updateMany({
      where: { id: playerId, ichancyPlayerId: null },
      data: {
        ichancyLinkAttempts: nextAttempts,
        ichancyLinkLastAttemptAt: now,
        ichancyLinkNextAttemptAt: parked
          ? null
          : new Date(now.getTime() + backoffMsFor(nextAttempts)),
        ichancyLinkLastError: describeError(error).slice(0, 500),
      },
    });
    return parked ? 'parked' : 'deferred';
  }
}
