/**
 * WHY this file exists: with `@prisma/adapter-pg` the connection is owned by a `pg.Pool` we create
 * ourselves, and Prisma NO LONGER READS the query parameters of DATABASE_URL. `?connection_limit=`,
 * `?connect_timeout=`, `?sslmode=`, `?schema=` — all of them are inert unless somebody translates
 * them into a `pg.PoolConfig`. That somebody is this file.
 *
 * Consequences if this is skipped: the pool silently defaults to `max: 10` regardless of
 * DB_POOL_MAX, TLS is silently off against a managed database, and every query lands in the
 * `public` schema even when the URL says otherwise. All three are invisible until production.
 *
 * This module is deliberately pure (one `readFileSync` for a CA bundle aside) so it can be unit
 * tested without a database.
 */
import { readFileSync } from 'node:fs';

import type { PoolConfig } from 'pg';
import type { ConnectionOptions } from 'node:tls';

/** Stable, non-translated codes — callers switch on these, never on the message. */
export const PoolConfigErrorCodes = {
  INVALID_URL: 'INVALID_URL',
  UNSUPPORTED_PROTOCOL: 'UNSUPPORTED_PROTOCOL',
  MISSING_DATABASE: 'MISSING_DATABASE',
  INVALID_NUMERIC_PARAM: 'INVALID_NUMERIC_PARAM',
  UNSUPPORTED_SSL_MODE: 'UNSUPPORTED_SSL_MODE',
  SSL_ROOT_CERT_UNREADABLE: 'SSL_ROOT_CERT_UNREADABLE',
} as const;

export type PoolConfigErrorCode = (typeof PoolConfigErrorCodes)[keyof typeof PoolConfigErrorCodes];

export class PoolConfigError extends Error {
  constructor(
    readonly code: PoolConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PoolConfigError';
  }
}

export interface BuildPoolConfigOptions {
  /** Wins over `connection_limit` in the URL. This is where DB_POOL_MAX arrives. */
  max?: number;
  /** Shows up in pg_stat_activity — worth having when two roles share one database. */
  applicationName?: string;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  /** Guards against a runaway query pinning a pooled connection forever. 0/undefined disables. */
  statementTimeoutMillis?: number;
  /** PEM contents of a CA bundle; wins over `sslrootcert` in the URL. */
  sslCa?: string;
}

export interface ParsedDatabaseUrl {
  /** Ready to hand to `new Pool(...)`. */
  pool: PoolConfig;
  /**
   * The schema from `?schema=`, defaulted to `public`. Prisma ignores it with a driver adapter, so
   * it has to be passed explicitly as `new PrismaPg(pool, { schema })`.
   */
  schema: string;
  /** Same URL with the password replaced — the only form allowed to reach a log line. */
  redactedUrl: string;
}

const DEFAULT_MAX = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_SCHEMA = 'public';

const SUPPORTED_PROTOCOLS = new Set(['postgres:', 'postgresql:']);

/**
 * libpq's sslmode, mapped onto what node-postgres can actually express.
 * `prefer` cannot be honoured literally (node-postgres has no "try TLS, fall back to plaintext"),
 * so it is treated as an unverified TLS request — the safer of the two possible mistakes.
 */
function resolveSsl(
  mode: string | null,
  rootCert: string | null,
  host: string,
  sslCaOverride?: string,
): boolean | ConnectionOptions {
  const normalized = (mode ?? 'disable').toLowerCase();

  if (normalized === 'disable' || normalized === 'false' || normalized === '0') return false;

  const ca = sslCaOverride ?? readCaBundle(rootCert);

  switch (normalized) {
    case 'allow':
    case 'prefer':
    case 'require':
    case 'no-verify':
    case 'true':
    case '1':
      // libpq's `require` explicitly does NOT verify the chain; matching that is intentional.
      return ca ? { rejectUnauthorized: false, ca } : { rejectUnauthorized: false };
    case 'verify-ca':
      return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
    case 'verify-full':
      return ca
        ? { rejectUnauthorized: true, ca, servername: host }
        : { rejectUnauthorized: true, servername: host };
    default:
      throw new PoolConfigError(
        PoolConfigErrorCodes.UNSUPPORTED_SSL_MODE,
        `Unsupported sslmode "${mode ?? ''}" in DATABASE_URL`,
      );
  }
}

