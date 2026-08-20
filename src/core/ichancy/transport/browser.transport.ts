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

import { isCloudflareChallenge } from '../error-map';

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
  addCookies(
    cookies: { name: string; value: string; domain: string; path: string }[],
  ): Promise<void>;
  close(): Promise<void>;
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
 *
 * The in-page `AbortSignal.timeout` is the INNER half of the call budget, and the cheap one: it
 * cancels the request inside Chromium so a wedged socket is not still held after we stop waiting.
 * It is deliberately NOT trusted on its own — whether an in-page abort surfaces as a clean
 * rejection on every Playwright/Chromium build has not been verified here — so the outer race in
 * `runInPage` is what actually guarantees the caller gets control back.
 */
function buildInPageFetch(input: {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}): string {
  return [
    '(async () => {',
    `  const input = ${JSON.stringify(input)};`,
    '  const response = await fetch(input.url, {',
    "    method: 'POST',",
    '    headers: input.headers,',
    '    body: input.body,',
    "    credentials: 'include',",
    '    signal: AbortSignal.timeout(input.timeoutMs),',
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

/**
 * The launch + challenge budget, kept SEPARATE from the per-call budget on purpose.
 *
 * A Managed Challenge can legitimately run for 45 seconds, and charging that to an 8 second
 * ICHANCY_TIMEOUT_MS would make the first call after every boot time out by construction. The boot
 * preflight's warm-up takes this off the first player's /start; this ceiling only covers the cases
 * where the warm-up did not run or the browser had to be relaunched mid-life.
 */
const LAUNCH_BUDGET_MS = 90_000;

/**
 * Grace added to ICHANCY_TIMEOUT_MS for the OUTER race, so the in-page abort gets a chance to
 * produce the tidier failure (the request genuinely cancelled inside Chromium) before we give up.
 */
const OUTER_TIMEOUT_GRACE_MS = 2_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Did Chromium DIE, as opposed to answering badly?
 *
 * Observed live on 2026-08-20: `page.evaluate: Target page, context or browser has been closed`,
 * 47 seconds into a wallet read, on a machine already running the api, the worker, ngrok and a
 * second Chromium. The browser had been launched and its User-Agent read moments earlier, so this
 * is the process going away underneath a page object that still looked usable — `isClosed()` is a
 * snapshot, and nothing re-checks it between `ensurePage()` and the fetch.
 */
function isBrowserGone(error: unknown): boolean {
  const message = describe(error).toLowerCase();
  return (
    message.includes('target page, context or browser has been closed') ||
    message.includes('target closed') ||
    message.includes('browser has been closed') ||
    message.includes('browser has disconnected') ||
    message.includes('page crashed')
  );
}

/**
 * Shaped so `isTimeoutError` recognises it: that helper matches on `error.name`, and only a
 * TimeoutError or an AbortError reaches `classifyTransportFailure`'s `rule: 'TIMEOUT'` branch and
 * therefore the IchancyOutcome.TIMEOUT row. Any other error name lands as TRANSPORT_ERROR and tells
 * an operator the wrong story about why the call stopped.
 */
function timeoutError(message: string): Error {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

/**
 * Bound a promise by wall clock. The losing promise is NOT cancelled — `page.evaluate` has no abort
 * — so the in-page AbortSignal is what stops the underlying request; this only returns control to
 * the caller so a cron tick cannot be held open forever.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(timeoutError(`${what} did not finish within ${String(ms)}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Is this response Cloudflare's interstitial rather than Ichancy's?
 *
 * DELEGATED to the error map, and that is a money decision rather than a tidy-up. This predicate
 * decides whether `post` REPLAYS the call, and the call being replayed can be `registerPlayer` —
 * which is not idempotent and whose duplicate cannot be deleted, because the agent API has no
 * deletePlayer. The old local version replayed on any non-JSON 403/503/429, and treated a NULL
 * content-type as a challenge, so a genuine origin 403 with an empty body earned a blind retry.
 *
 * The replay is legal ONLY for the case this predicate now describes: a Cloudflare EDGE 403 carries
 * Cloudflare's own interstitial as its body, which proves the request never reached their
 * application, so no account can have been created by it and no money can have moved.
 */
export function looksChallenged(response: IchancyTransportResponse): boolean {
  return isCloudflareChallenge(response.status, response.text, response.contentType);
}

/**
 * Loaded on demand so `playwright` can stay an OPTIONAL dependency: a deployment that uses the fetch
 * transport (an allowlisted IP, or the fake adapter) must not need a 300 MB browser in its image.
 * The error names the fix rather than surfacing a bare MODULE_NOT_FOUND.
 */
export const MISSING_PLAYWRIGHT_MESSAGE =
  'ICHANCY_TRANSPORT=browser needs Playwright, which is an optional dependency. Install it with ' +
  '`npm install playwright && npm run playwright:install`.';

export async function loadChromium(): Promise<PlaywrightChromium> {
  try {
    const playwright = (await import('playwright')) as unknown as { chromium: PlaywrightChromium };
    return playwright.chromium;
  } catch (error: unknown) {
    throw new Error(`${MISSING_PLAYWRIGHT_MESSAGE} Underlying error: ${describe(error)}`);
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
  /**
   * Chromium's REAL User-Agent, read out of the page once it exists.
   *
   * Worth capturing because the alternative — assuming it — is exactly the mistake that broke this
   * integration: cf_clearance is bound to the UA that earned it, and until 2026-08-20 this class
   * stamped the configured (Firefox) string over a Chrome binary.
   */
  private chromiumUserAgent: string | null = null;

  constructor(private readonly config: AppConfigService) {}

  async post(request: IchancyTransportRequest): Promise<IchancyTransportResponse> {
    // Its OWN budget, not the caller's — see LAUNCH_BUDGET_MS. Without a ceiling here a wedged
    // launch blocks the caller forever and, under a 5-minute cron, the ticks pile up behind it.
    const page = await withDeadline(this.ensurePage(), LAUNCH_BUDGET_MS, 'Chromium launch');

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (request.accessToken) headers['authorization'] = `Bearer ${request.accessToken}`;

    let first: IchancyTransportResponse;
    try {
      first = await this.runInPage(page, request, headers);
    } catch (error: unknown) {
      if (!isBrowserGone(error)) throw error;

      // Drop the corpse so the NEXT call relaunches instead of evaluating against a dead target
      // forever. `ensurePage` already re-checks isClosed()/isConnected(), but those lie for a
      // process that died a moment ago — which is precisely how this failure repeated.
      this.logger.error(
        `Chromium died mid-call (${describe(error)}). Discarding it; the next call relaunches.`,
      );
      await this.discardBrowser();

      // DELIBERATELY NOT RETRIED, and this is the one place the browser transport must be more
      // conservative than it looks. A challenge is safe to replay because a 403 from Cloudflare's
      // edge PROVES the origin never saw the request. A dead browser proves nothing: the in-page
      // fetch may already have reached Ichancy and moved money, and we would never learn it did.
      // Rethrowing makes this `ambiguous`, which is exactly what the credit path is built to
      // resolve — a balance re-read, not a second depositToPlayer.
      throw error;
    }

    if (!looksChallenged(first)) return first;

    // The clearance lapsed while we were idle. Re-navigating re-solves it — the browser can, which
    // is the entire reason this transport exists — and the call is replayed ONCE.
    //
    // WHY REPLAYING IS SAFE HERE AND NOT IN GENERAL: a challenged request never reached Ichancy. The
    // 403 comes from Cloudflare's edge, with its own interstitial as the body, so no agent-side
    // state was touched and no money moved. A retry after any OTHER failure would not be safe and is
    // deliberately not done — see the header of ichancy-http.client.ts.
    this.logger.warn('Cloudflare challenged the call; re-solving in the browser and retrying once');
    await withDeadline(this.solveChallenge(page), LAUNCH_BUDGET_MS, 'Cloudflare re-solve');
    return this.runInPage(page, request, headers);
  }

  /**
   * Launch and clear the challenge NOW, off the money path.
   *
   * Called by the boot preflight. A cold start costs a Chromium launch plus up to 45 seconds of
   * Managed Challenge, and making the first player's /start pay for that is how "registration is
   * slow" gets misdiagnosed as an Ichancy problem.
   */
  async warmUp(): Promise<void> {
    await withDeadline(this.ensurePage(), LAUNCH_BUDGET_MS, 'Chromium warm-up');
  }

  /**
   * What `ichancy:check` prints. Never launches anything just to answer: a diagnostic that starts
   * a browser is a diagnostic that changes what it is measuring.
   */
  describeTransport(): {
    readonly transport: string;
    readonly headless: boolean;
    readonly launched: boolean;
    readonly chromiumUserAgent: string | null;
  } {
    return {
      transport: this.name,
      headless: this.config.ichancy.browserHeadless,
      launched: this.browser?.isConnected() === true,
      chromiumUserAgent: this.chromiumUserAgent,
    };
  }

  /**
   * Forget the current browser and close it best-effort. Shared by the mid-call death path and
   * shutdown, so there is one definition of "we no longer have a browser" rather than two that can
   * drift — a half-cleared state is what leaves `hasClearanceCookie()` reading a dead context.
   */
  /**
   * Chromium's own User-Agent, read from a throwaway context before the real one is built.
   *
   * WHY A THROWAWAY: the UA has to be known BEFORE `newContext` in order to be overridden there, and
   * the only authority on it is the binary itself. Guessing the version would reintroduce exactly
   * the hardcoded-string rot this is meant to end.
   *
   * Null on failure, which the caller treats as "do not override" — a launch must not die because a
   * diagnostic read failed.
   */
  private async readDefaultUserAgent(browser: PlaywrightBrowser): Promise<string | null> {
    try {
      const probe = await browser.newContext();
      const page = await probe.newPage();
      const ua = await page.evaluate<string>('navigator.userAgent');
      await probe.close().catch(() => undefined);
      return typeof ua === 'string' && ua.length > 0 ? ua : null;
    } catch (error: unknown) {
      this.logger.warn(`Could not read Chromium's User-Agent: ${describe(error)}`);
      return null;
    }
  }

  private async discardBrowser(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.chromiumUserAgent = null;
    if (browser === null) return;
    await browser.close().catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    // Nulled too: a surviving context is still readable by hasClearanceCookie(), which would then
    // report a dead browser's clearance as this one's.
    this.context = null;
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
      timeoutMs: request.timeoutMs,
    });
    // ICHANCY_TIMEOUT_MS was silently dropped by this transport until 2026-08-20, which made
    // IchancyOutcome.TIMEOUT unreachable and let a single wedged page block a caller forever.
    const budgetMs = request.timeoutMs + OUTER_TIMEOUT_GRACE_MS;

    // A Managed Challenge RELOADS the page as it completes, and an evaluate caught in that window
    // dies with "Execution context was destroyed". That is a race, not a failure: the page is about
    // to be perfectly usable. One retry after a settle turns it into a non-event.
    let result: InPageResult | undefined;
    try {
      result = await withDeadline(
        page.evaluate<InPageResult | undefined>(script),
        budgetMs,
        'The in-page fetch',
      );
    } catch (error: unknown) {
      if (!describe(error).includes('Execution context was destroyed')) throw error;
      this.logger.debug('The page navigated mid-call (challenge completing); retrying the fetch');
      await delay(CHALLENGE_POLL_MS * 2);
      result = await withDeadline(
        page.evaluate<InPageResult | undefined>(script),
        budgetMs,
        'The in-page fetch',
      );
    }

    if (result === undefined || typeof result.status !== 'number') {
      // Defensive, and it earns its keep: the first version of this transport silently returned
      // undefined here (see buildInPageFetch), and without this guard the failure surfaced as an
      // unrelated TypeError instead of naming the layer that broke.
      throw new Error(
        'The in-page fetch returned nothing — the browser transport script is broken',
      );
    }

    return { status: result.status, contentType: result.contentType, text: result.text };
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

  /**
   * Seam for the unit spec: overriding one `await import` is what lets the challenge/replay/leak
   * behaviour be pinned without a 400 MB browser in CI. Nothing else about the class changes.
   */
  protected async loadChromium(): Promise<PlaywrightChromium> {
    return loadChromium();
  }

  private async launch(): Promise<PlaywrightPage> {
    const chromium = await this.loadChromium();
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

    // THE UA IS DERIVED FROM THIS BROWSER, WITH ONE WORD REMOVED. Read both halves before changing
    // it — the obvious "fixes" in either direction have each caused an outage.
    //
    // Setting a CONFIGURED UA (ICHANCY_USER_AGENT) was wrong: a Chrome 151 binary announcing Firefox
    // 153 makes the header, the TLS/JA3 fingerprint and the JS environment disagree, which is what
    // bot protection fingerprints for.
    //
    // Setting NO UA was also wrong, and worse. Playwright's headless build announces itself as
    // `HeadlessChrome/151.0.7922.34` — measured on 2026-08-20 — which is the loudest bot signal
    // there is. With that string the Turnstile challenge never handed over a clearance; with the
    // same binary announcing plain `Chrome`, the page cleared in 3.5 seconds.
    //
    // So: take Chromium's OWN User-Agent and delete only the word "Headless". Every version number
    // stays true to the binary, nothing is hardcoded to rot, and the one token that exists purely to
    // advertise automation is gone.
    const rawUserAgent = await this.readDefaultUserAgent(browser);
    const userAgent =
      rawUserAgent === null ? undefined : rawUserAgent.replace('HeadlessChrome', 'Chrome');
    if (rawUserAgent !== null && userAgent !== rawUserAgent) {
      this.logger.log(`Masking the headless marker in the User-Agent: ${String(userAgent)}`);
    }

    const context = await browser.newContext({
      ...(userAgent === undefined ? {} : { userAgent }),
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
    });

    // Everything after the launch can throw — `page.goto` inside solveChallenge most of all — and
    // until 2026-08-20 `this.browser` was assigned FIRST, so a throw left a live Chromium with
    // nothing referencing it and the next attempt simply overwrote the field. Under a 5-minute cron
    // that orphaned one browser every five minutes until the box ran out of memory.
    try {
      this.browser = browser;
      this.context = context;

      await this.seedPanelCookies(context);

      const page = await context.newPage();
      this.page = page;

      // Read, never assumed: this is the UA Cloudflare binds the clearance to, and the one
      // ichancy:check must print so an operator can compare it against a pasted cookie.
      this.chromiumUserAgent = await page.evaluate<string>('navigator.userAgent').catch(() => null);
      if (this.chromiumUserAgent !== null) {
        this.logger.log(`Chromium User-Agent: ${this.chromiumUserAgent}`);
      }

      await this.solveChallenge(page);
      return page;
    } catch (error: unknown) {
      this.browser = null;
      this.context = null;
      this.page = null;
      this.chromiumUserAgent = null;
      await browser.close().catch(() => undefined);
      throw error;
    }
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

    // WHY A REJECTED goto IS NOT A FAILURE HERE.
    //
    // Playwright rejects `goto` with net::ERR_ABORTED whenever a navigation is SUPERSEDED by
    // another one — and a superseding navigation is precisely what a Managed Challenge performs: it
    // serves the interstitial, runs its check, then reloads into the real page. The navigation we
    // asked for is cancelled by the one Cloudflare starts, so the call rejects in ~200ms while the
    // browser goes on to load the site perfectly well.
    //
    // Measured on 2026-08-20: once the headless fix let Cloudflare clear at boot, every later
    // re-warm logged `page.goto: net::ERR_ABORTED at https://agents.ichancy.com/` in 186-259ms and
    // surfaced as TRANSPORT_ERROR — a healthy browser failing calls over a navigation that had in
    // fact succeeded.
    //
    // So the rejection is swallowed and the loop below decides. That is not a weakened check: the
    // loop already treats the DOM as untrustworthy and waits for `cf_clearance` in the cookie jar,
    // which is the only thing that proves we may speak to the API. A genuine navigation failure
    // (DNS, connection refused, offline) never produces that cookie and still ends in the
    // CLOUDFLARE_CHALLENGE path below.
    try {
      await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: CHALLENGE_TIMEOUT_MS });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('ERR_ABORTED')) throw error;
      this.logger.debug(
        'Navigation was superseded (ERR_ABORTED) — normal during a challenge reload; ' +
          'waiting for the clearance cookie instead',
      );
    }

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
