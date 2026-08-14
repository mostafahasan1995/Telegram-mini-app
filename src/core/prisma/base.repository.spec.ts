/**
 * Doubles as the compile-time proof that a REAL generated Prisma delegate (`client.currency`)
 * satisfies `PrismaDelegate`. If Prisma ever changes a delegate signature, this file stops
 * compiling — which is exactly when we want to find out, not at runtime in a repository.
 */
import type { Currency, Prisma } from '@prisma/client';

import { BaseRepository, type PrismaDelegate } from './base.repository';
import {
  ForeignKeyConstraintError,
  RecordNotFoundError,
  UniqueConstraintError,
} from './prisma-errors';
import type { PrismaService } from './prisma.service';
import type { Tx } from './tx.type';

type CurrencyDelegate = PrismaDelegate<
  Currency,
  Prisma.CurrencyWhereUniqueInput,
  Prisma.CurrencyWhereInput,
  Prisma.CurrencyCreateInput,
  Prisma.CurrencyUpdateInput,
  Prisma.CurrencyOrderByWithRelationInput
>;

class CurrencyRepository extends BaseRepository<
  Currency,
  Prisma.CurrencyWhereUniqueInput,
  Prisma.CurrencyWhereInput,
  Prisma.CurrencyCreateInput,
  Prisma.CurrencyUpdateInput,
  Prisma.CurrencyOrderByWithRelationInput
> {
  protected readonly modelName = 'Currency';

  protected delegate(client: Tx): CurrencyDelegate {
    return client.currency;
  }

  create(data: Prisma.CurrencyCreateInput, tx?: Tx): Promise<Currency> {
    return this._create(data, tx);
  }

  findByCode(code: string, tx?: Tx): Promise<Currency | null> {
    return this._findUnique({ code }, tx);
  }

  rename(code: string, name: string, tx?: Tx): Promise<Currency> {
    return this._update({ code }, { name }, tx);
  }

  page(page: number, pageSize: number, tx?: Tx) {
    return this._paginate({ where: { isActive: true }, page, pageSize }, tx);
  }

  countActive(tx?: Tx): Promise<number> {
    return this._count({ isActive: true }, tx);
  }
}

