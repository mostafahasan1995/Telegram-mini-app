/**
 * WHY there is no `delete`: `payment_methods` is referenced by every deposit ever made through it
 * (onDelete: Restrict) and by its RAIL_CLEARING ledger account. Deletion would either be refused by
 * the database or would orphan financial history. Retirement is `isActive: false`.
 */
import { Injectable } from '@nestjs/common';
import { Prisma, type PaymentMethod } from '@prisma/client';

import { BaseRepository, type PrismaDelegate } from '@core/prisma/base.repository';
import { PrismaService } from '@core/prisma/prisma.service';
import type { Tx } from '@core/prisma/tx.type';

type MethodDelegate = PrismaDelegate<
  PaymentMethod,
  Prisma.PaymentMethodWhereUniqueInput,
  Prisma.PaymentMethodWhereInput,
  Prisma.PaymentMethodCreateInput,
  Prisma.PaymentMethodUpdateInput,
  Prisma.PaymentMethodOrderByWithRelationInput
>;

@Injectable()
export class PaymentMethodRepository extends BaseRepository<
  PaymentMethod,
  Prisma.PaymentMethodWhereUniqueInput,
  Prisma.PaymentMethodWhereInput,
  Prisma.PaymentMethodCreateInput,
  Prisma.PaymentMethodUpdateInput,
  Prisma.PaymentMethodOrderByWithRelationInput
> {
  protected readonly modelName = 'PaymentMethod';

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: Tx): MethodDelegate {
    return client.paymentMethod;
  }

  findById(id: string, tx?: Tx): Promise<PaymentMethod | null> {
    return this._findUnique({ id }, tx);
  }

  findByCode(code: string, tx?: Tx): Promise<PaymentMethod | null> {
    return this._findUnique({ code }, tx);
  }

  /** Ordered exactly as the mini app should render them. */
  list(where: Prisma.PaymentMethodWhereInput, tx?: Tx): Promise<PaymentMethod[]> {
    return this._findMany({ where, orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }] }, tx);
  }

  count(where: Prisma.PaymentMethodWhereInput, tx?: Tx): Promise<number> {
    return this._count(where, tx);
  }

  create(data: Prisma.PaymentMethodUncheckedCreateInput, tx?: Tx): Promise<PaymentMethod> {
    return this.run('create', () => (tx ?? this.prisma).paymentMethod.create({ data }));
  }

  update(id: string, data: Prisma.PaymentMethodUpdateInput, tx?: Tx): Promise<PaymentMethod> {
    return this._update({ id }, data, tx);
  }
}