function readCaBundle(path: string | null): string | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new PoolConfigError(
      PoolConfigErrorCodes.SSL_ROOT_CERT_UNREADABLE,
      `Cannot read sslrootcert "${path}": ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

function positiveIntParam(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new PoolConfigError(
      PoolConfigErrorCodes.INVALID_NUMERIC_PARAM,
      `DATABASE_URL parameter "${name}" must be a positive integer, got "${raw}"`,
    );
  }
  return value;
}

/** Parses DATABASE_URL into everything the pg Pool + the Prisma adapter need. Never logs. */
export function buildPoolConfig(
  databaseUrl: string,
  options: BuildPoolConfigOptions = {},
): ParsedDatabaseUrl {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new PoolConfigError(PoolConfigErrorCodes.INVALID_URL, 'DATABASE_URL is not a valid URL');
  }

  if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
    throw new PoolConfigError(
      PoolConfigErrorCodes.UNSUPPORTED_PROTOCOL,
      `DATABASE_URL must use postgres:// or postgresql://, got "${url.protocol}"`,
    );
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (database === '') {
    throw new PoolConfigError(
      PoolConfigErrorCodes.MISSING_DATABASE,
      'DATABASE_URL does not name a database',
    );
  }

  const params = url.searchParams;

  // `?host=/var/run/postgresql` is how a unix socket is expressed; the URL host is then empty.
  const socketHost = params.get('host');
  const host = socketHost ?? (url.hostname === '' ? 'localhost' : decodeURIComponent(url.hostname));

  // No range check needed: `new URL` already refuses a port outside 1..65535 (INVALID_URL above).
  // A unix socket has no port at all, so it stays undefined rather than defaulting to 5432.
  const port = url.port !== '' ? Number(url.port) : socketHost === null ? 5432 : undefined;

  const connectionLimit = positiveIntParam(params, 'connection_limit');
  const connectTimeoutSeconds = positiveIntParam(params, 'connect_timeout');
  const poolTimeoutSeconds = positiveIntParam(params, 'pool_timeout');
  const socketTimeoutSeconds = positiveIntParam(params, 'socket_timeout');

  const ssl = resolveSsl(params.get('sslmode'), params.get('sslrootcert'), host, options.sslCa);

  const pool: PoolConfig = {
    host,
    database,
    max: options.max ?? connectionLimit ?? DEFAULT_MAX,
    idleTimeoutMillis: options.idleTimeoutMillis ?? DEFAULT_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis:
      options.connectionTimeoutMillis ??
      (connectTimeoutSeconds !== undefined
        ? connectTimeoutSeconds * 1_000
        : poolTimeoutSeconds !== undefined
          ? poolTimeoutSeconds * 1_000
          : DEFAULT_CONNECTION_TIMEOUT_MS),
    // WHY: without keepalive, a NAT/idle-timeout in front of a managed database silently kills
    // pooled sockets and the first query after a quiet period fails instead of reconnecting.
    keepAlive: true,
    ssl,
  };

  if (port !== undefined) pool.port = port;
  if (url.username !== '') pool.user = decodeURIComponent(url.username);
  if (url.password !== '') pool.password = decodeURIComponent(url.password);

  const applicationName = options.applicationName ?? params.get('application_name') ?? undefined;
  if (applicationName !== undefined && applicationName !== '') {
    pool.application_name = applicationName;
  }

  const statementTimeout = options.statementTimeoutMillis ?? socketTimeoutSeconds;
  if (statementTimeout !== undefined && statementTimeout > 0) {
    pool.statement_timeout = statementTimeout;
  }

  return {
    pool,
    schema: params.get('schema') ?? DEFAULT_SCHEMA,
    redactedUrl: redactDatabaseUrl(databaseUrl),
  };
}

/**
 * WHY: a connection string in a log line is a leaked credential. Every place that wants to say
 * "connected to X" goes through this.
 */
export function redactDatabaseUrl(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    if (url.password !== '') url.password = '***';
    return url.toString();
  } catch {
    return '***';
  }
}
