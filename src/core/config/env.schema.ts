/**
 * WHY: a cashier that boots with a missing ICHANCY_AGENT_ID or a placeholder JWT_SECRET is worse
 * than one that refuses to start — it will happily take deposits it cannot credit. This is the ONE
 * schema for the whole process: it parses, coerces and range-checks every variable, converts money
 * limits to bigint minor units immediately, and throws a single readable report listing everything
 * that is wrong (not just the first field).
 */
import { z } from 'zod';

/** Integer-as-string -> bigint. Money limits never pass through a JS number, not even at boot. */
const bigintMinor = (label: string) =>
  z
    .string()
    .regex(/^\d+$/, `${label} must be a non-negative integer in MINOR units (no decimal point)`)
    .transform((value) => BigInt(value));

/** Telegram chat/user ids exceed 2^53 in theory and supergroups are negative. */
const telegramId = (label: string) =>
  z
    .string()
    .regex(/^-?\d+$/, `${label} must be an integer Telegram id`)
    .transform((value) => BigInt(value));

const httpUrl = (label: string) =>
  z
    .string()
    .min(1, `${label} is required`)
    .regex(/^https?:\/\/[^\s]+$/i, `${label} must be an http(s) URL`)
    .transform((value) => value.replace(/\/+$/, ''));

const nonEmpty = (label: string) => z.string().trim().min(1, `${label} is required`);

const PLACEHOLDER_RE = /change_me|changeme|your_|xxxx/i;

