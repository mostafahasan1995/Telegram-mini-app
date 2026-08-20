/**
 * WHY the error codes live next to the module rather than in @common/exceptions/error-codes:
 * that map owns the codes the EDGES throw (auth, transport, persistence). These are domain codes —
 * the mini-app switches on them to decide what to render, and support quotes them. Same rules
 * apply: SCREAMING_SNAKE, never renamed, never reused, no values baked into the code itself.
 */
import type { AdminRole } from '@prisma/client';

export const PlayerErrorCodes = {
  PLAYER_NOT_FOUND: 'PLAYER_NOT_FOUND',
  /** Account is SUSPENDED/CLOSED: authenticated, but may not transact. */
  PLAYER_NOT_ACTIVE: 'PLAYER_NOT_ACTIVE',
  PLAYER_SELF_EXCLUDED: 'PLAYER_SELF_EXCLUDED',

  /** Ichancy definitively refused to register/resolve the mirror account. */
  ICHANCY_LINK_REJECTED: 'ICHANCY_LINK_REJECTED',
  /** We could not determine whether the mirror exists. Retryable, never a silent success. */
  ICHANCY_LINK_AMBIGUOUS: 'ICHANCY_LINK_AMBIGUOUS',
  /** Another request is already linking this player. */
  ICHANCY_LINK_IN_PROGRESS: 'ICHANCY_LINK_IN_PROGRESS',

  /**
   * The one-time bot code is unknown, already used, expired, or was minted in the admin scope.
   * Deliberately ONE code for all four: telling a caller that a code was real but late confirms a
   * guess, which turns the exchange route into an oracle for the code space.
   */
  BOT_CODE_INVALID: 'BOT_CODE_INVALID',

  REFERRAL_ALREADY_BOUND: 'REFERRAL_ALREADY_BOUND',
  REFERRAL_SELF: 'REFERRAL_SELF',
  REFERRAL_UNKNOWN_REFERRER: 'REFERRAL_UNKNOWN_REFERRER',
  REFERRAL_PAYLOAD_INVALID: 'REFERRAL_PAYLOAD_INVALID',
} as const;

export type PlayerErrorCode = (typeof PlayerErrorCodes)[keyof typeof PlayerErrorCodes];

/**
 * FALLBACK domain for the synthetic mailbox we hand Ichancy, used when ICHANCY_PLAYER_EMAIL_DOMAIN
 * is not configured. The real value is deployment-specific — see that variable in .env.example.
 *
 * ══ WHY THIS IS NO LONGER `.invalid` ══════════════════════════════════════════════════════════
 * It was `players.ichancy-cashier.invalid`, chosen because RFC 2606 reserves `.invalid` precisely
 * so it can never resolve, which made an undeliverable address provable rather than hoped for.
 * Ichancy rejects it: the first real registerPlayer, on 2026-08-19, came back
 *
 *     "Email field contains invalid characters."
 *
 * and probing showed the TLD is the reason — the same address on `.com` was accepted, while the
 * underscore, the digits and the hyphen were all fine. Their validator checks the TLD against a
 * list, and a reserved one is not on it.
 *
 * `example.com` is the replacement because RFC 2606 ALSO reserves it, IANA holds it permanently, and
 * it carries an ordinary TLD that passes validation. Nobody can ever register it and start receiving
 * mail meant for our players — which is the property that matters, because Ichancy may send account
 * mail to these addresses. A domain we do not control would eventually hand a stranger the ability
 * to receive our players' account email.
 */
/**
 * The VALUE now lives in @core/config (ICHANCY_PLAYER_EMAIL_DOMAIN in env.schema.ts, surfaced as
 * `config.ichancy.playerEmailDomain`), because it is deployment configuration rather than a domain
 * fact — and because core may not import from modules. PlayerLinkService passes it in.
 */

/** Derivation labels. Distinct labels are what make reusing one root secret safe. */
export const CREDENTIAL_INFO_LOGIN = 'ichancy-player-login:v1';
export const CREDENTIAL_INFO_PASSWORD = 'ichancy-player-password:v1';
export const CREDENTIAL_INFO_ENCRYPTION = 'ichancy-player-password-enc:v1';

/**
 * Held across the whole ensurePlayer round trip. Registration is not idempotent on their side in
 * any way we can key on, so two concurrent linkers would issue two registerPlayer calls for the
 * same login; the second gets "Duplicate login" and both then resolve the same id. Harmless but
 * wasteful, and it doubles the ichancy_calls noise on the one endpoint we most need to read.
 */
