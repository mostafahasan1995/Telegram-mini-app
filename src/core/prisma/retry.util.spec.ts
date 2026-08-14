import { isSerializationError, withSerializationRetry } from './retry.util';

class FakePrismaError extends Error {
  constructor(
    readonly code: string,
    readonly meta?: Record<string, unknown>,
  ) {
    super(`prisma error ${code}`);
  }
}

/** Collects the delays instead of actually waiting, so the suite stays instant and deterministic. */
function recorder() {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number): Promise<void> => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

describe('isSerializationError', () => {
  it('accepts Prisma P2034', () => {
    expect(isSerializationError(new FakePrismaError('P2034'))).toBe(true);
  });

  it('accepts raw SQLSTATE 40001 and 40P01 from the pg driver', () => {
    expect(isSerializationError(Object.assign(new Error('boom'), { code: '40001' }))).toBe(true);
    expect(isSerializationError(Object.assign(new Error('boom'), { code: '40P01' }))).toBe(true);
  });

  it('accepts a SQLSTATE hidden in meta or meta.dbError', () => {
    expect(isSerializationError(new FakePrismaError('P2010', { code: '40001' }))).toBe(true);
    expect(isSerializationError(new FakePrismaError('P2010', { dbError: { code: '40P01' } }))).toBe(
      true,
    );
  });

  // Copied verbatim from a real SERIALIZABLE write skew on Prisma 7 + adapter-pg + PG17. Note the
  // Prisma code is P2010, NOT P2034 — matching on P2034 alone would never retry raw SQL.
  it('accepts the P2010 + driverAdapterError shape this stack actually throws', () => {
    const real = Object.assign(new Error('Raw query failed. Code: `40001`.'), {
      code: 'P2010',
      meta: {
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: {
            originalCode: '40001',
            originalMessage: 'could not serialize access due to read/write dependencies',
            kind: 'TransactionWriteConflict',
          },
        },
      },
    });

    expect(isSerializationError(real)).toBe(true);
  });

  it('accepts a driver-adapter conflict recognised only by its kind', () => {
    expect(
      isSerializationError({
        code: 'P2010',
        message: 'opaque',
        meta: { driverAdapterError: { cause: { kind: 'TransactionWriteConflict' } } },
      }),
    ).toBe(true);
  });

  it('accepts a wrapped cause', () => {
    const inner = Object.assign(new Error('inner'), { code: '40001' });
    expect(isSerializationError(new Error('outer', { cause: inner }))).toBe(true);
  });

  it('accepts the message the driver adapter surfaces', () => {
    expect(
      isSerializationError(new Error('could not serialize access due to concurrent update')),
    ).toBe(true);
    expect(isSerializationError(new Error('deadlock detected'))).toBe(true);
  });

  it('rejects business errors — retrying those would hide a bug', () => {
    expect(isSerializationError(new FakePrismaError('P2002'))).toBe(false);
    expect(isSerializationError(new FakePrismaError('P2025'))).toBe(false);
    expect(isSerializationError(new Error('The user does not have sufficient balance.'))).toBe(
      false,
    );
    expect(isSerializationError(null)).toBe(false);
    expect(isSerializationError('40001')).toBe(false);
  });
});

describe('withSerializationRetry', () => {
  it('does not retry a call that succeeds', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(withSerializationRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a write conflict and returns the eventual result', async () => {
    const { delays, sleep } = recorder();
    const fn = jest
      .fn<Promise<string>, [number]>()
      .mockRejectedValueOnce(new FakePrismaError('P2034'))
      .mockRejectedValueOnce(new FakePrismaError('P2034'))
      .mockResolvedValue('committed');

    await expect(withSerializationRetry(fn, { sleep, random: () => 0 })).resolves.toBe('committed');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toHaveLength(2);
  });

  it('passes the 1-based attempt number to the callback', async () => {
    const { sleep } = recorder();
    const seen: number[] = [];

    await withSerializationRetry(
      (attempt) => {
        seen.push(attempt);
        return attempt < 3 ? Promise.reject(new FakePrismaError('P2034')) : Promise.resolve('done');
      },
      { sleep, random: () => 0 },
    );

    expect(seen).toEqual([1, 2, 3]);
  });

  it('gives up after `attempts` tries and rethrows the ORIGINAL error', async () => {
    const { delays, sleep } = recorder();
    const conflict = new FakePrismaError('P2034');
    const fn = jest.fn().mockRejectedValue(conflict);

    await expect(withSerializationRetry(fn, { attempts: 3, sleep })).rejects.toBe(conflict);
    expect(fn).toHaveBeenCalledTimes(3);
    // Three attempts means two sleeps — never one after the final failure.
    expect(delays).toHaveLength(2);
  });

  it('defaults to 5 attempts', async () => {
    const { sleep } = recorder();
    const fn = jest.fn().mockRejectedValue(new FakePrismaError('P2034'));

    await expect(withSerializationRetry(fn, { sleep })).rejects.toBeInstanceOf(FakePrismaError);
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('accepts the documented shorthand withSerializationRetry(fn, attempts)', async () => {
    const fn = jest.fn().mockRejectedValue(new FakePrismaError('P2034'));

    await expect(withSerializationRetry(fn, 2)).rejects.toBeInstanceOf(FakePrismaError);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('never retries a non-conflict error', async () => {
    const unique = new FakePrismaError('P2002');
    const fn = jest.fn().mockRejectedValue(unique);

    await expect(withSerializationRetry(fn, { attempts: 5 })).rejects.toBe(unique);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially, capped, and jittered', async () => {
    const { delays, sleep } = recorder();
    const fn = jest.fn().mockRejectedValue(new FakePrismaError('P2034'));

    // random() === 1 -> the whole jittered window, i.e. the full exponential value.
    await expect(
      withSerializationRetry(fn, {
        attempts: 6,
        baseDelayMs: 10,
        maxDelayMs: 40,
        sleep,
        random: () => 1,
      }),
    ).rejects.toBeInstanceOf(FakePrismaError);

    expect(delays).toEqual([10, 20, 40, 40, 40]);
  });

  it('halves the delay when random() === 0, so two losers never re-collide in lockstep', async () => {
    const { delays, sleep } = recorder();
    const fn = jest.fn().mockRejectedValue(new FakePrismaError('P2034'));

    await expect(
      withSerializationRetry(fn, {
        attempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 1_000,
        sleep,
        random: () => 0,
      }),
    ).rejects.toBeInstanceOf(FakePrismaError);

    expect(delays).toEqual([50, 100]);
  });

  it('reports every retry to onRetry', async () => {
    const { sleep } = recorder();
    const onRetry = jest.fn();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new FakePrismaError('P2034'))
      .mockResolvedValue('ok');

    await withSerializationRetry(fn, { sleep, onRetry, random: () => 0 });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, delayMs: expect.any(Number) }),
    );
  });

  it('refuses a nonsensical attempt budget', async () => {
    await expect(withSerializationRetry(() => Promise.resolve(1), 0)).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});
