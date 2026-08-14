/**
 * WHY `todayVolumeByDestination` is a groupBy and not a findMany-plus-sum: unlike an admin's daily
 * approvals (bounded by how fast a human clicks), this counts EVERY deposit against a method today.
 * On a busy day that is thousands of rows, fetched on the path that picks a destination for each
 * new deposit — so the sum belongs in the database.
 *
 * The volumes are advisory: `dailyCapMinor` is documented as a soft cap used to spread load, not a
 * constraint. It is measured against CLAIMED amounts because that is what is known at the moment a
 * destination is offered; the verified amount does not exist yet.
 */
import { Injectable } from '@nestjs/common';
import { Prisma, type PaymentDestination } from '@prisma/client';

import { BaseRepository, type PrismaDelegate } from '@core/prisma/base.repository';
import { PrismaService } from '@core/prisma/prisma.service';
import type { Tx } from '@core/prisma/tx.type';

type DestinationDelegate = PrismaDelegate<
  PaymentDestination,
  Prisma.PaymentDestinationWhereUniqueInput,
  Prisma.PaymentDestinationWhereInput,
  Prisma.PaymentDestinationCreateInput,
  Prisma.PaymentDestinationUpdateInput,
  Prisma.PaymentDestinationOrderByWithRelationInput
>;

@Injectable()
export class PaymentDestinationRepository extends BaseRepository<
  PaymentDestination,
  Prisma.PaymentDestinationWhereUniqueInput,
  Prisma.PaymentDestinationWhereInput,
  Prisma.PaymentDestinationCreateInput,
  Prisma.PaymentDestinationUpdateInput,
  Prisma.PaymentDestinationOrderByWithRelationInput
> {
  protected readonly modelName = 'PaymentDestination';

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: Tx): DestinationDelegate {
    return client.paymentDestination;
  }

  findById(id: string, tx?: Tx): Promise<PaymentDestination | null> {
    return this._findUnique({ id }, tx);
  }

  listForMethod(
    paymentMethodId: string,
    activeOnly: boolean,
    tx?: Tx,
  ): Promise<PaymentDestination[]> {
    return this._findMany(
      {
        where: { paymentMethodId, ...(activeOnly ? { isActive: true } : {}) },
        // Deterministic order matters: the rotation cursor indexes into this list, so an unstable
        // order would hand consecutive players the same slot.
        orderBy: [{ priority: 'asc' }, { id: 'asc' }],
      },
      tx,
    );
  }

  create(
    data: Prisma.PaymentDestinationUncheckedCreateInput,
    tx?: Tx,
  ): Promise<PaymentDestination> {
    return this.run('create', () => (tx ?? this.prisma).paymentDestination.create({ data }));
  }

  update(
    id: string,
    data: Prisma.PaymentDestinationUpdateInput,
    tx?: Tx,
  ): Promise<PaymentDestination> {
    return this._update({ id }, data, tx);
  }

  /** Claimed volume booked against each destination since `since`. Missing key = no volume. */
  async volumeSince(
    destinationIds: readonly string[],
    since: Date,
    tx?: Tx,
  ): Promise<Map<string, bigint>> {
    if (destinationIds.length === 0) return new Map();

    const rows = await (tx ?? this.prisma).depositRequest.groupBy({
      by: ['paymentDestinationId'],
      where: {
        paymentDestinationId: { in: [...destinationIds] },
        createdAt: { gte: since },
        // A rejected or expired request never brought money in, so it must not consume a cap.
        status: { notIn: ['REJECTED', 'EXPIRED'] },
      },
      _sum: { claimedAmountMinor: true },
    });

    const volumes = new Map<string, bigint>();
    for (const row of rows) {
      if (row.paymentDestinationId === null) continue;
      volumes.set(row.paymentDestinationId, row._sum.claimedAmountMinor ?? 0n);
    }
    return volumes;
  }
}
