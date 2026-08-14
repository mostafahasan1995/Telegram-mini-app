import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildPoolConfig,
  PoolConfigError,
  PoolConfigErrorCodes,
  redactDatabaseUrl,
} from './pool-config.util';

const BASE = 'postgresql://ichancy_app:s3cret@db.internal:5433/ichancy?schema=public';

describe('buildPoolConfig', () => {
  it('splits the URL into pg credentials + a schema the adapter must be told about', () => {
    const { pool, schema } = buildPoolConfig(BASE);

    expect(pool.user).toBe('ichancy_app');
    expect(pool.password).toBe('s3cret');
    expect(pool.host).toBe('db.internal');
    expect(pool.port).toBe(5433);
    expect(pool.database).toBe('ichancy');
    expect(schema).toBe('public');
  });

  it('defaults host/port/schema the way libpq does', () => {
    const { pool, schema } = buildPoolConfig('postgresql://ichancy/ichancy');

    expect(pool.host).toBe('ichancy');
    expect(pool.port).toBe(5432);
    expect(schema).toBe('public');
  });

  it('percent-decodes credentials so a password with @ or / survives', () => {
    const { pool } = buildPoolConfig('postgresql://a%40b:p%2Fss%40word@localhost:5432/ichancy');

    expect(pool.user).toBe('a@b');
    expect(pool.password).toBe('p/ss@word');
  });

  it('honours ?connection_limit= — Prisma ignores it once a driver adapter is used', () => {
    const { pool } = buildPoolConfig(`${BASE}&connection_limit=42`);
    expect(pool.max).toBe(42);
  });

  it('lets DB_POOL_MAX (options.max) win over the URL', () => {
    const { pool } = buildPoolConfig(`${BASE}&connection_limit=42`, { max: 7 });
    expect(pool.max).toBe(7);
  });

  it('falls back to a bounded default pool instead of pg’s implicit one', () => {
    const { pool } = buildPoolConfig(BASE);
    expect(pool.max).toBe(10);
    expect(pool.idleTimeoutMillis).toBe(30_000);
    expect(pool.connectionTimeoutMillis).toBe(10_000);
    expect(pool.keepAlive).toBe(true);
  });

  it('converts connect_timeout seconds into connectionTimeoutMillis', () => {
    const { pool } = buildPoolConfig(`${BASE}&connect_timeout=3`);
    expect(pool.connectionTimeoutMillis).toBe(3_000);
  });

  it('reads a non-public schema', () => {
    const { schema } = buildPoolConfig('postgresql://u:p@h:5432/db?schema=cashier');
    expect(schema).toBe('cashier');
  });

  it('supports unix sockets via ?host=', () => {
    const { pool } = buildPoolConfig('postgresql:///ichancy?host=/var/run/postgresql');

    expect(pool.host).toBe('/var/run/postgresql');
    expect(pool.port).toBeUndefined();
  });

  it('sets application_name so pg_stat_activity can tell api from worker', () => {
    const { pool } = buildPoolConfig(BASE, { applicationName: 'ichancy-worker' });
    expect(pool.application_name).toBe('ichancy-worker');
  });

  describe('ssl', () => {
    it('is off when sslmode is absent or disabled', () => {
      expect(buildPoolConfig(BASE).pool.ssl).toBe(false);
      expect(buildPoolConfig(`${BASE}&sslmode=disable`).pool.ssl).toBe(false);
    });

    it('maps require/prefer to unverified TLS, like libpq', () => {
      expect(buildPoolConfig(`${BASE}&sslmode=require`).pool.ssl).toEqual({
        rejectUnauthorized: false,
      });
      expect(buildPoolConfig(`${BASE}&sslmode=prefer`).pool.ssl).toEqual({
        rejectUnauthorized: false,
      });
    });

    it('maps verify-full to a verified chain pinned to the hostname', () => {
      expect(buildPoolConfig(`${BASE}&sslmode=verify-full`).pool.ssl).toEqual({
        rejectUnauthorized: true,
        servername: 'db.internal',
      });
    });

    it('loads sslrootcert from disk', () => {
      const dir = mkdtempSync(join(tmpdir(), 'pool-config-'));
      const caPath = join(dir, 'ca.pem');
      writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n');

      try {
        const { pool } = buildPoolConfig(
          `${BASE}&sslmode=verify-ca&sslrootcert=${encodeURIComponent(caPath)}`,
        );
        expect(pool.ssl).toEqual({
          rejectUnauthorized: true,
          ca: expect.stringContaining('BEGIN CERTIFICATE'),
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('fails loudly when sslrootcert points nowhere', () => {
      let thrown: unknown;
      try {
        buildPoolConfig(`${BASE}&sslmode=verify-ca&sslrootcert=/definitely/not/here.pem`);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(PoolConfigError);
      expect((thrown as PoolConfigError).code).toBe(PoolConfigErrorCodes.SSL_ROOT_CERT_UNREADABLE);
    });

    it('rejects an sslmode it cannot honour instead of guessing', () => {
      expect(() => buildPoolConfig(`${BASE}&sslmode=banana`)).toThrow(PoolConfigError);
    });
  });

  describe('rejections', () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['not a url', 'nonsense', PoolConfigErrorCodes.INVALID_URL],
      ['a mysql url', 'mysql://u:p@h:3306/db', PoolConfigErrorCodes.UNSUPPORTED_PROTOCOL],
      ['no database', 'postgresql://u:p@h:5432/', PoolConfigErrorCodes.MISSING_DATABASE],
      ['an out-of-range port', 'postgresql://u:p@h:99999/db', PoolConfigErrorCodes.INVALID_URL],
      [
        'a bad connection_limit',
        'postgresql://u:p@h:5432/db?connection_limit=zero',
        PoolConfigErrorCodes.INVALID_NUMERIC_PARAM,
      ],
      [
        'a negative connection_limit',
        'postgresql://u:p@h:5432/db?connection_limit=-1',
        PoolConfigErrorCodes.INVALID_NUMERIC_PARAM,
      ],
    ];

    it.each(cases)('refuses %s with a stable code', (_label, url, code) => {
      let thrown: unknown;
      try {
        buildPoolConfig(url);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(PoolConfigError);
      expect((thrown as PoolConfigError).code).toBe(code);
    });
  });
});

describe('redactDatabaseUrl', () => {
  it('never lets a password reach a log line', () => {
    expect(redactDatabaseUrl(BASE)).toContain('***');
    expect(redactDatabaseUrl(BASE)).not.toContain('s3cret');
  });

  it('degrades to *** rather than echoing junk', () => {
    expect(redactDatabaseUrl('nonsense')).toBe('***');
  });

  it('leaves a password-less URL usable', () => {
    expect(redactDatabaseUrl('postgresql://ichancy@localhost:5432/ichancy')).toBe(
      'postgresql://ichancy@localhost:5432/ichancy',
    );
  });
});
