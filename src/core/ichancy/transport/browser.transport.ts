/**
 * THE BROWSER TRANSPORT — a real Chromium performing the agent-API calls.
 *
 * ══ WHY THIS EXISTS ═══════════════════════════════════════════════════════════════════════════
 * agents.ichancy.com answers server-to-server POSTs with a Cloudflare Managed Challenge. Copying a
 * browser's `cf_clearance` into a Node client was tried and MEASURED on 2026-08-19: it worked for
 * ~17 minutes, and hours later for exactly one request, because Cloudflare's trust score for an IP
 * drops with every challenge that IP fails. Pasting cookies is therefore not an integration, it is a
 * countdown. This class removes the countdown by being the thing Cloudflare is checking for.
 *
 * ══ WHY page.evaluate(fetch) AND NOT page.request / APIRequestContext ═════════════════════════
 * THIS IS THE WHOLE TRICK, and getting it wrong looks identical to getting it right until the
 * challenge fires. Playwright's `page.request` (and `context.request`) issue HTTP from PLAYWRIGHT's
 * own Node stack — not from Chromium. They therefore carry Node's TLS/JA3 and HTTP/2 fingerprints,
 * which is exactly the signature that gets challenged, and they would put us back where we started
 * while appearing to "use a browser". Only a `fetch()` executed INSIDE the page runs through
 * Chromium's network stack, with Chrome's fingerprints and Chrome's cookie jar.
 *
 * ══ WHY THE PAGE IS PARKED ON THE TARGET ORIGIN ═══════════════════════════════════════════════
 * The in-page fetch is same-origin, so the browser attaches cf_clearance and the PHP session itself
 * and no CORS preflight is involved. It also means the challenge is solved ONCE, by navigating, and
 * every later call rides the clearance the browser earned for itself — refreshing it without us.
 *
 * ══ WHAT THIS DOES NOT DO ═════════════════════════════════════════════════════════════════════
 * It does not log in to the panel and it never touches the agent UI. It is a transport: same POSTs,
 * same bodies, same envelope, same error map. Nothing above it can tell the difference, which is why
 * flipping ICHANCY_TRANSPORT is safe in both directions.
 */
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';

import { AppConfigService } from '@core/config/config.service';

import {
  type IchancyTransport,
  type IchancyTransportRequest,
  type IchancyTransportResponse,
} from './ichancy-transport';

/**
 * Minimal structural types for the bits of Playwright we touch. Declared locally so this file
 * compiles — and the whole project typechecks — on a machine where the OPTIONAL `playwright`
 * dependency was never installed. The import itself is dynamic for the same reason.
 */
interface PlaywrightPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  title(): Promise<string>;
  evaluate<T>(fn: string, arg?: unknown): Promise<T>;
  isClosed(): boolean;
}
interface PlaywrightCookie {
  name: string;
  value: string;
}
interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
  cookies(): Promise<PlaywrightCookie[]>;
  addCookies(cookies: { name: string; value: string; domain: string; path: string }[]): Promise<void>;
}
interface PlaywrightBrowser {
  newContext(options?: Record<string, unknown>): Promise<PlaywrightContext>;
  close(): Promise<void>;
  isConnected(): boolean;
}
interface PlaywrightChromium {
  launch(options?: Record<string, unknown>): Promise<PlaywrightBrowser>;
}

/** The shape the in-page script hands back. Mirrors IchancyTransportResponse. */
interface InPageResult {
  status: number;
  contentType: string | null;
  text: string;
}

