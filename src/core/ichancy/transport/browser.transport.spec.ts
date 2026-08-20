/**
 * The browser transport, without a browser.
 *
 * `loadChromium` is a protected method precisely so this file can substitute a fake Playwright and
 * pin the four behaviours that cost real money if they regress:
 *
 *  1. The context announces Chromium's OWN User-Agent with the word "Headless" removed. Stamping
 *     ICHANCY_USER_AGENT over it is half of the 2026-08-20 outage carried into browser mode (a
 *     Chrome binary announcing Firefox 153); leaving the raw string is the other half, because
 *     `HeadlessChrome` is the loudest bot signal there is and Turnstile never released a clearance
 *     under it.
 *  2. A Cloudflare challenge is re-solved and replayed EXACTLY once.
 *  3. Anything that is NOT a Cloudflare challenge is never replayed. The call being replayed can be
 *     `registerPlayer`, which is not idempotent and whose duplicate cannot be deleted.
 *  4. A wedged page gives the caller control back, as a TimeoutError the error map recognises.
 *
 * Plus the leak: a throwing challenge must close its browser, not orphan one every five minutes.
 */
import { type AppConfigService } from '@core/config/config.service';

import { classifyTransportFailure } from '../error-map';
import { BrowserIchancyTransport, looksChallenged } from './browser.transport';
import { type IchancyTransportResponse } from './ichancy-transport';

const CHALLENGE_HTML =
  '<html><head><title>Just a moment...</title></head><body>cf-browser-verification</body></html>';

interface FakeResponse {
  status: number;
  contentType: string | null;
  text: string;
}

/** The Firefox string from the owner's .env on the day of the incident. */
const CONFIGURED_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0';
/**
 * What Playwright's HEADLESS build really announces — measured on 2026-08-20. The `Headless` token
 * is the loudest automation signal a browser can send, and with it present the Turnstile challenge
 * never handed over a clearance.
 */
const HEADLESS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'HeadlessChrome/151.0.7922.34 Safari/537.36';

class FakeHarness {
  readonly newContextOptions: Record<string, unknown>[] = [];
  readonly fetchScripts: string[] = [];
  gotoCalls = 0;
  closeCalls = 0;
  /** Queue of answers the in-page fetch returns, in order. */
  responses: FakeResponse[] = [];
  /** When set, the next `page.evaluate` of a fetch never settles. */
  hangForever = false;
  /** When set, the next in-page fetch rejects as if Chromium had died. */
  browserDies = false;
  /** When set, `page.goto` throws — the leak scenario. */
  gotoThrows = false;
  /** What `page.goto` rejects with when [gotoThrows] is set. */
  gotoError = 'net::ERR_CONNECTION_RESET';
  /** What navigator.userAgent reports inside the fake page. */
  reportedUserAgent = HEADLESS_UA;
  /** Cookies the "context" reports; a cf_clearance is what solveChallenge waits for. */
  clearance = 'granted';

  readonly chromium = {
    launch: (): Promise<unknown> => Promise.resolve(this.browser),
  };

  private readonly page = {
    goto: (): Promise<unknown> => {
      this.gotoCalls += 1;
      if (this.gotoThrows) return Promise.reject(new Error(this.gotoError));
      return Promise.resolve(null);
    },
    title: (): Promise<string> => Promise.resolve('Agent panel'),
    isClosed: (): boolean => false,
    evaluate: (script: string): Promise<unknown> => {
      if (script === 'navigator.userAgent') return Promise.resolve(this.reportedUserAgent);
      this.fetchScripts.push(script);
      if (this.hangForever) return new Promise<never>(() => undefined);
      if (this.browserDies) {
        this.browserDies = false;
        return Promise.reject(
          new Error('page.evaluate: Target page, context or browser has been closed'),
        );
      }
      const next = this.responses.shift();
      if (next === undefined) throw new Error('the fake ran out of scripted responses');
      return Promise.resolve(next);
    },
  };

  private readonly context = {
    newPage: (): Promise<unknown> => Promise.resolve(this.page),
    cookies: (): Promise<{ name: string; value: string }[]> =>
      Promise.resolve([{ name: 'cf_clearance', value: this.clearance }]),
    addCookies: (): Promise<void> => Promise.resolve(),
    // The UA probe opens a throwaway context and closes it; without this the probe throws, falls
    // back to "no override", and the headless marker silently survives.
    close: (): Promise<void> => Promise.resolve(),
  };

  private readonly browser = {
    newContext: (options?: Record<string, unknown>): Promise<unknown> => {
      this.newContextOptions.push(options ?? {});
      return Promise.resolve(this.context);
    },
    close: (): Promise<void> => {
      this.closeCalls += 1;
      return Promise.resolve();
    },
    isConnected: (): boolean => true,
  };
}

/** The seam. Nothing else about the class changes. */
class TestableTransport extends BrowserIchancyTransport {
  constructor(
    config: AppConfigService,
    private readonly harness: FakeHarness,
  ) {
    super(config);
  }

