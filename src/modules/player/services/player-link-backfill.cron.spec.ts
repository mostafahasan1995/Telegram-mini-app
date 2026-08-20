/**
 * The schedule half. Three properties, each of which has bitten this codebase before:
 * the role guard (an api process that registers players would fail every attempt, because only the
 * worker holds Ichancy's single token pair), the leader lock, and the swallow.
 */
import { type LockService } from '@core/cache/lock.service';
import { type AppConfigService } from '@core/config/config.service';

import { PlayerLinkBackfillCron } from './player-link-backfill.cron';
import { type PlayerLinkBackfillService } from './player-link-backfill.service';

const HANDLE = { key: 'lock:cron:player-link-backfill', token: 't', acquiredAt: 0, ttlMs: 1_000 };

function build(options: { isWorker?: boolean; handle?: typeof HANDLE | null } = {}): {
  cron: PlayerLinkBackfillCron;
  runOnce: jest.Mock;
  acquire: jest.Mock;
  release: jest.Mock;
} {
  const runOnce = jest
    .fn()
    .mockResolvedValue({ scanned: 0, linked: 0, deferred: 0, parked: 0, skipped: null });
  const acquire = jest.fn().mockResolvedValue(options.handle === undefined ? HANDLE : options.handle);
  const release = jest.fn().mockResolvedValue(true);

  const cron = new PlayerLinkBackfillCron(
    { runOnce } as unknown as PlayerLinkBackfillService,
    { acquire, release } as unknown as LockService,
    { app: { isWorker: options.isWorker ?? true } } as unknown as AppConfigService,
  );
  return { cron, runOnce, acquire, release };
}

describe('PlayerLinkBackfillCron', () => {
  it('does nothing in the api role', async () => {
    // @Interval fires wherever ScheduleModule is imported. The module composition is the braces;
    // this guard is the belt, and it matters more than usual here because an api process never
    // signs in to Ichancy — every attempt it made would fail and burn the players' attempt budget.
    const { cron, acquire, runOnce } = build({ isWorker: false });

    await cron.tick();

    expect(acquire).not.toHaveBeenCalled();
    expect(runOnce).not.toHaveBeenCalled();
  });

  it('skips the tick when another replica holds the lock', async () => {
    const { cron, runOnce } = build({ handle: null });

    await cron.tick();

    expect(runOnce).not.toHaveBeenCalled();
  });

  it('releases the lock and swallows the error when the pass throws', async () => {
    // A cron that throws is an unhandled rejection, and a lock left behind stalls every replica for
    // its whole TTL.
    const { cron, runOnce, release } = build();
    runOnce.mockRejectedValue(new Error('database is gone'));

    await expect(cron.tick()).resolves.toBeUndefined();

    expect(release).toHaveBeenCalledWith(HANDLE);
  });

  it('releases the lock on the happy path too', async () => {
    const { cron, release, runOnce } = build();

    await cron.tick();

    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(HANDLE);
  });
});