/**
 * Builds the script that runs INSIDE Chromium: a self-invoking async expression with the payload
 * already embedded as a JSON literal.
 *
 * ══ WHY THE PAYLOAD IS BAKED IN RATHER THAN PASSED AS AN ARGUMENT ═════════════════════════════
 * `page.evaluate(fn, arg)` passes `arg` only when `fn` is a real FUNCTION. Given a STRING, Playwright
 * treats it as an expression and drops the argument — the first live run of this transport returned
 * `undefined` and failed with "Cannot read properties of undefined (reading 'status')" for exactly
 * that reason, after Chromium had already cleared the challenge.
 *
 * A real function would fix the argument but introduces a worse hazard: TypeScript may rewrite an
 * async arrow into a helper (`__awaiter`) that does not exist inside the page, and that breaks only
 * when the compile target changes — a landmine, not an error. Embedding the payload keeps this
 * independent of both Playwright's argument handling and the compiler's output.
 *
 * `credentials: 'include'` is what attaches cf_clearance and the PHP session. `fetch` never throws
 * for an HTTP status — a 403 challenge comes back as a normal result with the interstitial as its
 * text, which is precisely what the error map needs to see.
 */
function buildInPageFetch(input: {
  url: string;
  headers: Record<string, string>;
  body: string;
}): string {
  return [
    '(async () => {',
    `  const input = ${JSON.stringify(input)};`,
    '  const response = await fetch(input.url, {',
    "    method: 'POST',",
    '    headers: input.headers,',
    '    body: input.body,',
    "    credentials: 'include',",
    '  });',
    '  return {',
    '    status: response.status,',
    "    contentType: response.headers.get('content-type'),",
    '    text: await response.text(),',
    '  };',
    '})()',
  ].join('\n');
}

/** Cloudflare's interstitial, as seen from inside the page. Same markers as the error map. */
const CHALLENGE_TITLES = ['just a moment', 'attention required'];

/** How long to let a Managed Challenge run before giving up on a navigation. */
const CHALLENGE_TIMEOUT_MS = 45_000;

/** After solving, poll for the challenge to clear rather than trusting a fixed sleep. */
const CHALLENGE_POLL_MS = 500;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Loaded on demand so `playwright` can stay an OPTIONAL dependency: a deployment that uses the fetch
 * transport (an allowlisted IP, or the fake adapter) must not need a 300 MB browser in its image.
 * The error names the fix rather than surfacing a bare MODULE_NOT_FOUND.
 */
async function loadChromium(): Promise<PlaywrightChromium> {
  try {
    const playwright = (await import('playwright')) as unknown as { chromium: PlaywrightChromium };
    return playwright.chromium;
  } catch (error: unknown) {
    throw new Error(
      'ICHANCY_TRANSPORT=browser needs Playwright, which is an optional dependency. Install it with ' +
        '`npm install playwright && npx playwright install chromium`. ' +
        `Underlying error: ${describe(error)}`,
    );
  }
}

@Injectable()
export class BrowserIchancyTransport implements IchancyTransport, OnModuleDestroy {
  readonly name = 'browser';

  private readonly logger = new Logger(BrowserIchancyTransport.name);

  private browser: PlaywrightBrowser | null = null;
  private context: PlaywrightContext | null = null;
  private page: PlaywrightPage | null = null;
  /** Single-flight: N concurrent calls must not launch N browsers or solve N challenges. */
  private starting: Promise<PlaywrightPage> | null = null;

  constructor(private readonly config: AppConfigService) {}

  async post(request: IchancyTransportRequest): Promise<IchancyTransportResponse> {
    const page = await this.ensurePage();

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (request.accessToken) headers['authorization'] = `Bearer ${request.accessToken}`;

    const first = await this.runInPage(page, request, headers);
    if (!this.looksChallenged(first)) return first;

    // The clearance lapsed while we were idle. Re-navigating re-solves it — the browser can, which
    // is the entire reason this transport exists — and the call is replayed ONCE.
    //
    // WHY REPLAYING IS SAFE HERE AND NOT IN GENERAL: a challenged request never reached Ichancy. The
    // 403 comes from Cloudflare's edge, with its own interstitial as the body, so no agent-side
    // state was touched and no money moved. A retry after any OTHER failure would not be safe and is
    // deliberately not done — see the header of ichancy-http.client.ts.
    this.logger.warn('Cloudflare challenged the call; re-solving in the browser and retrying once');
    await this.solveChallenge(page);
    return this.runInPage(page, request, headers);
  }