  protected override loadChromium(): Promise<never> {
    return Promise.resolve(this.harness.chromium) as unknown as Promise<never>;
  }
}

function build(harness: FakeHarness, timeoutMs = 8_000): TestableTransport {
  const config = {
    ichancy: {
      baseUrl: 'https://agents.ichancy.com',
      browserHeadless: true,
      cookie: null,
      userAgent: CONFIGURED_UA,
      timeoutMs,
    },
  } as unknown as AppConfigService;
  return new TestableTransport(config, harness);
}

const post = (transport: TestableTransport, timeoutMs = 8_000): Promise<IchancyTransportResponse> =>
  transport.post({
    url: 'https://agents.ichancy.com/global-api/Player/registerPlayer',
    body: { player: { login: 'p1' } },
    accessToken: 'token',
    timeoutMs,
  });

const JSON_OK: FakeResponse = {
  status: 200,
  contentType: 'application/json',
  text: '{"status":true,"result":1,"notification":[]}',
};

describe('BrowserIchancyTransport', () => {
  it('announces Chromium’s own User-Agent with the headless marker stripped', async () => {
    // BOTH halves of this are regression guards, and they pull in opposite directions:
    //
    //   * NEVER the configured UA. A Chrome binary announcing Firefox 153 makes the header, the TLS
    //     fingerprint and the JS environment disagree — that mismatch is what bot protection reads.
    //   * NEVER the raw headless string either. Playwright's headless build says `HeadlessChrome`,
    //     and measured on 2026-08-20 the Turnstile challenge never released a clearance under it,
    //     while the same binary announcing plain `Chrome` cleared in 3.5 seconds.
    //
    // The only value satisfying both is this browser's real UA minus the word "Headless".
    const harness = new FakeHarness();
    harness.responses = [JSON_OK];
    const transport = build(harness);

    await post(transport);

    const announced = harness.newContextOptions
      .map((options) => options['userAgent'])
      .filter((ua): ua is string => typeof ua === 'string');

    // Same string the browser reported, minus one word — every version number stays true to the
    // binary, so nothing here rots when Chromium is upgraded.
    expect(announced).toContain(HEADLESS_UA.replace('HeadlessChrome', 'Chrome'));
    for (const ua of announced) {
      expect(ua).not.toContain('Headless');
      expect(ua).not.toContain('Firefox');
    }
  });

  it('re-solves and replays a Cloudflare challenge exactly once', async () => {
    const harness = new FakeHarness();
    harness.responses = [
      { status: 403, contentType: 'text/html; charset=UTF-8', text: CHALLENGE_HTML },
      JSON_OK,
    ];
    const transport = build(harness);

    const response = await post(transport);

    expect(response.status).toBe(200);
    expect(harness.fetchScripts).toHaveLength(2);
    // One navigation for the launch, one for the re-solve. Not three.
    expect(harness.gotoCalls).toBe(2);
  });

  it('does NOT replay a 403 that carries a JSON body', async () => {
    // JSON on any status is Ichancy talking, so replaying it would be re-sending a call their
    // application already saw — and for registerPlayer that means a second, undeletable account.
    const harness = new FakeHarness();
    harness.responses = [
      { status: 403, contentType: 'application/json', text: '{"status":false,"result":false}' },
    ];
    const transport = build(harness);

    const response = await post(transport);

    expect(response.status).toBe(403);
    expect(harness.fetchScripts).toHaveLength(1);
    expect(harness.gotoCalls).toBe(1);
  });

  it('does NOT replay a 403 with a null content-type and a non-Cloudflare body', async () => {
    // The old local predicate read `contentType?.includes(...) !== true`, so `undefined !== true`
    // made a MISSING content-type look like a challenge. A genuine origin 403 with an empty body
    // therefore earned a blind retry of whatever call produced it.
    const harness = new FakeHarness();
    harness.responses = [{ status: 403, contentType: null, text: 'Forbidden' }];
    const transport = build(harness);

    const response = await post(transport);

    expect(response.status).toBe(403);
    expect(harness.fetchScripts).toHaveLength(1);
  });

  it('agrees with the error map about what a challenge is', () => {
    expect(looksChallenged({ status: 403, contentType: 'text/html', text: CHALLENGE_HTML })).toBe(
      true,
    );
    expect(looksChallenged({ status: 403, contentType: 'application/json', text: '{}' })).toBe(
      false,
    );
    expect(looksChallenged({ status: 403, contentType: null, text: 'Forbidden' })).toBe(false);
    expect(looksChallenged({ status: 200, contentType: 'text/html', text: CHALLENGE_HTML })).toBe(
      false,
    );
  });

  it('gives the caller control back on a wedged page, as a TIMEOUT the error map recognises', async () => {
    // ICHANCY_TIMEOUT_MS was silently dropped by this transport until 2026-08-20, so
    // IchancyOutcome.TIMEOUT was unreachable and one hung page blocked a caller forever — under a
    // five-minute cron, ticks pile up behind it.
    const harness = new FakeHarness();
    harness.hangForever = true;
    const transport = build(harness, 20);

    const error = await post(transport, 20).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('TimeoutError');
    expect(classifyTransportFailure(error).rule).toBe('TIMEOUT');
  });

  it('bakes the call budget into the in-page fetch as well', async () => {
    const harness = new FakeHarness();
    harness.responses = [JSON_OK];
    const transport = build(harness);

    await post(transport, 4_321);

    expect(harness.fetchScripts[0]).toContain('AbortSignal.timeout(input.timeoutMs)');
    expect(harness.fetchScripts[0]).toContain('"timeoutMs":4321');
  });

  it('closes the browser when the challenge throws, instead of orphaning one', async () => {
    // `launch()` used to assign `this.browser` BEFORE solveChallenge, whose page.goto is not
    // wrapped. A throw left a live Chromium with nothing referencing it and the next attempt simply
    // overwrote the field — one leaked browser every five minutes under the cron.
    const harness = new FakeHarness();
    harness.gotoThrows = true;
    const transport = build(harness);

    await expect(post(transport)).rejects.toThrow('ERR_CONNECTION_RESET');
    expect(harness.closeCalls).toBe(1);

    // …and the next call relaunches cleanly rather than reusing a dead handle.
    harness.gotoThrows = false;
    harness.responses = [JSON_OK];
    await expect(post(transport)).resolves.toMatchObject({ status: 200 });
    expect(harness.closeCalls).toBe(1);
  });

  it('treats a SUPERSEDED navigation (ERR_ABORTED) as success, not a transport failure', async () => {
    // THE 2026-08-20 REGRESSION. A Managed Challenge navigates away from the page we asked for —
    // interstitial, check, reload into the real site — and Playwright reports that supersession by
    // rejecting goto with net::ERR_ABORTED, in ~200ms, on a browser that then loads the site fine.
    // Treating it as fatal turned every re-warm into TRANSPORT_ERROR while Chromium was healthy.
    // The clearance cookie, not the navigation promise, is what says we may talk to the API.
    const harness = new FakeHarness();
    harness.gotoThrows = true;
    harness.gotoError = 'page.goto: net::ERR_ABORTED at https://agents.ichancy.com/';
    harness.responses = [JSON_OK];
    const transport = build(harness);

    await expect(post(transport)).resolves.toMatchObject({ status: 200 });
    // The browser must NOT be torn down: it is working.
    expect(harness.closeCalls).toBe(0);
  });

  it('still fails, and still closes the browser, when the navigation genuinely failed', async () => {
    // The counterpart to the test above: swallowing ERR_ABORTED must not swallow a real failure.
    // DNS, refused and offline all reject with something else and must stay fatal.
    for (const real of ['net::ERR_CONNECTION_REFUSED', 'net::ERR_NAME_NOT_RESOLVED']) {
      const harness = new FakeHarness();
      harness.gotoThrows = true;
      harness.gotoError = real;
      const transport = build(harness);

      await expect(post(transport)).rejects.toThrow(real);
      expect(harness.closeCalls).toBe(1);
    }
  });
});

