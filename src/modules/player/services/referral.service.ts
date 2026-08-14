/**
 * Referral capture for `/start <payload>` and for the mini-app's `start_param`.
 *
 * ============================ READ THIS BEFORE CHANGING ANYTHING ============================
 * SCHEMA GAP. The specification for this module says the referral must be "bound ONCE via
 * referralLockedAt". There is no `referralLockedAt` column — and no `referredByPlayerId`, and no
 * Referral model — anywhere in prisma/schema.prisma, which this module does not own.
 *
 * Rather than drop the requirement or silently invent state that cannot be persisted, the binding
 * is recorded as an AUDIT ROW: action `player.referral.bound`, entityType `Player`, entityId the
 * referred player. That table is append-only and immutable at the database level (prisma/sql/002
 * triggers + 003 grants), which gives the "bind exactly once, never re-writable" property the
 * columns were supposed to provide — the first row wins and no code path can edit it afterwards.
 *
 * What this costs, and what the foundation should do:
 *   - Reading a binding is an index scan on (entity_type, entity_id, created_at) rather than a
 *     column read. Fine at /start frequency; NOT fine if a referral ever has to be joined per row
 *     in a report.
 *   - "Once" is enforced by a lock + a re-check, not by a UNIQUE constraint. The window is real,
 *     just very small (see `bind` below).
 * The fix is two columns on `players` (`referred_by_player_id uuid null`, `referral_locked_at
 * timestamptz null`) plus a partial unique index. When they exist, only this file changes, and the
 * historical bindings can be backfilled from audit_logs because nothing was thrown away.
 * ===========================================================================================
 *
 * WHY the referrer is identified by Telegram id: there is no referral-code column either, so the
 * only stable, already-unique, already-indexed handle a player can put in a deep link is their own
 * Telegram user id (`t.me/<bot>?start=ref_123456789`).
 */
import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '@core/prisma/prisma.service';
import { LockService } from '@core/cache/lock.service';
import { AuditService } from '@core/audit/audit.service';
import { stripAuditContext } from '@core/audit/audit.types';
import type { Tx } from '@core/prisma/tx.type';
import { playerActor } from '@common/types/actor.type';

import { REFERRAL_BIND_LOCK_TTL_MS, referralBindLockKey } from '../player.constants';

/** Stable audit verb. Renaming it orphans every binding ever recorded — treat it as a column name. */
export const REFERRAL_BOUND_ACTION = 'player.referral.bound';

export type ReferralOutcome =
  /** A referrer was recorded for the first (and only) time. */
  | 'BOUND'
  /** This player already had a referrer; the payload was ignored, as designed. */
  | 'ALREADY_BOUND'
  /** The payload named the player themselves. */
  | 'IGNORED_SELF'
  /** The payload was well-formed but named nobody we know. */
  | 'IGNORED_UNKNOWN_REFERRER'
  /** No payload, or not a referral payload at all. */
  | 'IGNORED_NO_PAYLOAD'
  /** Another call is binding this same player right now; it will win and this one steps aside. */
  | 'CONTENDED';

export interface ReferralBinding {
  readonly referrerPlayerId: string;
  readonly referrerTelegramUserId: string;
  readonly source: string;
  readonly payload: string;
  readonly boundAt: Date;
}

export interface ReferralCaptureResult {
  readonly outcome: ReferralOutcome;
  /** Present only for BOUND and ALREADY_BOUND. */
  readonly binding?: ReferralBinding;
}

/**
 * Telegram permits `A-Z a-z 0-9 _ -`, up to 64 characters, in a start payload. We accept
 * `ref_<digits>`, `ref-<digits>` and a bare `<digits>`; anything else is somebody else's payload
 * (a campaign tag, a deep link into a deposit) and must be ignored rather than rejected.
 */
const REFERRAL_PAYLOAD_PATTERN = /^(?:ref[_-])?(\d{1,19})$/;

