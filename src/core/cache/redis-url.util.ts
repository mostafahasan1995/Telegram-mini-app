/**
 * WHY this exists: ioredis happily takes a `redis://` URL, but BullMQ's `connection` option is
 * typed as ioredis *options*, not a URL. Retyping host/port/password as separate env vars just for
 * the queue would give us two sources of truth for one Redis, and they would drift the first time
 * someone rotates a password.
 *
 * `maxRetriesPerRequest: null` is REQUIRED by BullMQ, not a preference: with ioredis' default of
 * 20, blocking commands used by workers (BZPOPMIN) reject during any failover and BullMQ throws
 * on startup with an explicit error telling you to set exactly this.
 */
import { type RedisOptions } from 'ioredis';

export function redisUrlToOptions(url: string): RedisOptions {
  const parsed = new URL(url);

  const options: RedisOptions = {
    host: parsed.hostname,
    port: parsed.port.length > 0 ? Number(parsed.port) : 6379,
    maxRetriesPerRequest: null,
  };

  // URL credentials are percent-encoded; a password containing '@' or '/' arrives escaped.
  if (parsed.username.length > 0) options.username = decodeURIComponent(parsed.username);
  if (parsed.password.length > 0) options.password = decodeURIComponent(parsed.password);

  // `redis://host:6379/3` selects database 3.
  const database = parsed.pathname.replace(/^\//, '');
  if (database.length > 0 && /^\d+$/.test(database)) options.db = Number(database);

  // `rediss://` means TLS. Without this the connection is attempted in plaintext and hangs.
  if (parsed.protocol === 'rediss:') options.tls = {};

  return options;
}
