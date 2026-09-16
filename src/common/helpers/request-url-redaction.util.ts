/**
 * WHY the backend redacts its own request URLs even though Caddy already rewrites them: the Telegram
 * webhook is served at /telegram/webhook/<path token>, one token per operator, and that segment is
 * half of the endpoint's credentials: it selects the operator whose secret header is then checked.
 * Caddy's access-log regexp keeps the
 * token out of ITS lines, but pino-http, the exception filter and the boot banner used to write the
 * same URL straight to stdout, which Docker keeps and Alloy ships to Loki. Anyone with Grafana would
 * then read the token from the upstream's lines instead of the proxy's.
 *
 * WHY this lives in `common` and not beside the logging module: the global exception filter is in
 * `common`, and the layering rules forbid common -> core. `core` (the pino serializer, the webhook CLI)
 * and the entrypoint may both import from here, so one function serves every caller.
 *
 * WHY the query string is stripped too: a query string is where a client puts things it should not
 * (tokens, initData on a misrouted GET), and no log reader needs it to tell which route was hit.
 */

export const REDACTED_PATH_SEGMENT = '[REDACTED]';

/**
 * Not anchored to the start of the string, so it also matches inside an absolute URL
 * (`https://api.example/telegram/webhook/<token>`) and inside a free-text message. `[^/?#\s]+` stops
 * at the end of the segment, so a query string, fragment or following sentence survives intact.
 */
const WEBHOOK_PATH_TOKEN = /(\/telegram\/webhook\/)[^/?#\s]+/g;

/** Replace the webhook path token wherever it appears in `text`. Everything else is left as is. */
export function redactWebhookPathToken(text: string): string {
  return text.replace(WEBHOOK_PATH_TOKEN, `$1${REDACTED_PATH_SEGMENT}`);
}

/**
 * The form of a request URL that is safe to log: query string and fragment dropped, webhook path
 * token masked. Takes `undefined` because Node's `IncomingMessage.url` is typed optional.
 */
export function redactRequestUrl(url: string | undefined): string {
  const path = (url ?? '').split(/[?#]/)[0] ?? '';
  return redactWebhookPathToken(path);
}
