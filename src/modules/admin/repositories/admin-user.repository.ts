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

  findById(id: string, tx?: Tx): Promise<AdminUser | null> {
    return this._findUnique({ id }, tx);
  }

  findByTelegramUserId(telegramUserId: bigint, tx?: Tx): Promise<AdminUser | null> {
    return this._findUnique({ telegramUserId }, tx);
  }

  create(data: Prisma.AdminUserCreateInput, tx?: Tx): Promise<AdminUser> {
    return this._create(data, tx);
  }

  update(id: string, data: Prisma.AdminUserUpdateInput, tx?: Tx): Promise<AdminUser> {
    return this._update({ id }, data, tx);
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

  /** Excludes `excludeId` so "would this change leave zero?" can be asked before writing. */
  countActiveSuperAdmins(excludeId: string | null, tx?: Tx): Promise<number> {
    return this._count(
      {
        role: 'SUPER_ADMIN',
        isActive: true,
        ...(excludeId !== null ? { id: { not: excludeId } } : {}),
      },
      tx,
    );
  }
}