export const PLAYER_LINK_LOCK_TTL_MS = 30_000;

export const playerLinkLockKey = (playerId: string): string => `player-link:${playerId}`;

// -------------------------------------------------------------------------------------------------
// The registration backfill — see services/player-link-backfill.service.ts
// -------------------------------------------------------------------------------------------------

/**
 * How often the worker looks for players stranded at PENDING_ICHANCY.
 *
 * Five minutes rather than one: a stranded player is not waiting on this tick (they are told
 * nothing, and DepositCreditService links lazily before any money moves), while a tighter loop over
 * a challenged endpoint is actively harmful — every failed challenge lowers the IP's Cloudflare
 * trust score, which is how twenty minutes of failure became hours on 2026-08-20.
 */
export const PLAYER_LINK_BACKFILL_INTERVAL_MS = 5 * 60_000;

/** Under the interval, per the house convention, so a tick is never skipped by a stale lock. */
export const PLAYER_LINK_BACKFILL_LOCK_TTL_MS = 4 * 60_000;

/** Bounded per pass: one tick must not be able to hold a connection for minutes on a backlog. */
export const PLAYER_LINK_BACKFILL_BATCH = 10;

/** Wall-clock ceiling for one pass, independent of the batch size. */
export const PLAYER_LINK_BACKFILL_BUDGET_MS = 120_000;

/**
 * How long a freshly created player is left alone before the cron touches them.
 *
 * /start makes its own attempt (player.handlers.ts ensureGamingAccount), and a cron racing that
 * would mean two linkers for the same row. The per-player lock makes that safe rather than
 * dangerous, but it is still two registerPlayer calls for one person and twice the ichancy_calls
 * noise on the endpoint we most need to read.
 */
export const PLAYER_LINK_BACKFILL_GRACE_MS = 120_000;

/** First retry lands here; each further attempt doubles it. */
export const PLAYER_LINK_BACKOFF_BASE_MS = 5 * 60_000;

/** Ceiling for the doubling. Twelve hours is "an operator will have looked by now". */
export const PLAYER_LINK_BACKOFF_MAX_MS = 12 * 60 * 60_000;

/**
 * After this many attempts a player is PARKED and the selector stops returning them.
 *
 * A hard stop rather than an ever-growing delay: something that has failed twelve times needs a
 * human, and a row that is retried forever is a row that quietly keeps adding to the ichancy_calls
 * noise. The alert cron reports the parked count so the human knows to look.
 */
export const PLAYER_LINK_MAX_ATTEMPTS = 12;

/**
 * Its own correlationId, so the cron's work is attributable in `ichancy_calls` and in the
 * `player.ichancy.linked` audit row rather than being indistinguishable from a /start.
 */
export const PLAYER_LINK_BACKFILL_CORRELATION = 'cron:player-link-backfill';

/** Guards the read-then-write of the once-only referral binding. */
export const REFERRAL_BIND_LOCK_TTL_MS = 5_000;

export const referralBindLockKey = (playerId: string): string => `player-referral:${playerId}`;

// -------------------------------------------------------------------------------------------------
// Staff access to the player directory
// -------------------------------------------------------------------------------------------------

/**
 * WHY these live here and not in modules/admin: `eslint-plugin-boundaries` forbids
 * modules/player -> modules/admin, and the routes they guard (`/v1/admin/players`) are served by
 * THIS module — exactly as modules/payment-method owns PAYMENT_METHOD_READER_ROLES for its own
 * `/v1/admin/payment-methods`. AdminRole is a Prisma enum, i.e. @core, so both sides may name it.
 */

/**
 * Who may READ the player directory. SUPPORT is included because answering "where is my deposit?"
 * starts with finding the person, and REVIEWER because a review card names a player they may need
 * to look up.
 */
export const PLAYER_READER_ROLES: readonly AdminRole[] = Object.freeze([
  'SUPER_ADMIN',
  'FINANCE_ADMIN',
  'REVIEWER',
  'SUPPORT',
]);

/**
 * Who may CREATE the Ichancy account for a player.
 *
 * Deliberately narrower than the readers: this writes to a third-party system, under our agent, and
 * it cannot be undone from here — there is no deletePlayer endpoint in the agent API. SUPPORT and
 * REVIEWER can see that an account is missing and say so; they cannot mint one.
 */
export const PLAYER_ICHANCY_MANAGER_ROLES: readonly AdminRole[] = Object.freeze([
  'SUPER_ADMIN',
  'FINANCE_ADMIN',
]);
