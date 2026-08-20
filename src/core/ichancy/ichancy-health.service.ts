/**
 * IS THE ICHANCY INTEGRATION UP? — a consecutive-failure breaker, shared cluster-wide via Redis.
 *
 * ══ WHY THIS EXISTS ═══════════════════════════════════════════════════════════════════════════
 * On 2026-08-20 every agent-API call answered `AMBIGUOUS / http=403 / CLOUDFLARE_CHALLENGE` for
 * HOURS. Nothing noticed. The float sync logged one ERROR line per tick and returned — correctly,
 * because a failed read tells you nothing about the float — and no other cron touches Ichancy at
 * all. The outage was discovered by a human noticing that a player who pressed /start the previous
 * afternoon still had no casino account.
 *
 * So this class answers one question and only one: DID THEIR APPLICATION ANSWER? Not "did the call
 * succeed" — a business rejection ("Duplicate login", "amount is greater than…") is proof the
 * integration is healthy, because something on the far side read our request and formed an opinion
 * about it. Only `ambiguous` means we never got an answer at all, and only a RUN of those means the
 * integration rather than the request is broken.
 *
 * ══ WHY IT LIVES IN core AND HAS NO BotService ════════════════════════════════════════════════
 * It is fed from IchancyHttpClient, which is core, and core may not import modules. So this half is
 * pure state; the half that talks to humans is IchancyHealthAlertCron in modules/reconciliation,
 * where BotService already is. The split also means the state survives a restart of the process
 * that alerts, and that api and worker share one verdict rather than each keeping its own.
 *
 * ══ WHY IT CAN NEVER THROW ════════════════════════════════════════════════════════════════════
 * `record` is called from inside the money path. A Redis hiccup must not be able to convert a
 * successful credit into an exception; a health gauge that breaks the thing it measures is worse
 * than no gauge. Every failure in here degrades to a debug log.
 */
import { Injectable, Logger } from '@nestjs/common';

import { RedisService } from '@core/cache/redis.service';
import { AppConfigService } from '@core/config/config.service';

import { type IchancyClassification } from './error-map';

/** One hash, one key: the verdict is cluster-wide, so both roles read and write the same fields. */
export const ICHANCY_HEALTH_KEY = 'ichancy:health';

/**
 * How many consecutive unanswered calls before we call the integration DOWN.
 *
 * Three, not one. The only ambient traffic while nothing else is happening is the 5-minute agent
 * float sync, so three failures is roughly a 15-minute detection floor — deliberately traded
 * against flapping on a single blip. The incident this defends against ran for HOURS, so 15 minutes
 * is an enormous improvement while 1 would alarm on every transient socket error. If faster
 * detection is wanted, raise the float-sync cadence rather than lowering this.
 */
export const ICHANCY_DOWN_THRESHOLD = 3;

export type IchancyHealthState = 'UP' | 'DOWN';

export interface IchancyHealthSnapshot {
  readonly state: IchancyHealthState;
  /** Unanswered calls in a row, of the same kind. Reset by any answered call. */
  readonly consecutive: number;
  /** CLOUDFLARE_CHALLENGE | TIMEOUT | TRANSPORT_ERROR — the classification rule, or null when UP. */
  readonly kind: string | null;
  /** When the current run of failures began: the outage's start, not the breaker's. */
  readonly since: Date | null;
  readonly lastEndpoint: string | null;
  readonly lastMessage: string | null;
  readonly recoveredAt: Date | null;
}

const HEALTHY: IchancyHealthSnapshot = Object.freeze({
  state: 'UP' as const,
  consecutive: 0,
  kind: null,
  since: null,
  lastEndpoint: null,
  lastMessage: null,
  recoveredAt: null,
});

/** A failure with no rule is still a failure; name it so an alert never reads "kind: null". */
const UNCLASSIFIED_KIND = 'UNCLASSIFIED';

/** Kept short: this ends up in a Telegram message, and Redis is not a log store. */
const MAX_MESSAGE_CHARS = 300;