export const envSchema = z
  .object({
    // ---- APP ----------------------------------------------------------------
    APP_ROLE: z.enum(['api', 'worker']),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    API_BASE_URL: httpUrl('API_BASE_URL'),

    // ---- DATABASE -----------------------------------------------------------
    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must be a postgres:// connection string'),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),

    // ---- REDIS --------------------------------------------------------------
    REDIS_URL: z.string().regex(/^rediss?:\/\//, 'REDIS_URL must be a redis:// connection string'),

    // ---- AUTH ---------------------------------------------------------------
    JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
    JWT_ACCESS_TTL: z
      .string()
      .regex(/^\d+[smhd]$/, 'JWT_ACCESS_TTL must look like 900s / 15m / 1h / 7d')
      .default('15m'),
    REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

    // ---- TELEGRAM -----------------------------------------------------------
    TELEGRAM_BOT_TOKEN: z
      .string()
      .regex(/^\d+:[A-Za-z0-9_-]{20,}$/, 'TELEGRAM_BOT_TOKEN must look like 123456:AA...'),
    TELEGRAM_WEBHOOK_SECRET: z
      .string()
      .min(16, 'TELEGRAM_WEBHOOK_SECRET must be at least 16 characters')
      .regex(
        /^[A-Za-z0-9_-]+$/,
        'TELEGRAM_WEBHOOK_SECRET may only contain A-Z a-z 0-9 _ - (Telegram restriction)',
      ),
    TELEGRAM_WEBHOOK_PATH_TOKEN: z
      .string()
      .min(8, 'TELEGRAM_WEBHOOK_PATH_TOKEN must be at least 8 characters')
      .regex(/^[A-Za-z0-9_-]+$/, 'TELEGRAM_WEBHOOK_PATH_TOKEN must be URL-safe'),
    TELEGRAM_ADMIN_CHAT_ID: telegramId('TELEGRAM_ADMIN_CHAT_ID'),

    /** Comma-separated; every entry must be an origin (scheme + host, no path). */
    MINI_APP_ORIGIN: z
      .string()
      .min(1, 'MINI_APP_ORIGIN is required')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim().replace(/\/+$/, ''))
          .filter((origin) => origin.length > 0),
      )
      .refine((origins) => origins.length > 0, 'MINI_APP_ORIGIN must list at least one origin')
      .refine(
        (origins) => origins.every((origin) => /^https?:\/\/[^/\s]+$/i.test(origin)),
        'Each MINI_APP_ORIGIN entry must be an origin like https://app.example.com (no path)',
      ),

    // ---- ICHANCY ------------------------------------------------------------
    ICHANCY_BASE_URL: httpUrl('ICHANCY_BASE_URL'),
    ICHANCY_USERNAME: nonEmpty('ICHANCY_USERNAME'),
    ICHANCY_PASSWORD: nonEmpty('ICHANCY_PASSWORD'),
    /** affiliateId of our agent; used as parentId when registering players. */
    ICHANCY_AGENT_ID: nonEmpty('ICHANCY_AGENT_ID'),
    ICHANCY_CURRENCY: z
      .string()
      .regex(/^[A-Z]{3}$/, 'ICHANCY_CURRENCY must be a 3-letter uppercase code')
      .default('NSP'),
    ICHANCY_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(8_000),
    /**
     * Route every Ichancy call to the in-memory fake instead of the real agent API.
     *
     * MUST be declared here. This object strips unknown keys, and @nestjs/config only copies the
     * VALIDATED result into process.env — so a flag that is merely present in .env never reaches
     * process.env, and any `process.env.ICHANCY_FAKE` check silently reads undefined. That is how
     * this flag came to be inert while appearing to be set: the safety switch that stops the
     * service touching real money was doing nothing at all.
     * Defaults to true under NODE_ENV=test so a forgotten flag can never move real money in CI.
     */
    ICHANCY_FAKE: z
      .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
      .optional()
      .transform((v) => (v === undefined ? undefined : ['true', '1', 'yes', 'on'].includes(v))),

    // ---- OBJECT STORAGE -----------------------------------------------------
    S3_ENDPOINT: httpUrl('S3_ENDPOINT'),
    S3_BUCKET: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'S3_BUCKET must be a valid bucket name'),
    S3_ACCESS_KEY: nonEmpty('S3_ACCESS_KEY'),
    S3_SECRET_KEY: nonEmpty('S3_SECRET_KEY'),
    S3_REGION: nonEmpty('S3_REGION').default('us-east-1'),

    // ---- LIMITS -------------------------------------------------------------
    DUAL_APPROVAL_THRESHOLD_MINOR: bigintMinor('DUAL_APPROVAL_THRESHOLD_MINOR'),
    DEPOSIT_EXPIRY_MINUTES: z.coerce.number().int().min(5).max(10_080),
    AGENT_FLOAT_LOW_WATERMARK_MINOR: bigintMinor('AGENT_FLOAT_LOW_WATERMARK_MINOR'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;

    const secrets: Array<[keyof typeof env, string, number]> = [
      ['JWT_SECRET', env.JWT_SECRET, 32],
      ['TELEGRAM_WEBHOOK_SECRET', env.TELEGRAM_WEBHOOK_SECRET, 32],
      ['TELEGRAM_WEBHOOK_PATH_TOKEN', env.TELEGRAM_WEBHOOK_PATH_TOKEN, 16],
      ['ICHANCY_PASSWORD', env.ICHANCY_PASSWORD, 8],
      ['S3_SECRET_KEY', env.S3_SECRET_KEY, 8],
    ];

    for (const [key, value, minLength] of secrets) {
      if (value.length < minLength) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} must be at least ${minLength} characters in production`,
        });
      }
      if (PLACEHOLDER_RE.test(value)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} still contains a placeholder value from .env.example`,
        });
      }
    }

    if (env.MINI_APP_ORIGIN.some((origin) => origin.startsWith('http://'))) {
      ctx.addIssue({
        code: 'custom',
        path: ['MINI_APP_ORIGIN'],
        message: 'MINI_APP_ORIGIN must use https in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Parses process.env (or any record) and throws ONE error listing every problem.
 * Used both as @nestjs/config's `validate` hook and as the factory for the typed config service, so
 * the process cannot come up half-configured.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const problems = parsed.error.issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  - ${field}: ${issue.message}`;
    })
    .sort();

  throw new Error(
    [
      'Invalid environment configuration — refusing to start:',
      ...problems,
      '',
      'Fix the variables above (see .env.example for the full, commented list).',
    ].join('\n'),
  );
}
