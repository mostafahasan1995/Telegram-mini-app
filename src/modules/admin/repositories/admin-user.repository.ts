/**
 * WHY `countActiveSuperAdmins` lives here: it is the query behind the guard that stops the last
 * SUPER_ADMIN being deactivated. That check must run inside the SAME transaction as the write it
 * guards, or two concurrent deactivations each see "there are still 2" and lock everyone out.
 */
import { Injectable } from '@nestjs/common';
import { Prisma, type AdminUser } from '@prisma/client';

import { BaseRepository, type PrismaDelegate } from '@core/prisma/base.repository';
import { PrismaService } from '@core/prisma/prisma.service';
import type { Tx } from '@core/prisma/tx.type';

type AdminUserDelegate = PrismaDelegate<
  AdminUser,
  Prisma.AdminUserWhereUniqueInput,
  Prisma.AdminUserWhereInput,
  Prisma.AdminUserCreateInput,
  Prisma.AdminUserUpdateInput,
  Prisma.AdminUserOrderByWithRelationInput
>;

@Injectable()
export class AdminUserRepository extends BaseRepository<
  AdminUser,
  Prisma.AdminUserWhereUniqueInput,
  Prisma.AdminUserWhereInput,
  Prisma.AdminUserCreateInput,
  Prisma.AdminUserUpdateInput,
  Prisma.AdminUserOrderByWithRelationInput
> {
  protected readonly modelName = 'AdminUser';

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: Tx): AdminUserDelegate {
    return client.adminUser;
  }

  /**
   * WHY THERE IS NO PLAIN `findById`: `id` is this table's whole primary key, so a `findUnique` on
   * it names no tenant, and the tenant-scope extension does not rewrite unique selectors. A bare
   * lookup by id is how a SUPER_ADMIN of one operator read, and then reset the password of, another
   * operator's SUPER_ADMIN — a credential takeover with that operator's money behind it. Every
   * lookup by id says which operator it means, and a row from another one is simply not found.
   */
  findByIdInTenant(tenantId: string, id: string, tx?: Tx): Promise<AdminUser | null> {
    return this._findFirst({ where: { tenantId, id } }, tx);
  }

  /**
   * WHY THE TENANT IS A PARAMETER and not a read of the ambient context: this lookup is reached
   * from an HTTP request AND from the bot, and the bot has no request context to read. A Telegram
   * id is only unique within an operator now — `@@unique([tenantId, telegramUserId])` — so the
   * caller has to say which one it means, and the compiler makes sure it does.
   */
  findByTelegramUserId(
    tenantId: string,
    telegramUserId: bigint,
    tx?: Tx,
  ): Promise<AdminUser | null> {
    return this._findUnique({ tenantId_telegramUserId: { tenantId, telegramUserId } }, tx);
  }

  create(data: Prisma.AdminUserCreateInput, tx?: Tx): Promise<AdminUser> {
    return this._create(data, tx);
  }

  /**
   * The tenant sits in the unique selector next to the id, so even a caller that skipped the
   * tenant-bound read cannot write into another operator: the row does not match and nothing
   * changes.
   */
  updateInTenant(
    tenantId: string,
    id: string,
    data: Prisma.AdminUserUpdateInput,
    tx?: Tx,
  ): Promise<AdminUser> {
    return this._update({ id, tenantId }, data, tx);
  }

  list(
    where: Prisma.AdminUserWhereInput,
    take: number,
    skip: number,
    tx?: Tx,
  ): Promise<AdminUser[]> {
    return this._findMany(
      { where, take, skip, orderBy: [{ isActive: 'desc' }, { displayName: 'asc' }] },
      tx,
    );
  }

  count(where: Prisma.AdminUserWhereInput, tx?: Tx): Promise<number> {
    return this._count(where, tx);
  }

  /**
   * An active SUPER_ADMIN of the operator: the one with this username when one is given, else the
   * OLDEST (the operator's first owner). The id breaks a created_at tie so the answer is stable.
   * The tenant is named explicitly because the agent sign-in reaches here from a @Public route.
   */
  findActiveSuperAdmin(tenantId: string, username: string | null, tx?: Tx): Promise<AdminUser | null> {
    return this._findFirst(
      {
        where: {
          tenantId,
          role: 'SUPER_ADMIN',
          isActive: true,
          ...(username !== null ? { username } : {}),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      },
      tx,
    );
  }

  /** Every row of the operator, active or not — "does it have any staff at all?". */
  countInTenant(tenantId: string, tx?: Tx): Promise<number> {
    return this._count({ tenantId }, tx);
  }

  /**
   * Excludes `excludeId` so "would this change leave zero?" can be asked before writing. The
   * tenant is explicit so the answer is about the operator being changed, not whatever the
   * ambient filter happens to hold.
   */
  countActiveSuperAdmins(tenantId: string, excludeId: string | null, tx?: Tx): Promise<number> {
    return this._count(
      {
        tenantId,
        role: 'SUPER_ADMIN',
        isActive: true,
        ...(excludeId !== null ? { id: { not: excludeId } } : {}),
      },
      tx,
    );
  }
}