function readInt(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readDate(value: string | undefined): Date | null {
  if (value === undefined || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function readText(value: string | undefined): string | null {
  return value === undefined || value.length === 0 ? null : value;
}

@Injectable()
export class IchancyHealthService {
  private readonly logger = new Logger(IchancyHealthService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Fold one classified call into the verdict. Called from the single choke point every agent-API
   * call passes through, in both roles.
   *
   * The outcome mapping is the whole design:
   *   ok / rejected / already_exists / token_expired  -> their application answered  -> HEALTHY
   *   ambiguous                                       -> we never got an answer      -> FAILURE
   *
   * `token_expired` counts as healthy on purpose: it is Ichancy's own 401/201 telling us the token
   * is stale, which is a conversation, not a blackout.
   */
  async record(endpoint: string, classification: IchancyClassification): Promise<void> {
    // In fake mode nothing real is contacted, so a verdict here would be a verdict about a fixture,
    // and every dev boot and test run would carry a live breaker.
    if (this.config.ichancy.fake) return;

    try {
      if (classification.outcome !== 'ambiguous') {
        await this.markHealthy();
        return;
      }
      await this.markFailure(
        endpoint,
        classification.rule ?? UNCLASSIFIED_KIND,
        classification.message,
      );
    } catch (error: unknown) {
      // Debug, not warn: this is instrumentation. If Redis is down the caller has bigger problems
      // and will learn about them through a path that is allowed to fail.
      this.logger.debug(
        `could not record Ichancy health: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * The gate the player-link backfill asks before issuing anything.
   *
   * Failing OPEN (false when we cannot tell) is the right default: a Redis outage must not silently
   * pause player registrations, and the backfill has per-player backoff underneath this anyway.
   */
  async isDown(): Promise<boolean> {
    return (await this.snapshot()).state === 'DOWN';
  }

  async snapshot(): Promise<IchancyHealthSnapshot> {
    if (this.config.ichancy.fake) return HEALTHY;

    let raw: Record<string, string>;
    try {
      raw = await this.redis.hgetall(ICHANCY_HEALTH_KEY);
    } catch (error: unknown) {
      this.logger.debug(
        `could not read Ichancy health: ${error instanceof Error ? error.message : String(error)}`,
      );
      return HEALTHY;
    }

    return {
      state: raw['state'] === 'DOWN' ? 'DOWN' : 'UP',
      consecutive: readInt(raw['consecutive']),
      kind: readText(raw['kind']),
      since: readDate(raw['since']),
      lastEndpoint: readText(raw['lastEndpoint']),
      lastMessage: readText(raw['lastMessage']),
      recoveredAt: readDate(raw['recoveredAt']),
    };
  }

  /**
   * "The recovery for THIS timestamp has been delivered to a human; stop offering it."
   *
   * WHY THIS IS NEEDED AT ALL: `recoveredAt` is what tells the alert cron a transition is pending,
   * and nothing else ever cleared it. The cron's own "announce once" marker is a Redis key with a
   * 24-hour TTL, so a day after a recovery that marker lapsed while `recoveredAt` was still sitting
   * in the hash — and the same recovery was posted again, and again every 24 hours, until the next
   * outage happened to overwrite it. The marker stops a BURST; this stops the resurrection.
   *
   * `since` goes with it: its only remaining reader is the duration in the message that was just
   * sent, and leaving it behind is the stale-anchor trap that markHealthy's HDEL exists to avoid.
   *
   * Guarded on the value rather than blind-deleting, so a recovery that happened while the message
   * was in flight is not silently swallowed — worst case we re-announce once, which is the correct
   * direction to fail in for an alarm.
   */
  async acknowledgeRecovery(recoveredAt: Date): Promise<void> {
    if (this.config.ichancy.fake) return;
    try {
      const stored = await this.redis.hget(ICHANCY_HEALTH_KEY, 'recoveredAt');
      if (stored !== recoveredAt.toISOString()) return;
      await this.redis.hdel(ICHANCY_HEALTH_KEY, 'recoveredAt', 'since');
    } catch (error: unknown) {
      // Same rule as everything else in here: instrumentation may not throw at its caller.
      this.logger.debug(
        `could not acknowledge Ichancy recovery: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────

  private async markHealthy(): Promise<void> {
    const previous = await this.redis.hget(ICHANCY_HEALTH_KEY, 'state');
    if (previous === 'DOWN') {
      // `since` is deliberately left in place: the recovery message quotes how long the outage
      // lasted, and it can only compute that from the timestamp the DOWN state was carrying. It is
      // dropped by acknowledgeRecovery() once that message has actually been delivered.
      await this.redis.hset(ICHANCY_HEALTH_KEY, {
        state: 'UP',
        consecutive: '0',
        recoveredAt: new Date().toISOString(),
      });
      // `kind` MUST go with it, and this line is load-bearing rather than tidiness. markFailure
      // treats a matching `kind` as "the same run of failures" and therefore KEEPS the stored
      // `since`. Leaving a resolved outage's kind behind meant the NEXT outage inherited the
      // PREVIOUS outage's start time, which reproduced the alert marker key that outage had already
      // claimed — so the second outage of the day was announced to nobody at all.
      await this.redis.hdel(ICHANCY_HEALTH_KEY, 'kind', 'lastEndpoint', 'lastMessage');
      return;
    }
    // The steady-state path: one round trip that writes nothing when there is nothing to clear. An
    // HDEL of absent fields is free; an HSET of five fields on every single credit is not.
    await this.redis.hdel(ICHANCY_HEALTH_KEY, 'consecutive', 'kind', 'lastEndpoint', 'lastMessage');
  }

  private async markFailure(endpoint: string, kind: string, message: string): Promise<void> {
    const raw = await this.redis.hgetall(ICHANCY_HEALTH_KEY);
    const sameKind = raw['kind'] === kind;
    const alreadyDown = raw['state'] === 'DOWN';

    // A change of kind restarts the count: "three timeouts" and "three challenges" are different
    // outages with different fixes, and averaging them into one run would name the wrong one in the
    // alert — which is the single most useful field in it.
    const consecutive = sameKind ? readInt(raw['consecutive']) + 1 : 1;
    const nowIso = new Date().toISOString();
    // `since` does NOT restart with the count once we are already DOWN, and that asymmetry is the
    // point. A blocked host does not fail identically every time — the browser transport times out
    // while it is trying to solve the challenge, so 403s and timeouts interleave — and `since` is
    // what keys the alert's "announce once" marker. Moving it mid-outage minted a fresh key on
    // every flap, which turned one outage into an alarm a minute. The outage began when it began;
    // only the count and the reported kind follow the latest failure.
    const since = sameKind || alreadyDown ? (readText(raw['since']) ?? nowIso) : nowIso;

    const fields: Record<string, string> = {
      consecutive: String(consecutive),
      kind,
      since,
      lastEndpoint: endpoint,
      lastMessage: message.slice(0, MAX_MESSAGE_CHARS),
    };
    if (consecutive >= ICHANCY_DOWN_THRESHOLD) fields['state'] = 'DOWN';

    await this.redis.hset(ICHANCY_HEALTH_KEY, fields);
  }
}
