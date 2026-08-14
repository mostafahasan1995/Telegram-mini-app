/**
 * WHY `upsertFromTelegram` is a single statement and not find-then-create: two taps on "open app"
 * race, both find nothing, and both insert. The second gets a 23505 on `telegram_user_id` and the
 * player sees a login failure on their very first interaction. Postgres' ON CONFLICT settles it.
 *
 * WHY the ichancy columns are written through a guarded updateMany rather than update(): linking is
 * the one write that must never be applied twice with different values. `where` re-asserts that the
 * mirror is still unlinked, so a loser in a race writes zero rows and is told so, instead of
 * overwriting a good id with a second one.
 */
import { Injectable } from '@nestjs/common';
import { Prisma, type Player, type PlayerStatus } from '@prisma/client';

import { BaseRepository, type PrismaDelegate } from '@core/prisma/base.repository';
import { PrismaService } from '@core/prisma/prisma.service';
import type { Tx } from '@core/prisma/tx.type';

type PlayerDelegate = PrismaDelegate<
  Player,
  Prisma.PlayerWhereUniqueInput,
  Prisma.PlayerWhereInput,
  Prisma.PlayerCreateInput,
  Prisma.PlayerUpdateInput,
  Prisma.PlayerOrderByWithRelationInput
>;

/** The Telegram-supplied profile fields we mirror onto every login. */
export interface TelegramProfile {
  telegramUserId: bigint;
  telegramUsername?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  languageCode?: string | null;
}

export interface IchancyLinkFields {
  ichancyPlayerId: string;
  ichancyLogin: string;
  ichancyEmail: string;
  ichancyPasswordEnc: string;
}

@Injectable()
export class PlayerRepository extends BaseRepository<
  Player,
  Prisma.PlayerWhereUniqueInput,
  Prisma.PlayerWhereInput,
  Prisma.PlayerCreateInput,
  Prisma.PlayerUpdateInput,
  Prisma.PlayerOrderByWithRelationInput
> {
  protected readonly modelName = 'Player';

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: Tx): PlayerDelegate {
    return client.player;
  }

  /**
   * `upsert` is not part of the PrismaDelegate slice the base class exposes (nothing else needs
   * it), so this one write reaches the client directly. Same tx semantics as every `_*` helper.
   */
  private client(tx?: Tx): Tx {
    return tx ?? this.prisma;
  }

  findById(id: string, tx?: Tx): Promise<Player | null> {
    return this._findUnique({ id }, tx);
  }

  findByTelegramUserId(telegramUserId: bigint, tx?: Tx): Promise<Player | null> {
    return this._findUnique({ telegramUserId }, tx);
  }

  findByIchancyLogin(login: string, tx?: Tx): Promise<Player | null> {
    return this._findUnique({ ichancyLogin: login }, tx);
  }

  findMany(where: Prisma.PlayerWhereInput, take: number, skip: number, tx?: Tx): Promise<Player[]> {
    return this._findMany({ where, take, skip, orderBy: { createdAt: 'desc' } }, tx);
  }

  count(where: Prisma.PlayerWhereInput, tx?: Tx): Promise<number> {
    return this._count(where, tx);
  }

  /**
   * Creates the player on first sight and refreshes the mutable Telegram profile afterwards.
   * `status` and every ichancy column are deliberately absent from the update branch: a returning
   * player must never be silently reset to PENDING_ICHANCY, and re-linking is not a login concern.
   */
  upsertFromTelegram(profile: TelegramProfile, currencyCode: string, tx?: Tx): Promise<Player> {
    const mutable = {
      telegramUsername: profile.telegramUsername ?? null,
      firstName: profile.firstName ?? null,
      lastName: profile.lastName ?? null,
      languageCode: profile.languageCode ?? null,
      lastSeenAt: new Date(),
    };

    return this.run('upsertFromTelegram', () =>
      this.client(tx).player.upsert({
        where: { telegramUserId: profile.telegramUserId },
        create: {
          telegramUserId: profile.telegramUserId,
          ...mutable,
          // MUST be the scalar FK, never `currency: { connect: { code } }`.
          // Prisma only compiles upsert() to a native INSERT ... ON CONFLICT when the operation is
          // simple; ANY nested write makes it fall back to find-then-create as separate queries,
          // which is precisely the race this method exists to avoid. With the `connect` form, two
          // updates arriving together both found nothing and both inserted, and the loser got
          // "Unique constraint violated on Player (telegram_user_id)" — observed in the worker log,
          // on a real /start. Keeping this scalar is what makes the header comment above true.
          currencyCode,
        },
        update: mutable,
      }),
    );
  }

  touchLastSeen(id: string, tx?: Tx): Promise<number> {
    return this._updateMany({ id }, { lastSeenAt: new Date() }, tx);
  }

  setStatus(id: string, status: PlayerStatus, tx?: Tx): Promise<Player> {
    return this._update({ id }, { status }, tx);
  }

  /**
   * Attaches the Ichancy mirror. Returns false when the player was linked by someone else first —
   * the caller must then re-read rather than assume its own id won.
   */
  async linkIchancyAccount(id: string, fields: IchancyLinkFields, tx?: Tx): Promise<boolean> {
    const updated = await this._updateMany(
      { id, ichancyPlayerId: null },
      {
        ichancyPlayerId: fields.ichancyPlayerId,
        ichancyLogin: fields.ichancyLogin,
        ichancyEmail: fields.ichancyEmail,
        ichancyPasswordEnc: fields.ichancyPasswordEnc,
        ichancyRegisteredAt: new Date(),
        // PENDING_ICHANCY exists precisely to mean "no mirror yet"; leaving it set after a
        // successful link would make every downstream eligibility check wrong.
        status: 'ACTIVE',
      },
      tx,
    );
    return updated === 1;
  }
}
