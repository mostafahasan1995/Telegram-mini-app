/**
 * Lazily creates (or re-discovers) the Ichancy mirror account for one of our players.
 *
 * WHY this is lazy and not part of signup: registering costs an HTTP round trip to a system that
 * cannot be asked "did my last call work?". Doing it for every curious visitor who opens the mini
 * app would create thousands of accounts we never use, on a system whose only deduplication is
 * "Duplicate login". Doing it just before the first credit means we create exactly the accounts we
 * are about to put money into.
 *
 * WHY it is safe to call twice — the three ways this is made idempotent, in order:
 *   1. The credentials are DERIVED from the player id, so the same player always registers the same
 *      login. A retry after any failure re-presents the same identity.
 *   2. `ensurePlayer` in the adapter already turns "Duplicate login" into a success and resolves the
 *      id by lookup, so a second attempt converges instead of erroring.
 *   3. The persist step is a compare-and-set (`ichancyPlayerId: null` in the WHERE). A loser in a
 *      race writes zero rows and re-reads the winner's id rather than overwriting it.
 *
 * WHY the HTTP call is outside every transaction: the project rule is absolute — nothing but an
 * outbox row leaves a money transaction. A registration that takes 30 seconds would otherwise hold
 * a row lock on `players` for 30 seconds, and a rollback would not un-create the remote account.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Player } from '@prisma/client';

import { AppConfigService } from '@core/config/config.service';
import { PrismaService } from '@core/prisma/prisma.service';
import { LockService } from '@core/cache/lock.service';
import { AuditService } from '@core/audit/audit.service';
import { ICHANCY_PORT, type IchancyPort, isIchancyOk, isIchancyRejected } from '@core/ichancy';
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from '@common/exceptions/app.exception';
import { SYSTEM_ACTOR } from '@common/types/actor.type';

import { PlayerRepository } from '../repositories/player.repository';
import {
  CREDENTIAL_INFO_ENCRYPTION,
  PLAYER_LINK_LOCK_TTL_MS,
  PlayerErrorCodes,
  playerLinkLockKey,
} from '../player.constants';
import {
  deriveIchancyCredentials,
  type IchancyCredentials,
} from '../utils/ichancy-credentials.util';
import { deriveKey, openSecret, sealSecret } from '../utils/secret-box.util';
import type { LinkedIchancyAccount, PlayerLinkPort } from '../player-link.port';

@Injectable()
export class PlayerLinkService implements PlayerLinkPort {
  private readonly logger = new Logger(PlayerLinkService.name);
  /** Derived once: it depends only on the root secret, and HKDF is not free. */
  private readonly encryptionKey: Buffer;
  private readonly rootSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly players: PlayerRepository,
    private readonly locks: LockService,
    private readonly audit: AuditService,
    config: AppConfigService,
    @Inject(ICHANCY_PORT) private readonly ichancy: IchancyPort,
  ) {
    // There is no dedicated credential secret in the env schema (which this module does not own),
    // so the JWT secret is the root. That is only acceptable because every use is domain-separated
    // through HKDF/HMAC labels — see utils/secret-box.util.ts. A dedicated
    // PLAYER_CREDENTIAL_SECRET would be strictly better and is a one-line change here.
    this.rootSecret = config.jwt.secret;
    this.encryptionKey = deriveKey(this.rootSecret, CREDENTIAL_INFO_ENCRYPTION);
  }

  /** Fast path for callers that only want to know, without ever creating anything. */
  async findIchancyPlayerId(playerId: string): Promise<string | null> {
    const player = await this.players.findById(playerId);
    return player?.ichancyPlayerId ?? null;
  }

  async ensureLinked(
    playerId: string,
    correlationId?: string | null,
  ): Promise<LinkedIchancyAccount> {
    const player = await this.players.findById(playerId);
    if (player === null) {
      throw new NotFoundError(PlayerErrorCodes.PLAYER_NOT_FOUND, 'Player not found.');
    }

    const already = this.asLinked(player, false);
    if (already !== null) return already;

    const handle = await this.locks.acquire(
      LockService.key(playerLinkLockKey(playerId)),
      PLAYER_LINK_LOCK_TTL_MS,
      // A few retries rather than fail-fast: the competing holder is doing the exact work we
      // want done, and it usually finishes in well under a second.
      { retries: 3, retryDelayMs: 400 },
    );
    if (handle === null) {
      throw new ConflictError(
        PlayerErrorCodes.ICHANCY_LINK_IN_PROGRESS,
        'This account is being prepared. Please try again in a moment.',
      );
    }

    try {
      // Re-read INSIDE the lock: the holder we queued behind has very likely just linked us.
      const fresh = await this.players.findById(playerId);
      if (fresh === null) {
        throw new NotFoundError(PlayerErrorCodes.PLAYER_NOT_FOUND, 'Player not found.');
      }
      const linkedByOther = this.asLinked(fresh, false);
      if (linkedByOther !== null) return linkedByOther;

      return await this.register(fresh, correlationId ?? null);
    } finally {
      await this.locks.release(handle).catch((error: unknown) => {
        this.logger.error(
          `Failed to release player-link lock for ${playerId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return false;
      });
    }
  }

  /**
   * The credentials for a player: the STORED ones when we have them, freshly derived otherwise.
   * Stored always wins — if the root secret is ever rotated, a recomputed login would no longer
   * match the account that actually exists inside Ichancy.
   */
  credentialsFor(player: Player): IchancyCredentials {
    if (
      player.ichancyLogin !== null &&
      player.ichancyEmail !== null &&
      player.ichancyPasswordEnc !== null
    ) {
      return {
        login: player.ichancyLogin,
        email: player.ichancyEmail,
        password: openSecret(this.encryptionKey, player.ichancyPasswordEnc),
      };
    }
    return deriveIchancyCredentials(this.rootSecret, player.id);
  }

  private async register(
    player: Player,
    correlationId: string | null,
  ): Promise<LinkedIchancyAccount> {
    const credentials = this.credentialsFor(player);

    const result = await this.ichancy.ensurePlayer({
      login: credentials.login,
      email: credentials.email,
      password: credentials.password,
      context: { playerId: player.id, correlationId },
    });

    if (isIchancyRejected(result)) {
      // A definite "no". Retrying unchanged would produce the same answer, so this is a business
      // error the caller must surface, not a transient one to queue behind.
      throw new BusinessRuleError(
        PlayerErrorCodes.ICHANCY_LINK_REJECTED,
        'We could not set up your gaming account. Support has been notified.',
        { reason: result.code },
      );
    }

    if (!isIchancyOk(result)) {
      // The adapter already tried a lookup before giving up, so this really is unknown. Persisting
      // nothing is the safe branch: the derived login makes the next attempt find the account if it
      // was in fact created.
      this.logger.warn(`Ichancy link ambiguous for player ${player.id}: ${result.cause}`);
      throw new ServiceUnavailableError(
        PlayerErrorCodes.ICHANCY_LINK_AMBIGUOUS,
        'We could not confirm your gaming account just now. Please try again shortly.',
      );
    }

    const { ichancyPlayerId, created } = result.data;
    const sealedPassword = sealSecret(this.encryptionKey, credentials.password);

    const won = await this.prisma.runInTransaction(async (tx) => {
      const linked = await this.players.linkIchancyAccount(
        player.id,
        {
          ichancyPlayerId,
          ichancyLogin: credentials.login,
          ichancyEmail: credentials.email,
          ichancyPasswordEnc: sealedPassword,
        },
        tx,
      );

      if (linked) {
        await this.audit.write(tx, {
          action: 'player.ichancy.linked',
          // SYSTEM: linking is triggered by our own credit pipeline, not by a human decision.
          actor: SYSTEM_ACTOR,
          subjectType: 'Player',
          subjectId: player.id,
          before: { ichancyPlayerId: null, status: player.status },
          // The password is NEVER audited, in any form. The login is not a secret; the pair is.
          after: { ichancyPlayerId, ichancyLogin: credentials.login, status: 'ACTIVE' },
          metadata: { created },
          ...(correlationId !== null ? { correlationId } : {}),
        });
      }

      return linked;
    });

    if (won) {
      return {
        playerId: player.id,
        ichancyPlayerId,
        ichancyLogin: credentials.login,
        created,
      };
    }

    // We lost the compare-and-set. Someone linked this player while our HTTP call was in flight —
    // their id is authoritative, not ours.
    this.logger.warn(
      `Player ${player.id} was linked concurrently; keeping the stored Ichancy id over ${ichancyPlayerId}`,
    );
    const winner = await this.players.findById(player.id);
    const linked = winner === null ? null : this.asLinked(winner, false);
    if (linked === null) {
      throw new ServiceUnavailableError(
        PlayerErrorCodes.ICHANCY_LINK_AMBIGUOUS,
        'We could not confirm your gaming account just now. Please try again shortly.',
      );
    }
    return linked;
  }

  /** Narrows a row to a fully-linked account, or null when any piece is missing. */
  private asLinked(player: Player, created: boolean): LinkedIchancyAccount | null {
    if (player.ichancyPlayerId === null || player.ichancyLogin === null) return null;
    return {
      playerId: player.id,
      ichancyPlayerId: player.ichancyPlayerId,
      ichancyLogin: player.ichancyLogin,
      created,
    };
  }
}
