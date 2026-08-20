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

/**
 * Sent as `User-Agent` to the agent API when ICHANCY_USER_AGENT is unset or blank.
 *
 * A desktop Chrome string, deliberately NOT `node`/`undici`: bot protection scores a default runtime
 * UA badly on its own, and `cf_clearance` is issued against the UA that earned it.
 *
 * ⚠️ THIS DEFAULT IS A FALLBACK, NOT A CORRECT VALUE. Whenever a cookie is in play, the UA must be
 * the one from the browser that earned it — Cloudflare rejects a clearance presented under a
 * different UA exactly as if no cookie had been sent, with nothing anywhere saying the two
 * disagree. Proven on 2026-08-19: a valid, minutes-old cf_clearance was refused under Chrome/140
 * and accepted under Chrome/150, which was the browser that produced it. Set ICHANCY_USER_AGENT
 * explicitly and treat this constant as "something plausible for a host with no cookie at all".
 */
/**
 * Fallback domain for the synthetic player mailboxes, used when ICHANCY_PLAYER_EMAIL_DOMAIN is unset
 * or blank. See that variable below for why it is `example.com` and not the RFC 2606 `.invalid` TLD
 * this project used until 2026-08-19.
 */
const DEFAULT_ICHANCY_PLAYER_EMAIL_DOMAIN = 'players.example.com';

