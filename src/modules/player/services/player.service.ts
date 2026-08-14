/**
 * Read/profile side of the player module. The transaction boundary lives here, not in the
 * repository and not in the controller.
 *
 * WHY eligibility is a separate, explicit method rather than a flag on the view: "may this player
 * put money in right now?" is the question the deposit path asks, and it is answered by two
 * different sources — `players.status` and the `self_exclusions` table. Anything that answers it
 * from one source only is wrong, and a boolean on a view object invites exactly that.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '@core/prisma/prisma.service';
import type { Tx } from '@core/prisma/tx.type';
import { AuditService } from '@core/audit/audit.service';
import { BusinessRuleError, NotFoundError } from '@common/exceptions/app.exception';
import { paginate, type PaginatedResult } from '@common/dtos/paginated.dto';

import { PlayerRepository, type TelegramProfile } from '../repositories/player.repository';
import { PlayerErrorCodes } from '../player.constants';
import {
  toAdminPlayerView,
  toPlayerView,
  type AdminPlayerView,
  type PlayerView,
} from '../dtos/player.view';
import { PlayerAccessService, type PlayerViewer } from './player-access.service';

/** Why a player may not transact right now. `null` reason means they may. */
export interface PlayerEligibility {
  eligible: boolean;
  reason: string | null;
  /** When a temporary self-exclusion lifts. Null for permanent, or when eligible. */
  excludedUntil: Date | null;
}

@Injectable()
export class PlayerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly players: PlayerRepository,
    private readonly access: PlayerAccessService,
    private readonly audit: AuditService,
  ) {}

  /** Scoped read: a player asking for someone else gets a 404, never a 403 that confirms existence. */
  async getView(viewer: PlayerViewer, playerId: string): Promise<PlayerView> {
    const player = await this.prisma.player.findFirst({
      where: this.access.scopedPlayerWhere(viewer, { id: playerId }),
    });
    if (player === null) {
      throw new NotFoundError(PlayerErrorCodes.PLAYER_NOT_FOUND, 'Player not found.');
    }
    return viewer.type === 'PLAYER' ? toPlayerView(player) : toAdminPlayerView(player);
  }

  async getOwnView(playerId: string): Promise<PlayerView> {
    const player = await this.players.findById(playerId);
    if (player === null) {
      throw new NotFoundError(PlayerErrorCodes.PLAYER_NOT_FOUND, 'Player not found.');
    }
    return toPlayerView(player);
  }

  /**
   * Staff list. The scope is applied even though only admins reach this route: a route's decorator
   * is one edit away from being wrong, and the filter costs nothing.
   */
  async list(
    viewer: PlayerViewer,
    filter: Prisma.PlayerWhereInput,
    limit: number,
    offset: number,
  ): Promise<PaginatedResult<AdminPlayerView>> {
    const where = this.access.scopedPlayerWhere(viewer, filter);
    const [rows, total] = await Promise.all([
      this.players.findMany(where, limit, offset),
      this.players.count(where),
    ]);
    return paginate(rows.map(toAdminPlayerView), total, limit, offset);
  }

  /**
   * First sight or returning visit. Takes `tx` so the caller can commit the player row and the
   * login audit together — a session that exists without the row it belongs to is unexplainable.
   */
  async upsertFromTelegram(
    tx: Tx,
    profile: TelegramProfile,
    currencyCode: string,
  ): Promise<{ player: PlayerView; playerId: string; isNew: boolean }> {
    const before = await this.players.findByTelegramUserId(profile.telegramUserId, tx);
    const player = await this.players.upsertFromTelegram(profile, currencyCode, tx);
    const isNew = before === null;

    if (isNew) {
      await this.audit.write(tx, {
        action: 'player.registered',
        actor: { type: 'PLAYER', id: player.id },
        subjectType: 'Player',
        subjectId: player.id,
        after: {
          telegramUserId: player.telegramUserId.toString(),
          telegramUsername: player.telegramUsername,
          currencyCode: player.currencyCode,
        },
      });
    }

    return { player: toPlayerView(player), playerId: player.id, isNew };
  }

  /**
   * The single authority on "may this player transact?".
   * Reads BOTH sources; a caller that checks only `status` would miss a self-exclusion, which is the
   * one rule we are least allowed to get wrong.
   */
  async checkEligibility(playerId: string, tx?: Tx): Promise<PlayerEligibility> {
    const client: Tx = tx ?? this.prisma;

    const player = await client.player.findUnique({
      where: { id: playerId },
      select: { status: true },
    });
    if (player === null) {
      return { eligible: false, reason: PlayerErrorCodes.PLAYER_NOT_FOUND, excludedUntil: null };
    }

    const now = new Date();
    const exclusion = await client.selfExclusion.findFirst({
      where: {
        playerId,
        revokedAt: null,
        startsAt: { lte: now },
        // `endsAt: null` is a PERMANENT exclusion, not a missing value. Any filter that reads it as
        // "no end date, so not active" inverts the strictest rule in the system.
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      },
      select: { endsAt: true },
      orderBy: { startsAt: 'desc' },
    });

    if (exclusion !== null) {
      return {
        eligible: false,
        reason: PlayerErrorCodes.PLAYER_SELF_EXCLUDED,
        excludedUntil: exclusion.endsAt,
      };
    }

    // PENDING_ICHANCY is eligible on purpose: the mirror is created lazily, just before the first
    // credit. Refusing it here would make the first deposit impossible for every new player.
    if (player.status !== 'ACTIVE' && player.status !== 'PENDING_ICHANCY') {
      return { eligible: false, reason: PlayerErrorCodes.PLAYER_NOT_ACTIVE, excludedUntil: null };
    }

    return { eligible: true, reason: null, excludedUntil: null };
  }

  /** Throwing variant for call sites that cannot continue without eligibility. */
  async assertEligible(playerId: string, tx?: Tx): Promise<void> {
    const eligibility = await this.checkEligibility(playerId, tx);
    if (eligibility.eligible) return;

    if (eligibility.reason === PlayerErrorCodes.PLAYER_NOT_FOUND) {
      throw new NotFoundError(PlayerErrorCodes.PLAYER_NOT_FOUND, 'Player not found.');
    }
    if (eligibility.reason === PlayerErrorCodes.PLAYER_SELF_EXCLUDED) {
      throw new BusinessRuleError(
        PlayerErrorCodes.PLAYER_SELF_EXCLUDED,
        'Your account is currently self-excluded.',
        eligibility.excludedUntil === null
          ? undefined
          : { until: eligibility.excludedUntil.toISOString() },
      );
    }
    throw new BusinessRuleError(
      PlayerErrorCodes.PLAYER_NOT_ACTIVE,
      'Your account is not able to transact at the moment.',
    );
  }

  async touchLastSeen(playerId: string): Promise<void> {
    await this.players.touchLastSeen(playerId);
  }
}
