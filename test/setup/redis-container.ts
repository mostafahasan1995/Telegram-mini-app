/**
 * Redis 7 for the integration suite. One per Jest worker, same reasoning as postgres-container.ts.
 *
 * WHY a real Redis rather than a mock: the things this project puts in Redis are the things a mock
 * gets wrong. `SET NX PX` is what makes the Ichancy session single-flight; the per-player credit
 * mutex is what makes BALANCE_DELTA verification meaningful; the throttler counter is a Lua script.
 * A mock that returns "OK" to all of them tests nothing about any of those guarantees.
 *
 * `REDIS_TEST_URL` short-circuits the container for anyone who already has a Redis handy — the
 * suite is noticeably faster against a local one, and a developer who sets it knows what they are
 * doing. Everyone else, and CI, gets a container.
 */
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

export interface RedisHandle {
  url: string;
  container: StartedTestContainer | null;
  stop: () => Promise<void>;
  /** Wipes every key. Cheap, and the only correct reset for a shared in-memory store. */
  flush: () => Promise<void>;
}

let handle: RedisHandle | null = null;
let starting: Promise<RedisHandle> | null = null;

async function flushViaClient(url: string): Promise<void> {
  // Imported lazily so a unit test that only pulls in types never constructs an ioredis client.
  const { Redis } = await import('ioredis');
  const client = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: true });
  try {
    await client.connect();
    // FLUSHDB, not FLUSHALL: it clears only the database the URL selected. With REDIS_TEST_URL
    // pointing at a shared dev Redis (`redis://host:6379/9`), FLUSHALL would wipe every other
    // database on that server too — someone else's session store, mid-debug.
    await client.flushdb();
  } finally {
    client.disconnect();
  }
}

export async function startRedis(): Promise<RedisHandle> {
  if (handle !== null) return handle;
  if (starting !== null) return starting;

  starting = (async (): Promise<RedisHandle> => {
    const external = process.env.REDIS_TEST_URL;

    if (external !== undefined && external.trim().length > 0) {
      const started: RedisHandle = {
        url: external.trim(),
        container: null,
        flush: () => flushViaClient(external.trim()),
        stop: async (): Promise<void> => {
          handle = null;
          starting = null;
          // Not ours to stop, but leaving a developer's Redis full of test keys is rude.
          await flushViaClient(external.trim());
        },
      };
      handle = started;
      return started;
    }

    const container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;

    const started: RedisHandle = {
      url,
      container,
      flush: () => flushViaClient(url),
      stop: async (): Promise<void> => {
        handle = null;
        starting = null;
        await container.stop();
      },
    };

    handle = started;
    return started;
  })();

  return starting;
}

export function currentRedis(): RedisHandle | null {
  return handle;
}

export async function stopRedis(): Promise<void> {
  if (handle !== null) await handle.stop();
}
