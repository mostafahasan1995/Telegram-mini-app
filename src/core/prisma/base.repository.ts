/**
 * WHY: every repository in this codebase must (a) be usable inside a caller-owned transaction and
 * (b) never leak a raw Prisma error upwards. Doing that by hand in ~15 repositories guarantees that
 * one of them forgets the `tx` argument and silently writes outside the money transaction. So the
 * plumbing lives here once, fully typed — there is no untyped `findAll(): Promise<any>` half.
 *
 * The `tx` parameter is LAST here because it is optional; public repository methods that write
 * money still take `tx` FIRST, as the project contract requires. `_`-prefixed members are meant to
 * be wrapped by a named method (`findByShortId`, `markCredited`, …), not called from a service.
 */
import type { Prisma } from '@prisma/client';

import type { Tx } from './tx.type';
import type { PrismaService } from './prisma.service';
import { mapPrismaError } from './prisma-errors';

/** The slice of a generated Prisma delegate this base class is allowed to touch. */
export interface PrismaDelegate<TEntity, TWhereUnique, TWhere, TCreate, TUpdate, TOrderBy> {
  create(args: { data: TCreate }): Prisma.PrismaPromise<TEntity>;
  findUnique(args: { where: TWhereUnique }): Prisma.PrismaPromise<TEntity | null>;
  findFirst(args?: {
    where?: TWhere;
    orderBy?: TOrderBy | TOrderBy[];
  }): Prisma.PrismaPromise<TEntity | null>;
  findMany(args?: FindManyArgs<TWhereUnique, TWhere, TOrderBy>): Prisma.PrismaPromise<TEntity[]>;
  update(args: { where: TWhereUnique; data: TUpdate }): Prisma.PrismaPromise<TEntity>;
  updateMany(args: { where?: TWhere; data: TUpdate }): Prisma.PrismaPromise<{ count: number }>;
  count(args?: { where?: TWhere }): Prisma.PrismaPromise<number>;
}

export interface FindManyArgs<TWhereUnique, TWhere, TOrderBy> {
  where?: TWhere;
  orderBy?: TOrderBy | TOrderBy[];
  cursor?: TWhereUnique;
  skip?: number;
  take?: number;
}

export interface PageRequest<TWhere, TOrderBy> {
  where?: TWhere;
  orderBy?: TOrderBy | TOrderBy[];
  /** 1-based. */
  page?: number;
  pageSize?: number;
}

export interface Page<TEntity> {
  items: TEntity[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  hasNext: boolean;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export abstract class BaseRepository<
  TEntity,
  TWhereUnique,
  TWhere,
  TCreate,
  TUpdate,
  TOrderBy = never,
> {
  /** Prisma model name; only used to make error messages and logs identifiable. */
  protected abstract readonly modelName: string;

  constructor(protected readonly prisma: PrismaService) {}

  /** e.g. `protected delegate(client: Tx) { return client.depositRequest; }` */
  protected abstract delegate(
    client: Tx,
  ): PrismaDelegate<TEntity, TWhereUnique, TWhere, TCreate, TUpdate, TOrderBy>;

  /** No `tx` means "own connection, own implicit transaction" — never a hidden join to another one. */
  protected db(tx?: Tx): PrismaDelegate<TEntity, TWhereUnique, TWhere, TCreate, TUpdate, TOrderBy> {
    return this.delegate(tx ?? this.prisma);
  }

  protected async run<T>(operation: string, thunk: () => Promise<T>): Promise<T> {
    try {
      return await thunk();
    } catch (error) {
      throw mapPrismaError(error, { model: this.modelName, operation });
    }
  }

  protected _create(data: TCreate, tx?: Tx): Promise<TEntity> {
    return this.run('create', () => this.db(tx).create({ data }));
  }

  protected _findUnique(where: TWhereUnique, tx?: Tx): Promise<TEntity | null> {
    return this.run('findUnique', () => this.db(tx).findUnique({ where }));
  }

  protected _findFirst(
    args: { where?: TWhere; orderBy?: TOrderBy | TOrderBy[] } = {},
    tx?: Tx,
  ): Promise<TEntity | null> {
    return this.run('findFirst', () => this.db(tx).findFirst(args));
  }

  protected _findMany(
    args: FindManyArgs<TWhereUnique, TWhere, TOrderBy> = {},
    tx?: Tx,
  ): Promise<TEntity[]> {
    return this.run('findMany', () => this.db(tx).findMany(args));
  }

  protected _update(where: TWhereUnique, data: TUpdate, tx?: Tx): Promise<TEntity> {
    return this.run('update', () => this.db(tx).update({ where, data }));
  }

  protected _updateMany(where: TWhere, data: TUpdate, tx?: Tx): Promise<number> {
    return this.run(
      'updateMany',
      async () => (await this.db(tx).updateMany({ where, data })).count,
    );
  }

  protected _count(where?: TWhere, tx?: Tx): Promise<number> {
    return this.run('count', () => this.db(tx).count({ where }));
  }

  protected async _exists(where: TWhere, tx?: Tx): Promise<boolean> {
    return (await this._count(where, tx)) > 0;
  }

  /**
   * Count and page are read in ONE call site so both statements share the caller's transaction when
   * there is one; outside a transaction the total is a best-effort snapshot, which is fine for the
   * admin lists this exists for.
   */
  protected async _paginate(
    request: PageRequest<TWhere, TOrderBy> = {},
    tx?: Tx,
  ): Promise<Page<TEntity>> {
    const pageSize = Math.min(Math.max(1, request.pageSize ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
    const page = Math.max(1, request.page ?? 1);

    const total = await this._count(request.where, tx);
    const items = await this._findMany(
      {
        ...(request.where !== undefined ? { where: request.where } : {}),
        ...(request.orderBy !== undefined ? { orderBy: request.orderBy } : {}),
        skip: (page - 1) * pageSize,
        take: pageSize,
      },
      tx,
    );

    const pageCount = Math.ceil(total / pageSize);
    return { items, total, page, pageSize, pageCount, hasNext: page < pageCount };
  }
}