  async onModuleDestroy(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.page = null;
    if (browser === null) return;
    // Never let a shutdown hang on a wedged browser: an unclosed Chromium is a leaked process, but a
    // process that will not exit is worse.
    await browser.close().catch((error: unknown) => {
      this.logger.warn(`Chromium did not close cleanly: ${describe(error)}`);
    });
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────

  private async runInPage(
    page: PlaywrightPage,
    request: IchancyTransportRequest,
    headers: Record<string, string>,
  ): Promise<IchancyTransportResponse> {
    const script = buildInPageFetch({
      url: request.url,
      headers,
      body: JSON.stringify(request.body),
    });

    // A Managed Challenge RELOADS the page as it completes, and an evaluate caught in that window
    // dies with "Execution context was destroyed". That is a race, not a failure: the page is about
    // to be perfectly usable. One retry after a settle turns it into a non-event.
    let result: InPageResult | undefined;
    try {
      result = await page.evaluate<InPageResult | undefined>(script);
    } catch (error: unknown) {
      if (!describe(error).includes('Execution context was destroyed')) throw error;
      this.logger.debug('The page navigated mid-call (challenge completing); retrying the fetch');
      await delay(CHALLENGE_POLL_MS * 2);
      result = await page.evaluate<InPageResult | undefined>(script);
    }

    if (result === undefined || typeof result.status !== 'number') {
      // Defensive, and it earns its keep: the first version of this transport silently returned
      // undefined here (see buildInPageFetch), and without this guard the failure surfaced as an
      // unrelated TypeError instead of naming the layer that broke.
      throw new Error('The in-page fetch returned nothing — the browser transport script is broken');
    }

    return { status: result.status, contentType: result.contentType, text: result.text };
  }

  /** A challenge, judged the same way the error map judges it: non-JSON + a blocking status. */
  private looksChallenged(response: IchancyTransportResponse): boolean {
    if (response.status !== 403 && response.status !== 503 && response.status !== 429) return false;
    return response.contentType?.toLowerCase().includes('application/json') !== true;
  }

  /**
   * The browser, launched once and reused. Single-flighted so a burst of credits cannot start a
   * second Chromium — each one costs hundreds of megabytes and would earn its own clearance.
   */
  private async ensurePage(): Promise<PlaywrightPage> {
    const existing = this.page;
    if (existing !== null && !existing.isClosed() && this.browser?.isConnected() === true) {
      return existing;
    }

    this.starting ??= this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(): Promise<PlaywrightPage> {
    const chromium = await loadChromium();
    const settings = this.config.ichancy;

    this.logger.log(
      `Launching Chromium for the Ichancy transport (headless=${String(settings.browserHeadless)})`,
    );

    const browser = await chromium.launch({
      headless: settings.browserHeadless,
      // --disable-blink-features=AutomationControlled removes the `navigator.webdriver` flag that
      // bot protection reads first. The rest are the standard flags for running in a container.
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });

    const context = await browser.newContext({
      // The SAME UA the fetch transport would send, so the two are indistinguishable upstream and a
      // clearance earned here stays valid if the transport is switched back.
      userAgent: settings.userAgent,
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
    });

    this.browser = browser;
    this.context = context;

    await this.seedPanelCookies(context);

    const page = await context.newPage();
    this.page = page;

    await this.solveChallenge(page);
    return page;
  }

  /**
   * Navigate to the origin and wait for Cloudflare to let us through.
   *
   * The wait is a poll on the page TITLE rather than a fixed sleep: a Managed Challenge takes
   * anywhere from under a second to tens of seconds depending on how suspicious the IP currently
   * looks, and both a too-short sleep (challenged on the first call) and a too-long one (every boot
   * pays for the worst case) are wrong.
   */
  private async solveChallenge(page: PlaywrightPage): Promise<void> {
    const origin = new URL(this.config.ichancy.baseUrl).origin;
    const startedAt = Date.now();

    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: CHALLENGE_TIMEOUT_MS });

    for (;;) {
      const title = (await page.title().catch(() => 'just a moment')).toLowerCase();
      const cleared = !CHALLENGE_TITLES.some((marker) => title.includes(marker));

      // The TITLE is not enough. It flips the instant the interstitial is replaced, while the
      // clearance cookie is written a moment later and the page reloads once more — which is how the
      // first working build still had its opening call challenged. `cf_clearance` in the jar is the
      // real signal that the browser may now speak to the API, so wait for the cookie, not the DOM.
      if (cleared && (await this.hasClearanceCookie())) {
        // A short settle after the cookie appears: the challenge's final reload is usually still in
        // flight, and starting a fetch into it only earns an "Execution context was destroyed".
        await delay(CHALLENGE_POLL_MS * 2);
        this.logger.log(`Cloudflare cleared in ${String(Date.now() - startedAt)}ms`);
        return;
      }
      if (Date.now() - startedAt > CHALLENGE_TIMEOUT_MS) {
        // Not fatal: post() still issues the call and the error map reports CLOUDFLARE_CHALLENGE
        // like any other blocked request. Failing loudly here would turn a slow challenge into a
        // dead worker.
        this.logger.error(
          `Cloudflare challenge did not clear within ${String(CHALLENGE_TIMEOUT_MS)}ms; ` +
            'calls will be attempted anyway and will report CLOUDFLARE_CHALLENGE if still blocked',
        );
        return;
      }
      await delay(CHALLENGE_POLL_MS);
    }
  }

