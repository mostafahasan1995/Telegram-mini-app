/**
 * WHY hand-written mappers instead of returning the Prisma row (or a class-transformer DTO with
 * @Exclude): `players` holds `ichancyPasswordEnc`. An allow-list that is a plain function cannot be
 * defeated by a forgotten decorator, a missing `excludeExtraneousValues`, or an interceptor that
 * was not applied to one route. Every field a client sees is typed out below, once.
 *
 * `telegramUserId` leaves as a STRING. It is a 64-bit value and `JSON.stringify` of a bigint throws
 * without the global patch; a number would round. The API contract is: ids are strings.
 */
import type { Player, PlayerStatus } from '@prisma/client';

/** What a player may see about themselves. */
export interface PlayerView {
  id: string;
  telegramUserId: string;
  telegramUsername: string | null;
  firstName: string | null;
  lastName: string | null;
  languageCode: string | null;
  status: PlayerStatus;
  currencyCode: string;
  /**
   * Whether the Ichancy mirror exists yet. The id itself is deliberately NOT exposed to players:
   * it is an identifier in someone else's system and knowing it enables nothing good.
   */
  ichancyLinked: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}

/** Everything staff may see. Adds the operational identifiers, never the credentials. */
export interface AdminPlayerView extends PlayerView {
  ichancyPlayerId: string | null;
  ichancyLogin: string | null;
  ichancyRegisteredAt: string | null;
  phone: string | null;
}

export function toPlayerView(player: Player): PlayerView {
  return {
    id: player.id,
    telegramUserId: player.telegramUserId.toString(),
    telegramUsername: player.telegramUsername,
    firstName: player.firstName,
    lastName: player.lastName,
    languageCode: player.languageCode,
    status: player.status,
    currencyCode: player.currencyCode,
    ichancyLinked: player.ichancyPlayerId !== null,
    createdAt: player.createdAt.toISOString(),
    lastSeenAt: player.lastSeenAt?.toISOString() ?? null,
  };
}

export function toAdminPlayerView(player: Player): AdminPlayerView {
  return {
    ...toPlayerView(player),
    ichancyPlayerId: player.ichancyPlayerId,
    ichancyLogin: player.ichancyLogin,
    ichancyRegisteredAt: player.ichancyRegisteredAt?.toISOString() ?? null,
    phone: player.phone,
  };
}