describe('when Chromium dies mid-call', () => {
  /**
   * Observed live on 2026-08-20: "Target page, context or browser has been closed", 47s into a
   * wallet read, on a box already running the api, the worker, ngrok and another Chromium.
   */
  it('does NOT replay the request — a dead browser proves nothing about what reached Ichancy', async () => {
    const harness = new FakeHarness();
    harness.browserDies = true;
    harness.responses = [JSON_OK];
    const transport = build(harness);

    await expect(post(transport)).rejects.toThrow(
      /Target page, context or browser has been closed/,
    );

    // THE POINT: no second fetch was issued. A challenge is safe to replay because the edge's 403
    // proves the origin never saw it; a dead browser gives no such proof, and the in-page fetch may
    // already have registered a player or moved money. Rethrowing makes the call `ambiguous`, which
    // the credit path resolves with a balance re-read instead of a second depositToPlayer.
    expect(harness.fetchScripts).toHaveLength(1);
    expect(harness.responses).toHaveLength(1);
  });

  it('discards the corpse so the next call relaunches instead of evaluating against a dead target', async () => {
    const harness = new FakeHarness();
    harness.browserDies = true;
    harness.responses = [JSON_OK];
    const transport = build(harness);

    await expect(post(transport)).rejects.toThrow();
    const launchesAfterDeath = harness.gotoCalls;

    // The second call must stand a browser back up. Before this fix nothing cleared the dead
    // references, and isClosed()/isConnected() keep reporting a browser that died a moment ago as
    // alive — so every later call failed the same way.
    const recovered = await post(transport);
    expect(recovered.status).toBe(200);
    expect(harness.gotoCalls).toBeGreaterThan(launchesAfterDeath);
    expect(harness.closeCalls).toBeGreaterThan(0);
  });
});
