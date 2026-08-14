import type { PaymentDestination } from '@prisma/client';

import type { RedisService } from '@core/cache/redis.service';
import { BusinessRuleError } from '@common/exceptions/app.exception';

import { DestinationPickerService } from './destination-picker.service';
import type { PaymentDestinationRepository } from '../repositories/payment-destination.repository';

const METHOD = 'method-1';

function destination(
  id: string,
  priority: number,
  dailyCapMinor: bigint | null = null,
): PaymentDestination {
  return {
    id,
    paymentMethodId: METHOD,
    label: `Destination ${id}`,
    accountIdentifier: `acct-${id}`,
    accountHolder: null,
    isActive: true,
    priority,
    dailyCapMinor,
    notes: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

/**
 * Minimal in-memory stand-in for the bits of ioredis the picker touches.
 * The individual jest.Mocks are returned alongside the object so tests never reference
 * `redis.incr` as an unbound method.
 */
function fakeRedis() {
  const store = new Map<string, string>();
  const counters = new Map<string, number>();

  const get = jest.fn((key: string) => Promise.resolve(store.get(key) ?? null));
  const set = jest.fn((key: string, value: string, ..._rest: unknown[]) => {
    // The picker always calls SET with NX; honour it, since that is the behaviour under test.
    if (store.has(key)) return Promise.resolve(null);
    store.set(key, value);
    return Promise.resolve('OK');
  });
  const del = jest.fn((key: string) => {
    store.delete(key);
    return Promise.resolve(1);
  });
  const incr = jest.fn((key: string) => {
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return Promise.resolve(next);
  });
  const expire = jest.fn(() => Promise.resolve(1));

  const redis = { get, set, del, incr, expire } as unknown as RedisService;
  return { redis, store, get, set, del, incr, expire };
}

function harness(destinations: PaymentDestination[], volumes: Map<string, bigint> = new Map()) {
  const listForMethod = jest.fn().mockResolvedValue(destinations);
  const volumeSince = jest.fn().mockResolvedValue(volumes);
  const repo = { listForMethod, volumeSince } as unknown as PaymentDestinationRepository;
  const redisHarness = fakeRedis();

  return {
    service: new DestinationPickerService(repo, redisHarness.redis),
    listForMethod,
    volumeSince,
    ...redisHarness,
  };
}

describe('DestinationPickerService', () => {
  describe('stickiness', () => {
    it('gives the same player the same destination on repeat calls', async () => {
      const { service } = harness([destination('a', 0), destination('b', 0)]);

      const first = await service.pickFor(METHOD, 'player-1');
      for (let i = 0; i < 10; i += 1) {
        const again = await service.pickFor(METHOD, 'player-1');
        expect(again.id).toBe(first.id);
      }
    });

    it('does not advance the rotation while a player is sticky', async () => {
      const { service, incr } = harness([destination('a', 0), destination('b', 0)]);

      await service.pickFor(METHOD, 'player-1');
      await service.pickFor(METHOD, 'player-1');
      await service.pickFor(METHOD, 'player-1');

      // One rotation step for the first pick; the rest were served from the sticky key.
      expect(incr).toHaveBeenCalledTimes(1);
    });

    it('re-picks when the remembered destination has since been deactivated', async () => {
      const active = destination('b', 0);
      const { service, store } = harness([active]);

      // A sticky key written yesterday, pointing at a destination retired since.
      store.set(`paydest:sticky:${METHOD}:player-1`, 'retired-destination');

      const picked = await service.pickFor(METHOD, 'player-1');
      expect(picked.id).toBe('b');
    });

    it('adopts the winner when two concurrent picks race', async () => {
      const { service, store } = harness([destination('a', 0), destination('b', 5)]);

      // Simulate the other request winning the SET NX a moment earlier.
      store.set(`paydest:sticky:${METHOD}:player-1`, 'b');

      const picked = await service.pickFor(METHOD, 'player-1');
      expect(picked.id).toBe('b');
    });

    it('clearSticky forgets the assignment', async () => {
      const { service, store } = harness([destination('a', 0)]);
      await service.pickFor(METHOD, 'player-1');
      expect(store.size).toBe(1);

      await service.clearSticky(METHOD, 'player-1');
      expect(store.size).toBe(0);
    });
  });

  describe('weighted rotation', () => {
    it('splits volume in proportion to weight, exactly', async () => {
      // priorities 0,1,2 -> weights 16,15,14 (MAX_ROTATION_WEIGHT = 16), total 45.
      const { service } = harness([destination('a', 0), destination('b', 1), destination('c', 2)]);

      const counts = new Map<string, number>();
      for (let i = 0; i < 45; i += 1) {
        // A distinct player each time, so stickiness never masks the rotation.
        const picked = await service.pickFor(METHOD, `player-${i}`);
        counts.set(picked.id, (counts.get(picked.id) ?? 0) + 1);
      }

      // A random draw would be "roughly" this; a counter is exactly this, which is the point.
      expect(counts.get('a')).toBe(16);
      expect(counts.get('b')).toBe(15);
      expect(counts.get('c')).toBe(14);
    });

    it('gives every active destination a share, however low its priority', async () => {
      const { service } = harness([destination('a', 0), destination('b', 999)]);

      const seen = new Set<string>();
      for (let i = 0; i < 40; i += 1) {
        seen.add((await service.pickFor(METHOD, `player-${i}`)).id);
      }
      // Exclusion is what isActive is for; a large priority must not silently remove a destination.
      expect(seen).toEqual(new Set(['a', 'b']));
    });

    it('falls back to a single destination without consulting the counter twice', async () => {
      const { service } = harness([destination('only', 3)]);
      const picked = await service.pickFor(METHOD, 'player-1');
      expect(picked.id).toBe('only');
    });
  });

  describe('soft daily caps', () => {
    it('skips a destination that is over its cap', async () => {
      const volumes = new Map([['a', 1_000_000n]]);
      const { service } = harness([destination('a', 0, 500_000n), destination('b', 0)], volumes);

      for (let i = 0; i < 10; i += 1) {
        expect((await service.pickFor(METHOD, `player-${i}`)).id).toBe('b');
      }
    });

    it('keeps a destination that is still under its cap', async () => {
      const volumes = new Map([['a', 100_000n]]);
      const { service } = harness([destination('a', 0, 500_000n)], volumes);
      expect((await service.pickFor(METHOD, 'player-1')).id).toBe('a');
    });

    it('IGNORES the caps when every destination is over — a soft cap is not a wall', async () => {
      const volumes = new Map([
        ['a', 1_000_000n],
        ['b', 1_000_000n],
      ]);
      const { service } = harness(
        [destination('a', 0, 500_000n), destination('b', 0, 500_000n)],
        volumes,
      );

      // A player with nowhere to pay is strictly worse than a slightly overloaded account.
      const picked = await service.pickFor(METHOD, 'player-1');
      expect(['a', 'b']).toContain(picked.id);
    });

    it('does not query volumes at all when no destination is capped', async () => {
      const { service, volumeSince } = harness([destination('a', 0), destination('b', 1)]);
      await service.pickFor(METHOD, 'player-1');
      expect(volumeSince).not.toHaveBeenCalled();
    });

    it('ignores caps rather than failing when the volume query errors', async () => {
      const { service, volumeSince } = harness([destination('a', 0, 1n)]);
      volumeSince.mockRejectedValue(new Error('database down'));

      // The cap is advisory; failing to measure it must not fail the deposit.
      await expect(service.pickFor(METHOD, 'player-1')).resolves.toMatchObject({ id: 'a' });
    });
  });

  describe('failure modes', () => {
    it('throws a business error when the method has no active destination', async () => {
      const { service } = harness([]);
      await expect(service.pickFor(METHOD, 'player-1')).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('still picks when Redis is unavailable', async () => {
      const { service, get, incr, set } = harness([destination('a', 0)]);
      get.mockRejectedValue(new Error('redis down'));
      incr.mockRejectedValue(new Error('redis down'));
      set.mockRejectedValue(new Error('redis down'));

      // Losing stickiness is a degradation; refusing the deposit would be an outage.
      await expect(service.pickFor(METHOD, 'player-1')).resolves.toMatchObject({ id: 'a' });
    });
  });
});