@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: LockService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Extracts a referrer's Telegram id from a start payload.
   * Returns null for "this is not a referral", which is not an error condition.
   */
  parseStartPayload(raw: string | null | undefined): bigint | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.length > 64) return null;

    const match = REFERRAL_PAYLOAD_PATTERN.exec(trimmed);
    const digits = match?.[1];
    if (digits === undefined) return null;

    try {
      const id = BigInt(digits);
      // Telegram ids are positive; 0 is what a truncated or spoofed payload looks like.
      return id > 0n ? id : null;
    } catch {
      return null;
    }
  }

  /** The recorded binding for a player, or null. The FIRST row wins if several ever exist. */
  async findBinding(playerId: string, tx?: Tx): Promise<ReferralBinding | null> {
    const client: Tx = tx ?? this.prisma;
    const row = await client.auditLog.findFirst({
      where: { entityType: 'Player', entityId: playerId, action: REFERRAL_BOUND_ACTION },
      orderBy: { createdAt: 'asc' },
      select: { after: true, createdAt: true },
    });
    if (row === null) return null;

    const snapshot = stripAuditContext(row.after);
    const referrerPlayerId = snapshot?.['referrerPlayerId'];
    const referrerTelegramUserId = snapshot?.['referrerTelegramUserId'];
    if (typeof referrerPlayerId !== 'string' || typeof referrerTelegramUserId !== 'string') {
      // A malformed historical row must not read as "no referrer" — that would let a second
      // binding be written. Log it and treat the player as bound.
      this.logger.warn(`Referral binding for player ${playerId} is unreadable; treating as bound`);
      return {
        referrerPlayerId: '',
        referrerTelegramUserId: '',
        source: 'unknown',
        payload: '',
        boundAt: row.createdAt,
      };
    }

    const source = snapshot?.['source'];
    const payload = snapshot?.['payload'];
    return {
      referrerPlayerId,
      referrerTelegramUserId,
      source: typeof source === 'string' ? source : 'unknown',
      payload: typeof payload === 'string' ? payload : '',
      boundAt: row.createdAt,
    };
  }

  /**
   * Binds a referrer to a player, at most once in that player's lifetime.
   *
   * Ordering matters and is deliberate:
   *   1. cheap parse — most /start calls carry no payload at all;
   *   2. cheap existence check — most repeat /start calls are from already-bound players;
   *   3. lock, then RE-CHECK inside it. The re-check is the whole point: without it two concurrent
   *      /start updates both pass step 2 and both write a binding. With a UNIQUE column this would
   *      be the database's job; until those columns exist, it is this lock's.
   */
  async bindFromStartPayload(
    playerId: string,
    playerTelegramUserId: bigint,
    rawPayload: string | null | undefined,
    source: string,
  ): Promise<ReferralCaptureResult> {
    const referrerTelegramUserId = this.parseStartPayload(rawPayload);
    if (referrerTelegramUserId === null) return { outcome: 'IGNORED_NO_PAYLOAD' };

    // Self-referral: cheapest possible check, and it needs no database at all.
    if (referrerTelegramUserId === playerTelegramUserId) return { outcome: 'IGNORED_SELF' };

    const existing = await this.findBinding(playerId);
    if (existing !== null) return { outcome: 'ALREADY_BOUND', binding: existing };

    const referrer = await this.prisma.player.findUnique({
      where: { telegramUserId: referrerTelegramUserId },
      select: { id: true },
    });
    if (referrer === null) return { outcome: 'IGNORED_UNKNOWN_REFERRER' };

    // A referrer row could in principle share our player id only if the telegram ids matched, which
    // step 1 already excluded — but the id comparison is free and makes the invariant local.
    if (referrer.id === playerId) return { outcome: 'IGNORED_SELF' };

    const handle = await this.locks.acquire(
      LockService.key(referralBindLockKey(playerId)),
      REFERRAL_BIND_LOCK_TTL_MS,
    );
    // No retry: the holder is about to bind this very player, so stepping aside is the correct
    // outcome, not an error to surface.
    if (handle === null) return { outcome: 'CONTENDED' };

    try {
      const confirmed = await this.findBinding(playerId);
      if (confirmed !== null) return { outcome: 'ALREADY_BOUND', binding: confirmed };

      const boundAt = new Date();
      const payload = typeof rawPayload === 'string' ? rawPayload.trim() : '';

      await this.prisma.runInTransaction(async (tx) => {
        await this.audit.write(tx, {
          action: REFERRAL_BOUND_ACTION,
          // The referred player is the one who acted (they opened the link), so the binding is
          // attributed to them — not to the referrer, who did nothing at this moment.
          actor: playerActor(playerId),
          subjectType: 'Player',
          subjectId: playerId,
          after: {
            referrerPlayerId: referrer.id,
            referrerTelegramUserId: referrerTelegramUserId.toString(),
            source,
            payload,
          },
        });
      });

      return {
        outcome: 'BOUND',
        binding: {
          referrerPlayerId: referrer.id,
          referrerTelegramUserId: referrerTelegramUserId.toString(),
          source,
          payload,
          boundAt,
        },
      };
    } finally {
      await this.locks.release(handle).catch(() => false);
    }
  }
}
