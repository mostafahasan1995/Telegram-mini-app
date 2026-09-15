/**
 * WHY `upsertFromTelegram` is a single statement and not find-then-create: two taps on "open app"
 * race, both find nothing, and both insert. The second gets a 23505 on
 * `(tenant_id, telegram_user_id)` and the player sees a login failure on their very first
 * interaction. Postgres' ON CONFLICT settles it.
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

  /**
   * No bare `findById(id)`: a player id reached by primary key alone ignores the operator, and every
   * caller of this repository knows which operator it is serving. Another operator's player misses
   * like an unknown one.
   */
  findByIdInTenant(tenantId: string, id: string, tx?: Tx): Promise<Player | null> {
    return this._findUnique({ id, tenantId }, tx);
  }

  /**
   * WHY THE TENANT IS A PARAMETER RATHER THAN READ FROM THE AMBIENT CONTEXT: a Telegram id only
   * identifies a player WITHIN an operator now (`@@unique([tenantId, telegramUserId])`), and half
   * of this repository's callers — bot handlers, the registration CLI — have no request context to
   * read one from. An argument forces every call site to answer "whose player?" when it is written.
   */
  findByTelegramUserId(tenantId: string, telegramUserId: bigint, tx?: Tx): Promise<Player | null> {
    return this._findUnique({ tenantId_telegramUserId: { tenantId, telegramUserId } }, tx);
  }

  findByIchancyLogin(tenantId: string, login: string, tx?: Tx): Promise<Player | null> {
    return this._findUnique({ tenantId_ichancyLogin: { tenantId, ichancyLogin: login } }, tx);
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
  upsertFromTelegram(
    tenantId: string,
    profile: TelegramProfile,
    currencyCode: string,
    tx?: Tx,
  ): Promise<Player> {
    const mutable = {
      telegramUsername: profile.telegramUsername ?? null,
      firstName: profile.firstName ?? null,
      lastName: profile.lastName ?? null,
      languageCode: profile.languageCode ?? null,
      lastSeenAt: new Date(),
    };

    return this.run('upsertFromTelegram', () =>
      this.client(tx).player.upsert({
        where: {
          tenantId_telegramUserId: { tenantId, telegramUserId: profile.telegramUserId },
        },
        create: {
          // The composite key above is the ON CONFLICT target, so the tenant has to be on the
          // INSERT branch as well: a row created here belongs to the operator we just searched.
          tenantId,
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

  setStatusInTenant(tenantId: string, id: string, status: PlayerStatus, tx?: Tx): Promise<Player> {
    return this._update({ id, tenantId }, { status }, tx);
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