  /**
   * Copy the PANEL cookies from ICHANCY_COOKIE into the browser — and deliberately NOT Cloudflare's.
   *
   * WHY THE PANEL SESSION MATTERS EVEN THOUGH WE AUTHENTICATE WITH A BEARER TOKEN: the API is the
   * same host the agent panel runs on, and a request that carries a signed-in `PHPSESSID` looks like
   * the panel's own XHR — which is traffic Cloudflare sees constantly and trusts. A pristine browser
   * with no session is an anonymous client POSTing at an API path, which is what gets challenged.
   *
   * WHY cf_clearance AND __cf_bm ARE EXCLUDED: those are Cloudflare's, and the browser earns its own
   * — fresher, bound to this exact client. Injecting the stale ones from .env would overwrite a live
   * clearance with a dead one, which is the opposite of the point of this transport.
   *
   * Best-effort: no configured cookie simply means nothing is seeded, and the browser still solves
   * the challenge on its own.
   */
  private async seedPanelCookies(context: PlaywrightContext): Promise<void> {
    const configured = this.config.ichancy.cookie;
    if (configured === null) return;

    const host = new URL(this.config.ichancy.baseUrl).hostname;
    const cloudflareOwned = new Set(['cf_clearance', '__cf_bm', '__cflb', 'cf_chl_rc_m']);

    const cookies: { name: string; value: string; domain: string; path: string }[] = [];
    for (const part of configured.split(';')) {
      const separator = part.indexOf('=');
      if (separator <= 0) continue;
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (name.length === 0 || value.length === 0) continue;
      if (cloudflareOwned.has(name)) continue;
      cookies.push({ name, value, domain: host, path: '/' });
    }

    if (cookies.length === 0) return;

    try {
      await context.addCookies(cookies);
      this.logger.log(
        `Seeded ${String(cookies.length)} panel cookie(s) into Chromium: ` +
          `${cookies.map((cookie) => cookie.name).join(', ')}`,
      );
    } catch (error: unknown) {
      this.logger.warn(`Could not seed panel cookies: ${describe(error)}`);
    }
  }

  /**
   * Has Chromium been granted `cf_clearance` yet? That cookie is the only unambiguous evidence the
   * challenge is genuinely finished — everything else (title, load state) flips too early.
   */
  private async hasClearanceCookie(): Promise<boolean> {
    const context = this.context;
    if (context === null) return false;
    try {
      const cookies = await context.cookies();
      return cookies.some((cookie) => cookie.name === 'cf_clearance' && cookie.value.length > 0);
    } catch {
      // Reading cookies can race a context teardown. Not knowing is not the same as "cleared".
      return false;
    }
  }
}
