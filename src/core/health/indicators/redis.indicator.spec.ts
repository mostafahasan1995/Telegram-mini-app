import { Logger } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import type { RedisService } from '../../cache/redis.service';
import { REDIS_DOWN_MESSAGE, RedisHealthIndicator } from './redis.indicator';

function build(ping: jest.Mock): RedisHealthIndicator {
  const redis = { ping } as unknown as RedisService;
  return new RedisHealthIndicator(redis, new HealthIndicatorService());
}

describe('RedisHealthIndicator', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('reports up on PONG', async () => {
    const result = await build(jest.fn().mockResolvedValue('PONG')).isHealthy();

    expect(result.redis?.status).toBe('up');
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports down with a fixed message and logs the real error', async () => {
    const raw = 'NOAUTH Authentication required. connect ECONNREFUSED redis:6379';
    const result = await build(jest.fn().mockRejectedValue(new Error(raw))).isHealthy();

    expect(result.redis?.status).toBe('down');
    expect(result.redis?.message).toBe(REDIS_DOWN_MESSAGE);
    expect(JSON.stringify(result)).not.toContain('NOAUTH');
    expect(JSON.stringify(result)).not.toContain('6379');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(raw);
  });

  it('treats an unexpected PING reply as down without echoing it', async () => {
    const result = await build(jest.fn().mockResolvedValue('LOADING')).isHealthy();

    expect(result.redis?.status).toBe('down');
    expect(result.redis?.message).toBe(REDIS_DOWN_MESSAGE);
    expect(JSON.stringify(result)).not.toContain('LOADING');
    expect(warn.mock.calls[0]?.[0]).toContain('Unexpected PING reply: LOADING');
  });
});