export const DEFAULT_ICHANCY_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/150.0.0.0 Safari/537.36';

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
     * Raw `Cookie:` header for the agent API — in practice `cf_clearance` plus `__cf_bm` and the
     * PHPSESSID, copied out of a browser that has passed Cloudflare's check.
     *
     * WHY THIS EXISTS: agents.ichancy.com is behind Cloudflare bot protection. A server-to-server
     * POST with no cookie gets an HTML challenge page, never JSON — which is exactly what "it works
     * in the browser but fails in Postman" means. Optional, because the fake adapter and any
     * environment without the challenge need nothing here.
     *
     * OPERATIONAL WARNING: `cf_clearance` is bound to the CLIENT IP and the User-Agent that earned
     * it. A cookie copied from a laptop will NOT work from a server with a different public IP —
     * the durable fix is asking Ichancy to allowlist the server's IP.
     */
    /**
     * Domain of the synthetic mailboxes we register players with, e.g. `players.example.com` ->
     * `p912911246_7fszgwgh@players.example.com`.
     *
     * MUST have a TLD Ichancy's validator accepts. A reserved TLD does NOT work: registering with
     * `.invalid` (RFC 2606, the obvious choice for an address that must never deliver) is refused
     * with "Email field contains invalid characters." — proven against the live API on 2026-08-19,
     * where the same local part on `.com` was accepted.
     *
     * MUST be a domain nobody else can ever own. Ichancy may send account mail to these addresses,
     * so a domain we do not control is a stranger receiving our players' email one registration
     * later. Either a domain you own with no MX record, or `example.com` (IANA-reserved forever).
     *
     * ⚠️ PERMANENT PER PLAYER. The address is stored on the row and is UNIQUE upstream; changing
     * this only affects players registered afterwards, and a player registered under the old domain
     * keeps it. Decide once, before the first real registration.
     */
    ICHANCY_PLAYER_EMAIL_DOMAIN: z
      .string()
      .optional()
      // Blank means default, for the same reason as ICHANCY_USER_AGENT: `KEY=` in a .env file is an
      // empty string, and an operator who clears a line means "use the default", not "boot with an
      // empty domain and register everyone at `login@`".
      .transform((value) =>
        value === undefined || value.trim().length === 0
          ? DEFAULT_ICHANCY_PLAYER_EMAIL_DOMAIN
          : value.trim(),
      )
      .refine(
        (value) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value),
        'ICHANCY_PLAYER_EMAIL_DOMAIN must look like a domain, e.g. players.example.com',
      ),
    /**
     * The PLAYER-facing site, where a player signs in with the credentials we registered for them.
     * Not the agent panel (ICHANCY_BASE_URL) — that is staff-only and a player must never be sent
     * there. Printed in the bot's account message, so it has to be the address that actually works.
     */
    ICHANCY_PLAYER_SITE_URL: httpUrl('ICHANCY_PLAYER_SITE_URL').default('https://ichancy.com'),
    /**
     * HOW agent-API requests physically leave this process.
     *
     *   browser  (DEFAULT, and the correct answer) a real Chromium that performs the POST from
     *            inside the page, so the call carries Chrome's TLS/JA3 and HTTP/2 fingerprints and
     *            the browser solves — and then REFRESHES — the Cloudflare Managed Challenge by
     *            itself. Nothing has to be pasted, and nothing expires.
     *   fetch    FALLBACK. Node's fetch plus a cookie jar from ICHANCY_COOKIE. Correct only for a
     *            host Ichancy has IP-allowlisted, or with ICHANCY_FAKE=true.
     *
     * WHY THE DEFAULT MOVED (2026-08-19/20, measured, not assumed): a cf_clearance pasted out of a
     * browser worked for ~17 minutes, then hours later for exactly ONE request, because Cloudflare's
     * trust score for an IP decays with every challenge that IP fails. The owner saw the same curve
     * on 2026-08-20 — roughly twenty minutes of success followed by `AMBIGUOUS / 403 /
     * CLOUDFLARE_CHALLENGE` on every call for hours, which stranded a player at PENDING_ICHANCY.
     * Pasting cookies is not an integration, it is a countdown, so it is no longer the default.
     *
     * `browser` requires the OPTIONAL playwright dependency AND its browser binary:
     *   npm install playwright && npm run playwright:install
     * IchancyTransportPreflightService refuses to boot when either is missing, rather than letting
     * the gap surface at the first player as an unexplained TRANSPORT_ERROR.
     */
    ICHANCY_TRANSPORT: z.enum(['fetch', 'browser']).default('browser'),
    /**
     * Run the transport's Chromium headless. Default true.
     *
     * Set to false when a Managed Challenge refuses to clear headless — a visible browser is scored
     * differently, and on a desktop it costs nothing to find out. On a server it needs a display
     * (xvfb), so headless stays the default.
     */
    /**
     * Refresh the Cloudflare clearance every ~25 minutes in a real Chrome, and let the fetch
     * transport use it. See transport/cookie-harvester.service.ts for the recipe and why each part
     * of it matters.
     *
     * OFF by default: it is a workaround for bot protection sitting in front of an API meant for
     * server-to-server use. Turn it off again the day Ichancy allowlists the server's IP.
     *
     * Requires the OPTIONAL patchright dependency and a real Chrome; on Linux it also needs a
     * display (xvfb-run), because the challenge does not release headless.
     */
    ICHANCY_COOKIE_HARVEST: optionalFlag(),
    /**
     * Where the harvester's Chrome profile lives. A PERSISTENT directory on purpose — a blank
     * profile scores badly with bot protection and never accumulates any trust. Defaults to a
     * directory under the OS temp path, which is fine for a dev box; on a server point it at
     * something that survives restarts.
     */
    ICHANCY_COOKIE_PROFILE_DIR: z.string().optional(),
    ICHANCY_BROWSER_HEADLESS: z
      .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
      .optional()
      .transform((v) => (v === undefined ? true : ['true', '1', 'yes', 'on'].includes(v))),
    ICHANCY_COOKIE: z.string().optional(),
    /**
     * Sent as `User-Agent` BY THE FETCH TRANSPORT ONLY. Ignored in browser mode, where Chromium
     * supplies its own and overriding it would make the header, the TLS fingerprint and the JS
     * environment disagree — which is precisely what Cloudflare fingerprints for.
     *
     * When it does apply it MUST match the browser that produced ICHANCY_COOKIE, or Cloudflare
     * invalidates the clearance exactly as if no cookie had been sent, with nothing anywhere saying
     * the two disagree. That mismatch caused half of the 2026-08-20 outage: the pasted clearance was
     * earned in Chrome 150 (sec-ch-ua `"Google Chrome";v="150"`) while this variable claimed
     * Firefox 153, so the clearance was dead on arrival.
     *
     * The default is a current desktop Chrome string — deliberately not `node`/`undici`, which bot
     * protection scores badly on its own.
     */
    ICHANCY_USER_AGENT: z
      .string()
      .optional()
      // `.default()` fills only `undefined`, and `ICHANCY_USER_AGENT=` in a .env file is an EMPTY
      // STRING, not undefined — which failed `.min(1)` and refused to boot. Since .env.example
      // tells operators to leave this empty when the server IP is allowlisted, "present but blank"
      // is the COMMON case and has to mean "use the default", not "crash".
      .transform((value) =>
        value === undefined || value.trim().length === 0 ? DEFAULT_ICHANCY_USER_AGENT : value.trim(),
      ),
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
