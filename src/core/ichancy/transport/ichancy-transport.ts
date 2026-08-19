/**
 * THE TRANSPORT SEAM: the one place that decides HOW a request physically leaves this process.
 *
 * WHY THIS EXISTS. agents.ichancy.com is behind a Cloudflare Managed Challenge. A plain server-side
 * POST — Node's fetch, curl, Postman — is answered with an interstitial instead of JSON, and the
 * cookie-replay workaround died in practice: a `cf_clearance` copied from a browser survived ~17
 * minutes on 2026-08-19 and, hours later, exactly ONE request, because Cloudflare's trust score for
 * an IP falls with every challenge it fails. There is no header combination that fixes that.
 *
 * What DOES work is being a browser. So the transport is pluggable:
 *
 *   fetch    — Node's fetch plus a cookie jar. Right for any host without bot protection, and the
 *              only sane choice once Ichancy allowlists a server IP.
 *   browser  — a real Chromium performing the POST from inside the page, which means Chrome's TLS
 *              and HTTP/2 fingerprints and a challenge the browser can actually solve.
 *
 * Everything above this line — the envelope parsing, the error map, the call log, the money
 * semantics — is identical either way. That is the whole point of putting the seam here and not
 * higher up: swapping how bytes travel must not be able to change what a credit means.
 */

/** DI token. `@Inject(ICHANCY_TRANSPORT) private readonly transport: IchancyTransport`. */
export const ICHANCY_TRANSPORT = 'ICHANCY_TRANSPORT';

export interface IchancyTransportRequest {
  readonly url: string;
  /** Serialized by the transport, so a browser can hand the object straight to its own JSON.stringify. */
  readonly body: Record<string, unknown>;
  /** Omitted for signin/refreshToken; a Bearer header for everything else. */
  readonly accessToken: string | null;
  readonly timeoutMs: number;
}

export interface IchancyTransportResponse {
  readonly status: number;
  /** Needed by the Cloudflare detector: a JSON content type means the answer is Ichancy's. */
  readonly contentType: string | null;
  /** The raw body. Never parsed here — parsing is the caller's job and its failures are meaningful. */
  readonly text: string;
}

/**
 * A transport THROWS on a transport-level failure (socket, timeout, browser gone) and RETURNS on any
 * HTTP answer, including a 403 challenge page. The distinction matters: a throw is classified as
 * ambiguous ("we do not know whether the far side acted"), while a returned 403 carries a body the
 * error map can read.
 */
export interface IchancyTransport {
  /** Short name for logs and the ichancy:check diagnostic — 'fetch' or 'browser'. */
  readonly name: string;
  post(request: IchancyTransportRequest): Promise<IchancyTransportResponse>;
}
