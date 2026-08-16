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

/**
 * Same validation as telegramId(), but "absent" and "present but blank" both mean *no such chat*.
 *
 * WHY blank counts as absent: an operator turning an optional group off does it by emptying the
 * line in .env, not by deleting it. Refusing to boot over `TELEGRAM_FEED_CHAT_ID=` would punish the
 * exact gesture that disables the feature.
 */
const optionalTelegramId = (label: string) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    telegramId(label).optional(),
  );

/**
 * The boolean spellings an operator may reasonably type in .env. Blank counts as unset, for the
 * same reason as above. Mirrors the ICHANCY_FAKE pattern below, which is deliberately left inline:
 * it is the switch that stops real money moving and is not worth refactoring for four shared lines.
 */
const optionalFlag = () =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
      .optional()
      .transform((v) => (v === undefined ? undefined : ['true', '1', 'yes', 'on'].includes(v))),
  );

/**
 * A whole number of hours where 0 is a REAL value meaning "off", and blank means the same thing —
 * emptying the line is how an operator disables a feature in this file (see optionalTelegramId).
 *
 * The asymmetry that follows is deliberate and is the whole point of this helper: an ABSENT variable
 * falls through to the caller's `.default()` ("nobody has said anything, use the documented
 * cadence"), while an EMPTY one is somebody saying "none". A single `.optional()` could not tell
 * those two apart, and picking either meaning for both would make one of the two gestures a lie.
 */
const optionalHours = (label: string, maxHours: number) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? 0 : value),
    z.coerce
      .number()
      .int(`${label} must be a whole number of hours`)
      .min(0, `${label} must be 0 (off) or a positive number of hours`)
      .max(maxHours, `${label} must not exceed ${maxHours} hours`),
  );

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

    /**
     * OPTIONAL second group that also receives the credited-deposit card — the "feed".
     *
     * SAFETY: this group may contain CUSTOMERS, so what goes there is the MASKED card
     * (renderOpsCardPublic): no cashier float, identifiers reduced to their last characters. Unset
     * (or blank) = the feature is off and nothing is ever posted anywhere but the admin group.
     *
     * Like TELEGRAM_ADMIN_CHAT_ID this TRANSFORMS to bigint, so it is absent from process.env after
     * @nestjs/config copies the validated result back — read it through AppConfigService only. See
     * config.module.ts for the full story.
     */
    TELEGRAM_FEED_CHAT_ID: optionalTelegramId('TELEGRAM_FEED_CHAT_ID'),

    /**
     * Opt-in to posting the FULL admin card (cashier float, Telegram id, Ichancy login and player
     * id) to the feed group. Defaults to FALSE — masked — because the default has to be the safe
     * one: a mistyped feed chat id then leaks nothing, and turning this on is a deliberate
     * statement that the feed group contains only staff.
     */
    TELEGRAM_FEED_FULL_DETAIL: optionalFlag(),

    /**
     * How often the worker posts the activity report by itself. Whole hours, 1..168 (a week).
     *
     * DEFAULT 6 when the line is ABSENT — the schedule is opt-out, because a cashier group that has
     * to remember to type /report ends up never seeing the numbers. 0, or a BLANK value, turns it
     * off; /report keeps working either way. See optionalHours() for why blank and absent differ.
     *
     * WHERE the report is posted is NOT configured here: it is TELEGRAM_FEED_CHAT_ID when that is
     * set and the admin group otherwise, so a single-group deployment still gets it. That also means
     * a configured feed group receives the cashier float — see the SAFETY note above and
     * services/report-schedule.cron.ts.
     *
     * Unlike the two variables above this does NOT transform to another type, so it survives into
     * process.env — read it through AppConfigService anyway, like everything else.
     */
    REPORT_SCHEDULE_HOURS: optionalHours('REPORT_SCHEDULE_HOURS', 168).default(6),

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
