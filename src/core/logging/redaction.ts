/**
 * WHY this file exists at all: this service handles four kinds of secret that are unusually easy to
 * log by accident, and each one has already burned someone somewhere.
 *
 *  1. Telegram `initData` — it IS the credential. Its `hash` field is what we verify; anyone who
 *     copies a logged initData out of a log aggregator can replay it (our Redis nonce narrows that
 *     to 300s, but 300s is plenty).
 *  2. The bot token — appears inside every Telegram API URL grammY builds
 *     (`api.telegram.org/bot<TOKEN>/sendMessage`), so it leaks through error messages and HTTP
 *     traces, not just through config. Hence the URL scrubber below, not merely a key match.
 *  3. Our Ichancy accessToken/refreshToken — one pair per agent, ever; a leak means an attacker can
 *     move real money and our own refresh will start failing.
 *  4. Player refresh tokens.
 *
 * pino's `redact.paths` handles the known, structural locations cheaply. `redactSecrets()` handles
 * the arbitrary ones (an Ichancy request body, a Telegram update) where the shape is not known in
 * advance and a key-name heuristic plus value scrubbing is the only workable defence.
 */

export const REDACTED = '[REDACTED]';

/**
 * Static paths for pino's `redact` option. These are evaluated by a compiled accessor and are far
 * cheaper than walking the object, so anything with a known location belongs here.
 */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["x-telegram-bot-api-secret-token"]',
  'req.headers["x-init-data"]',
  'res.headers["set-cookie"]',
  // Request bodies: pino-http does not log them by default, but custom log calls do.
  'req.body.initData',
  'req.body.init_data',
  'req.body.password',
  'req.body.refreshToken',
  'req.body.accessToken',
  '*.initData',
  '*.init_data',
  '*.password',
  '*.accessToken',
  '*.refreshToken',
  '*.botToken',
  '*.secret',
  '*.authorization',
];

/** Key names whose VALUE is a secret regardless of where the key appears. */
const SENSITIVE_KEY =
  /(pass(word|hash)?|secret|token|authorization|apikey|api_key|initdata|init_data|credential|cookie|totp)/i;

/**
 * A Telegram bot token: `<numeric bot id>:<35-ish url-safe chars>`. Matched anywhere in a string so
 * it is caught inside URLs and error messages, which is where it actually escapes.
 *
 * NO `\b` ANCHORS — and that is the whole point. The token's most common appearance is
 * `https://api.telegram.org/bot123456789:AAF...`, where the digits are preceded by the `t` of
 * "bot". Both are word characters, so there is no word boundary there and a `\b`-anchored pattern
 * matches nothing at exactly the place the token actually leaks.
 */
const BOT_TOKEN_IN_TEXT = /\d{6,}:[A-Za-z0-9_-]{30,}/g;

/** `Bearer eyJ...` in a header value or an error message. */
const BEARER_IN_TEXT = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** A bare JWT. Ichancy access tokens and our own both match. */
const JWT_IN_TEXT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

/** Scrub secrets that are embedded INSIDE a string rather than held in a field of their own. */
export function scrubSecretsFromString(value: string): string {
  return value
    .replace(BOT_TOKEN_IN_TEXT, `<BOT_TOKEN>`)
    .replace(JWT_IN_TEXT, `<JWT>`)
    .replace(BEARER_IN_TEXT, (match) => `${match.split(/\s+/)[0] ?? 'Bearer'} ${REDACTED}`);
}

const MAX_DEPTH = 8;

/**
 * Deep-copy `value` with every sensitive field replaced. Use before logging anything whose shape we
 * do not control: Ichancy request/response bodies, raw Telegram updates, job payloads.
 *
 * Returns a NEW structure; the input is never mutated (logging must not alter what it observes).
 * Cycles are handled, depth is bounded, and BigInt/Date are preserved as readable scalars because
 * the money path is full of both.
 */
export function redactSecrets(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return scrubSecretsFromString(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubSecretsFromString(value.message),
      stack: value.stack === undefined ? undefined : scrubSecretsFromString(value.stack),
    };
  }

  if (depth >= MAX_DEPTH) return '[TRUNCATED]';

  if (typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => redactSecrets(item, depth + 1, seen));
    }

    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactSecrets(item, depth + 1, seen);
    }
    return output;
  }

  // Unreachable: every typeof has been handled above. Kept as a total fallback rather than
  // String(value), which would silently emit '[object Object]' for anything we missed.
  return '[UNSERIALIZABLE]';
}
