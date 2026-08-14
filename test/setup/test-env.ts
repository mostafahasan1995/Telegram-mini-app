/**
 * A complete, valid environment for tests.
 *
 * `envSchema` refuses to start the process if ANY variable is missing — deliberately, because a
 * cashier that boots half-configured takes deposits it cannot credit. The cost is that a test which
 * builds the Nest graph needs all ~30 of them, so they live here once instead of in every suite.
 *
 * TWO VALUES ARE SAFETY RAILS, NOT CONVENIENCE:
 *   NODE_ENV=test    makes @core/ichancy default to the FAKE adapter and @core/file to LOCAL disk.
 *   ICHANCY_FAKE=1   states it explicitly rather than relying on that default, so a suite that
 *                    overrides NODE_ENV for some other reason still cannot reach the real agent
 *                    API. A test that moves real money is not a test.
 *
 * Everything is applied with `??=` semantics: an explicitly-set variable always wins, so CI can
 * point a suite at a different database without editing this file.
 */
export interface TestEnvOverrides {
  DATABASE_URL?: string;
  REDIS_URL?: string;
  APP_ROLE?: 'api' | 'worker';
  [key: string]: string | undefined;
}

/** Matches the schema's /^\d+:[A-Za-z0-9_-]{20,}$/ without being a real token. */
const FAKE_BOT_TOKEN = '123456789:TEST_ONLY_NOT_A_REAL_BOT_TOKEN_00000';

const DEFAULTS: Record<string, string> = {
  APP_ROLE: 'api',
  NODE_ENV: 'test',
  PORT: '3000',
  API_BASE_URL: 'http://localhost:3000',

  DB_POOL_MAX: '5',

  JWT_SECRET: 'test_jwt_secret_at_least_16_chars_long_0123456789',
  JWT_ACCESS_TTL: '15m',
  REFRESH_TTL_DAYS: '30',

  TELEGRAM_BOT_TOKEN: FAKE_BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: 'test_webhook_secret_0123456789ab',
  TELEGRAM_WEBHOOK_PATH_TOKEN: 'test_webhook_path_token',
  TELEGRAM_ADMIN_CHAT_ID: '-1001234567890',

  MINI_APP_ORIGIN: 'http://localhost:5173',

  ICHANCY_BASE_URL: 'http://ichancy.invalid',
  ICHANCY_USERNAME: 'test_agent',
  ICHANCY_PASSWORD: 'test_agent_password',
  ICHANCY_AGENT_ID: '1234567',
  ICHANCY_CURRENCY: 'NSP',
  ICHANCY_TIMEOUT_MS: '2000',
  ICHANCY_FAKE: '1',

  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'deposit-proofs-test',
  S3_ACCESS_KEY: 'test',
  S3_SECRET_KEY: 'test-secret',
  S3_REGION: 'us-east-1',
  FILE_STORAGE_DRIVER: 'local',

  // 1,000,000.00 NSP — high enough that most fixtures approve with one admin, low enough that a
  // test can cross it on purpose.
  DUAL_APPROVAL_THRESHOLD_MINOR: '100000000',
  DEPOSIT_EXPIRY_MINUTES: '120',
  AGENT_FLOAT_LOW_WATERMARK_MINOR: '50000000',
};

export function applyTestEnv(overrides: TestEnvOverrides = {}): void {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    process.env[key] ??= value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) process.env[key] = value;
  }
}