const NSP: Currency = {
  code: 'NSP',
  name: 'New Syrian Pound',
  scale: 2,
  symbol: null,
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function makeDelegate() {
  return {
    create: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn(),
  };
}

type FakeDelegate = ReturnType<typeof makeDelegate>;

function makeRepository(): {
  repo: CurrencyRepository;
  root: FakeDelegate;
  txDelegate: FakeDelegate;
  tx: Tx;
} {
  const root = makeDelegate();
  const txDelegate = makeDelegate();
  const repo = new CurrencyRepository({ currency: root } as unknown as PrismaService);
  return { repo, root, txDelegate, tx: { currency: txDelegate } as unknown as Tx };
}

describe('BaseRepository', () => {
  it('uses the root client when no transaction is supplied', async () => {
    const { repo, root, txDelegate } = makeRepository();
    root.findUnique.mockResolvedValue(NSP);

    await expect(repo.findByCode('NSP')).resolves.toBe(NSP);
    expect(root.findUnique).toHaveBeenCalledWith({ where: { code: 'NSP' } });
    expect(txDelegate.findUnique).not.toHaveBeenCalled();
  });

  it('runs on the caller’s transaction when one is supplied', async () => {
    const { repo, root, txDelegate, tx } = makeRepository();
    txDelegate.update.mockResolvedValue(NSP);

    await expect(repo.rename('NSP', 'New Syrian Pound', tx)).resolves.toBe(NSP);
    expect(txDelegate.update).toHaveBeenCalledWith({
      where: { code: 'NSP' },
      data: { name: 'New Syrian Pound' },
    });
    expect(root.update).not.toHaveBeenCalled();
  });

  describe('error mapping', () => {
    it('turns P2002 into UniqueConstraintError carrying the offending fields', async () => {
      const { repo, root } = makeRepository();
      root.create.mockRejectedValue(
        Object.assign(new Error('unique'), { code: 'P2002', meta: { target: ['code'] } }),
      );

      const error = await repo
        .create({ code: 'NSP', name: 'x', scale: 2 })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UniqueConstraintError);
      expect((error as UniqueConstraintError).fields).toEqual(['code']);
      expect((error as UniqueConstraintError).model).toBe('Currency');
      expect((error as UniqueConstraintError).operation).toBe('create');
    });

    it('turns P2025 into RecordNotFoundError', async () => {
      const { repo, root } = makeRepository();
      root.update.mockRejectedValue(Object.assign(new Error('missing'), { code: 'P2025' }));

      await expect(repo.rename('ZZZ', 'nope')).rejects.toBeInstanceOf(RecordNotFoundError);
    });

    it('turns P2003 into ForeignKeyConstraintError with the field name', async () => {
      const { repo, root } = makeRepository();
      root.create.mockRejectedValue(
        Object.assign(new Error('fk'), { code: 'P2003', meta: { field_name: 'currency_code' } }),
      );

      const error = await repo.create({ code: 'X', name: 'x', scale: 2 }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ForeignKeyConstraintError);
      expect((error as ForeignKeyConstraintError).field).toBe('currency_code');
    });

    // The shapes below are copied verbatim from Prisma 7 + @prisma/adapter-pg against PG17. They
    // are NOT what the Prisma docs describe, and getting them wrong means every unique violation
    // silently reports zero fields.
    it('reads the fields out of a REAL driver-adapter P2002', async () => {
      const { repo, root } = makeRepository();
      root.create.mockRejectedValue(
        Object.assign(new Error('unique'), {
          code: 'P2002',
          meta: {
            modelName: 'Currency',
            driverAdapterError: {
              name: 'DriverAdapterError',
              cause: {
                originalCode: '23505',
                kind: 'UniqueConstraintViolation',
                constraint: { fields: ['code'] },
              },
            },
          },
        }),
      );

      const error = await repo
        .create({ code: 'NSP', name: 'x', scale: 2 })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UniqueConstraintError);
      expect((error as UniqueConstraintError).fields).toEqual(['code']);
      expect((error as UniqueConstraintError).sqlState).toBe('23505');
    });

    it('reads the constraint name out of a REAL driver-adapter P2003', async () => {
      const { repo, root } = makeRepository();
      root.create.mockRejectedValue(
        Object.assign(new Error('fk'), {
          code: 'P2003',
          meta: {
            modelName: 'Player',
            driverAdapterError: {
              name: 'DriverAdapterError',
              cause: {
                originalCode: '23503',
                kind: 'ForeignKeyConstraintViolation',
                constraint: { index: 'players_currency_code_fkey' },
              },
            },
          },
        }),
      );

      const error = await repo.create({ code: 'X', name: 'x', scale: 2 }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ForeignKeyConstraintError);
      expect((error as ForeignKeyConstraintError).field).toBe('players_currency_code_fkey');
      expect((error as ForeignKeyConstraintError).constraint).toBe('players_currency_code_fkey');
    });

    it('leaves a write conflict alone so withSerializationRetry can still see it', async () => {
      const { repo, root } = makeRepository();
      const conflict = Object.assign(new Error('conflict'), { code: 'P2034' });
      root.update.mockRejectedValue(conflict);

      await expect(repo.rename('NSP', 'x')).rejects.toBe(conflict);
    });

    it('leaves an unknown error untouched instead of flattening it', async () => {
      const { repo, root } = makeRepository();
      const boom = new Error('socket hang up');
      root.count.mockRejectedValue(boom);

      await expect(repo.countActive()).rejects.toBe(boom);
    });
  });

  describe('_paginate', () => {
    it('computes skip/take and the page metadata', async () => {
      const { repo, root } = makeRepository();
      root.count.mockResolvedValue(42);
      root.findMany.mockResolvedValue([NSP]);

      const result = await repo.page(3, 20);

      expect(root.findMany).toHaveBeenCalledWith({
        where: { isActive: true },
        skip: 40,
        take: 20,
      });
      expect(result).toEqual({
        items: [NSP],
        total: 42,
        page: 3,
        pageSize: 20,
        pageCount: 3,
        hasNext: false,
      });
    });

    it('reports hasNext while pages remain', async () => {
      const { repo, root } = makeRepository();
      root.count.mockResolvedValue(42);
      root.findMany.mockResolvedValue([NSP]);

      await expect(repo.page(1, 20)).resolves.toMatchObject({ pageCount: 3, hasNext: true });
    });

    it('clamps an abusive page size and a nonsense page number', async () => {
      const { repo, root } = makeRepository();
      root.count.mockResolvedValue(0);
      root.findMany.mockResolvedValue([]);

      const result = await repo.page(-5, 10_000);

      expect(result.pageSize).toBe(100);
      expect(result.page).toBe(1);
      expect(root.findMany).toHaveBeenCalledWith({
        where: { isActive: true },
        skip: 0,
        take: 100,
      });
    });

    it('keeps the count inside the caller’s transaction', async () => {
      const { repo, txDelegate, root, tx } = makeRepository();
      txDelegate.count.mockResolvedValue(1);
      txDelegate.findMany.mockResolvedValue([NSP]);

      await repo.page(1, 20, tx);

      expect(txDelegate.count).toHaveBeenCalledTimes(1);
      expect(root.count).not.toHaveBeenCalled();
    });
  });
});
