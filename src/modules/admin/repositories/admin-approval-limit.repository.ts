/**
 * WHY limits are versioned rather than mutated (and why this repository has no `update` for the
 * money columns): an approval that happened last month must still be explicable by the limits that
 * were in force last month. Overwriting `maxSingleApprovalMinor` rewrites history — the audit trail
 * would show a decision that the current configuration forbids, with no way to tell whether the
 * rule changed or the rule was broken.
 *
 * So a "change" is: close the open row (`effectiveTo = now`) and insert a new one. The only column
 * this repository ever updates is `effectiveTo`.
 */
import { Injectable } from '@nestjs/common';
import { Prisma, type AdminApprovalLimit } from '@prisma/client';

import { BaseRepository, type PrismaDelegate } from '@core/prisma/base.repository';
import { PrismaService } from '@core/prisma/prisma.service';
import type { Tx } from '@core/prisma/tx.type';

type LimitDelegate = PrismaDelegate<
  AdminApprovalLimit,
  Prisma.AdminApprovalLimitWhereUniqueInput,
  Prisma.AdminApprovalLimitWhereInput,
  Prisma.AdminApprovalLimitCreateInput,
  Prisma.AdminApprovalLimitUpdateInput,
  Prisma.AdminApprovalLimitOrderByWithRelationInput
>;

@Injectable()
export class AdminApprovalLimitRepository extends BaseRepository<
  AdminApprovalLimit,
  Prisma.AdminApprovalLimitWhereUniqueInput,
  Prisma.AdminApprovalLimitWhereInput,
  Prisma.AdminApprovalLimitCreateInput,
  Prisma.AdminApprovalLimitUpdateInput,
  Prisma.AdminApprovalLimitOrderByWithRelationInput
> {
  protected readonly modelName = 'AdminApprovalLimit';

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: Tx): LimitDelegate {
    return client.adminApprovalLimit;
  }

  findById(id: string, tx?: Tx): Promise<AdminApprovalLimit | null> {
    return this._findUnique({ id }, tx);
  }

  /**
   * The row in force for (admin, currency) at `at`.
   *
   * `effectiveTo: null` means "still open", NOT "expired" — a filter that treats a null end date as
   * inactive would silently deny every correctly-configured admin. Both branches are spelled out.
   */
  findEffective(
    adminUserId: string,
    currencyCode: string,
    at: Date,
    tx?: Tx,
  ): Promise<AdminApprovalLimit | null> {
    return this._findFirst(
      {
        where: {
          adminUserId,
          currencyCode,
          effectiveFrom: { lte: at },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
        },
        // Most recent applicable version wins if several ever overlap.
        orderBy: { effectiveFrom: 'desc' },
      },
      tx,
    );
  }

  listForAdmin(adminUserId: string, tx?: Tx): Promise<AdminApprovalLimit[]> {
    return this._findMany({ where: { adminUserId }, orderBy: { effectiveFrom: 'desc' } }, tx);
  }

  create(
    data: Prisma.AdminApprovalLimitUncheckedCreateInput,
    tx?: Tx,
  ): Promise<AdminApprovalLimit> {
    // Unchecked create (plain FK columns) rather than nested `connect`: this row is written inside
    // the same transaction as the row it closes, and the relation objects add nothing but noise.
    return this.run('create', () => (tx ?? this.prisma).adminApprovalLimit.create({ data }));
  }

  /** Closes every open version for (admin, currency). Returns how many were closed. */
  closeOpen(adminUserId: string, currencyCode: string, at: Date, tx?: Tx): Promise<number> {
    return this._updateMany(
      { adminUserId, currencyCode, effectiveTo: null },
      { effectiveTo: at },
      tx,
    );
  }

  /** Ends one specific version. */
  close(id: string, at: Date, tx?: Tx): Promise<AdminApprovalLimit> {
    return this._update({ id }, { effectiveTo: at }, tx);
  }
}
