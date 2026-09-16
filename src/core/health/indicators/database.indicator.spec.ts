import { Logger } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import type { PrismaService } from '../../prisma/prisma.service';
import { DATABASE_DOWN_MESSAGE, DatabaseHealthIndicator } from './database.indicator';

const RAW_ERROR =
  'Authentication failed against database server at `postgres`, the provided database credentials for `ichancy_app` are not valid';

function build(queryRaw: jest.Mock): DatabaseHealthIndicator {
  const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
  return new DatabaseHealthIndicator(prisma, new HealthIndicatorService());
}

describe('DatabaseHealthIndicator', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    jest.useRealTimers();
  });

  it('reports up when SELECT 1 answers', async () => {
    const result = await build(jest.fn().mockResolvedValue([{ '?column?': 1 }])).isHealthy();

    expect(result.database?.status).toBe('up');
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports down with a fixed message and logs the real error', async () => {
    const result = await build(jest.fn().mockRejectedValue(new Error(RAW_ERROR))).isHealthy();

    // `down` is what makes Terminus answer 503, which Docker and deploy.sh gate on.
    expect(result.database?.status).toBe('down');
    expect(result.database?.message).toBe(DATABASE_DOWN_MESSAGE);
    expect(JSON.stringify(result)).not.toContain('ichancy_app');
    expect(JSON.stringify(result)).not.toContain('postgres');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(RAW_ERROR);
  });

  it('reports down with the same fixed message when the pool does not answer in time', async () => {
    jest.useFakeTimers();
    const pending = build(jest.fn().mockReturnValue(new Promise(() => undefined))).isHealthy();

    await jest.advanceTimersByTimeAsync(2_000);
    const result = await pending;

    expect(result.database?.status).toBe('down');
    expect(result.database?.message).toBe(DATABASE_DOWN_MESSAGE);
    expect(warn.mock.calls[0]?.[0]).toContain('did not respond within 2000ms');
  });
});
