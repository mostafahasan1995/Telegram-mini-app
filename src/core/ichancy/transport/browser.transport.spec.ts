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
import {
  BrowserIchancyTransport,
  looksBlocked,
  looksChallenged,
  resolveLoginSelectors,
  serializeCookieJar,
  sessionWorthPersisting,
} from './browser.transport';
import { type HarvestedCookies, type IchancyCookieStore } from './ichancy-cookie.store';
import { type IchancyTransportResponse } from './ichancy-transport';
import { basicAuthHeader, type ProxyRelay, type RelayUpstream } from './proxy-relay';

const CHALLENGE_HTML =
  '<html><head><title>Just a moment...</title></head><body>cf-browser-verification</body></html>';

/** Cloudflare's TERMINAL block page — never solvable, never replayed. */
const BLOCK_HTML =
  '<html><head><title>Attention Required! | Cloudflare</title></head>' +
  '<body>Sorry, you have been blocked</body></html>';

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
  readonly launchOptions: Record<string, unknown>[] = [];
  readonly fetchScripts: string[] = [];
  gotoCalls = 0;
  closeCalls = 0;
  /** URLs every `page.goto` saw, in order — a launch, a login, a replay each show up here. */
  readonly gotoCallsByUrl: string[] = [];
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
  /** What `page.content()` returns — solveChallenge reads it to spot a terminal block. Benign by default. */
  pageContent = '<html><body>agent panel</body></html>';
  /** The full jar the context reports. Defaults to a granted clearance, so a launch just clears. */
  cookieJar: { name: string; value: string }[] = [
    { name: 'cf_clearance', value: 'granted' },
  ];
  /** Cookies `addCookies` was asked to seed, for the resume-stored-session test. */
  readonly seededCookies: { name: string; value: string }[] = [];
  /** Selectors the fake page is willing to let `waitFor` succeed on. */
  knownSelectors: ReadonlySet<string> = new Set();
  /** Every `page.locator(...)` selector requested, in order. */
  readonly locatorCalls: string[] = [];
  /** `[selector, value]` from every `fill` on the login form. */
  readonly loginFills: [string, string][] = [];
  /** Every submit click. */
  readonly loginClicks: string[] = [];

  readonly chromium = {
    launch: (options?: Record<string, unknown>): Promise<unknown> => {
      this.launchOptions.push(options ?? {});
      return Promise.resolve(this.browser);
    },
  };

  private readonly page = {
    goto: (url?: string): Promise<unknown> => {
      this.gotoCalls += 1;
      this.gotoCallsByUrl.push(url ?? '');
      if (this.gotoThrows) return Promise.reject(new Error(this.gotoError));
      return Promise.resolve(null);
    },
    title: (): Promise<string> => Promise.resolve('Agent panel'),
    content: (): Promise<string> => Promise.resolve(this.pageContent),
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
    locator: (selector: string): {
      waitFor: (options?: { timeout?: number; state?: string }) => Promise<void>;
      fill: (value: string) => Promise<void>;
      click: () => Promise<void>;
    } => {
      this.locatorCalls.push(selector);
      return {
        waitFor: (): Promise<void> =>
          this.knownSelectors.has(selector)
            ? Promise.resolve()
            : Promise.reject(new Error(`locator("${selector}"): not visible`)),
        fill: (value: string): Promise<void> => {
          this.loginFills.push([selector, value]);
          return Promise.resolve();
        },
        click: (): Promise<void> => {
          this.loginClicks.push(selector);
          return Promise.resolve();
        },
      };
    },
  };

  private readonly context = {
    newPage: (): Promise<unknown> => Promise.resolve(this.page),
    cookies: (): Promise<{ name: string; value: string }[]> =>
      Promise.resolve(this.cookieJar.map((cookie) => ({ ...cookie }))),
    addCookies: (cookies: { name: string; value: string }[]): Promise<void> => {
      this.seededCookies.push(...cookies);
      return Promise.resolve();
    },
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

interface ProxyConfig {
  server: string;
  username: string | null;
  password: string | null;
}

/** Structural stand-in for IchancyCookieStore — the transport only needs read/write. */
class FakeCookieStore {
  stored: HarvestedCookies | null = null;
  readonly writes: HarvestedCookies[] = [];
  reads = 0;

  read = (): Promise<HarvestedCookies | null> => {
    this.reads += 1;
    return Promise.resolve(this.stored);
  };

  write = (value: HarvestedCookies): Promise<void> => {
    this.writes.push(value);
    this.stored = value;
    return Promise.resolve();
  };
}

/** The seam. Nothing else about the class changes. */
class TestableTransport extends BrowserIchancyTransport {
  /** The upstream the relay was asked to tunnel to, or null when no relay was started. */
  relayUpstream: RelayUpstream | null = null;
  relayCloseCalls = 0;
  /** The messages this transport logged, so a test can prove the proxy password never appears. */
  readonly logged: string[] = [];

  constructor(
    config: AppConfigService,
    private readonly harness: FakeHarness,
    cookieStore?: FakeCookieStore,
  ) {
    super(config, cookieStore as unknown as IchancyCookieStore | undefined);
    const sink = (message: unknown): void => {
      this.logged.push(String(message));
    };
    const logger = (this as unknown as { logger: Record<string, (m: unknown) => void> }).logger;
    logger.log = sink;
    logger.warn = sink;
    logger.error = sink;
    logger.debug = sink;
  }

  protected override loadChromium(): Promise<never> {
    return Promise.resolve(this.harness.chromium) as unknown as Promise<never>;
  }

  protected override startRelay(up: RelayUpstream): Promise<ProxyRelay> {
    this.relayUpstream = up;
    const relay: ProxyRelay = {
      port: 54321,
      close: () => {
        this.relayCloseCalls += 1;
      },
    };
    return Promise.resolve(relay);
  }
}

interface LoginOptions {
  url: string;
  username: string;
  password: string;
  userSelector?: string | null;
  passwordSelector?: string | null;
  submitSelector?: string | null;
}

function build(
  harness: FakeHarness,
  timeoutMs = 8_000,
  proxy: ProxyConfig | null = null,
  login: LoginOptions | null = null,
  cookieStore: FakeCookieStore | undefined = undefined,
): TestableTransport {
  const config = {
    ichancy: {
      baseUrl: 'https://agents.ichancy.com',
      browserHeadless: true,
      cookie: null,
      userAgent: CONFIGURED_UA,
      timeoutMs,
      proxy,
      loginUrl: login?.url ?? null,
      loginUsername: login?.username ?? null,
      loginPassword: login?.password ?? null,
      loginUserSelector: login?.userSelector ?? null,
      loginPasswordSelector: login?.passwordSelector ?? null,
      loginSubmitSelector: login?.submitSelector ?? null,
    },
  } as unknown as AppConfigService;
  return new TestableTransport(config, harness, cookieStore);
}

const post = (transport: TestableTransport, timeoutMs = 8_000): Promise<IchancyTransportResponse> =>
  transport.post({
    url: 'https://agents.ichancy.com/global-api/Player/registerPlayer',
    body: { player: { login: 'p1' } },
    accessToken: 'token',
    agentKey: 'agent-1',
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

describe('BrowserIchancyTransport — proxy egress', () => {
  const CREDS = { server: 'http://proxy.example:3128', username: 'exit', password: 's3cr3t!@:pass' };

  const launchProxy = (harness: FakeHarness): Record<string, unknown> | undefined =>
    harness.launchOptions[0]?.['proxy'] as Record<string, unknown> | undefined;

  it('unset: launches Chromium with NO proxy, exactly as before', async () => {
    const harness = new FakeHarness();
    harness.responses = [JSON_OK];
    const transport = build(harness, 8_000, null);

    await post(transport);

    expect(launchProxy(harness)).toBeUndefined();
    expect(transport.relayUpstream).toBeNull();
    expect(transport.describeTransport().proxy).toBeNull();
  });

  it('proxy WITHOUT credentials: passed straight to chromium.launch, no relay', async () => {
    const harness = new FakeHarness();
    harness.responses = [JSON_OK];
    const transport = build(harness, 8_000, {
      server: 'socks5://exit.example:1080',
      username: null,
      password: null,
    });

    await post(transport);

    expect(launchProxy(harness)).toEqual({ server: 'socks5://exit.example:1080' });
    // No relay for a credential-free proxy: Chromium handles it directly.
    expect(transport.relayUpstream).toBeNull();
    expect(transport.describeTransport().proxy).toBe('exit.example:1080');
  });

  it('proxy WITH credentials: starts the relay, launches Chromium at the local relay with NO auth', async () => {
    const harness = new FakeHarness();
    harness.responses = [JSON_OK];
    const transport = build(harness, 8_000, CREDS);

    await post(transport);

    // The relay was asked to tunnel to the real upstream, with the credentials as a pre-emptive
    // Basic header — the thing headless Chromium cannot do itself on the CONNECT.
    expect(transport.relayUpstream).toEqual({
      mode: 'http-connect',
      host: 'proxy.example',
      port: 3128,
      tls: false,
      auth: basicAuthHeader('exit', 's3cr3t!@:pass'),
      username: 'exit',
      password: 's3cr3t!@:pass',
    });
    // Chromium is pointed at the local relay, and NEVER given the username/password — that is the
    // whole point: the dead launch-proxy-auth path is not taken.
    const proxy = launchProxy(harness);
    expect(proxy).toEqual({ server: 'http://127.0.0.1:54321' });
    expect(proxy).not.toHaveProperty('username');
    expect(proxy).not.toHaveProperty('password');
    expect(transport.describeTransport().proxy).toBe('proxy.example:3128');
  });

  it('an https proxy relays over TLS', async () => {
    const harness = new FakeHarness();
    harness.responses = [JSON_OK];
    const transport = build(harness, 8_000, {
      server: 'https://secure-proxy.example:8443',
      username: 'u',
      password: 'p',
    });

    await post(transport);

    expect(transport.relayUpstream?.tls).toBe(true);
    expect(transport.relayUpstream?.port).toBe(8443);
  });

  it('a CREDENTIALED socks5 proxy goes through the relay (RFC 1929), never straight to Chromium', async () => {
    // Chromium has zero SOCKS5 authentication support; a credentialed `socks5://` must be handled
    // by the relay or it dies with ERR_PROXY_CONNECTION_FAILED on the Indian residential egress.
    const harness = new FakeHarness();
    harness.responses = [JSON_OK];
    const transport = build(harness, 8_000, {
      server: 'socks5://exit.example:1080',
      username: 'res',
      password: 'k3y',
    });

    await post(transport);

    expect(transport.relayUpstream).toEqual({
      mode: 'socks5',
      host: 'exit.example',
      port: 1080,
      tls: false,
      auth: '',
      username: 'res',
      password: 'k3y',
    });
    const proxy = launchProxy(harness);
    expect(proxy).toEqual({ server: 'http://127.0.0.1:54321' });
    expect(proxy).not.toHaveProperty('username');
    expect(proxy).not.toHaveProperty('password');
    expect(transport.logged.join(' ')).toContain('proxy exit.example:1080 via local relay');
  });

  it('NEVER prints the proxy password — not in describeTransport, not in any log', async () => {
    const harness = new FakeHarness();
    harness.responses = [JSON_OK];
    const transport = build(harness, 8_000, CREDS);

    await post(transport);

    const described = JSON.stringify(transport.describeTransport());
    expect(described).not.toContain(CREDS.password);
    expect(described).toContain('proxy.example:3128');
    for (const line of transport.logged) expect(line).not.toContain(CREDS.password);
    // The egress WAS announced, host:port only, and said it goes via the relay.
    expect(transport.logged.join(' ')).toContain('proxy proxy.example:3128 via local relay');
  });

  it('closes the relay when the browser is discarded', async () => {
    const harness = new FakeHarness();
    harness.responses = [JSON_OK];
    const transport = build(harness, 8_000, CREDS);

    await post(transport);
    await transport.onModuleDestroy();

    expect(transport.relayCloseCalls).toBe(1);
  });
});

describe('BrowserIchancyTransport — Cloudflare BLOCK vs challenge', () => {
  it('returns a BLOCK response without replaying, and records the origin as blocked', async () => {
    // A terminal block must NOT be re-solved or replayed: re-navigating cannot clear a reputation
    // block, and replaying registerPlayer risks an undeletable second account for nothing.
    const harness = new FakeHarness();
    harness.responses = [{ status: 403, contentType: 'text/html; charset=UTF-8', text: BLOCK_HTML }];
    const transport = build(harness);

    const response = await post(transport);

    expect(response.status).toBe(403);
    expect(harness.fetchScripts).toHaveLength(1); // no replay
    expect(harness.gotoCalls).toBe(1); // one navigation for the launch, no re-solve
    expect(transport.describeTransport().lastOriginState).toBe('blocked');
  });

  it('a BLOCK page at solve time bails immediately instead of polling the challenge for 45s', async () => {
    // Regression guard for the live bug: the block page's title ("Attention Required!") is NOT in
    // CHALLENGE_TITLES, so without the content-level block detector the solver treated it as
    // "cleared", never saw cf_clearance, and burned the full 45s. This test would TIME OUT (jest's
    // 5s default) if the poll ran; it passes fast because the solver bails on the block marker.
    const harness = new FakeHarness();
    harness.pageContent = BLOCK_HTML; // the origin serves the block page during the solve
    harness.cookieJar = [{ name: 'cf_clearance', value: '' }]; // and no clearance is ever granted
    harness.responses = [{ status: 403, contentType: 'text/html', text: BLOCK_HTML }];
    const transport = build(harness);

    const response = await post(transport);

    expect(response.status).toBe(403);
    expect(transport.describeTransport().lastOriginState).toBe('blocked');
  });

  it('still re-solves and replays a GENUINE "just a moment" challenge', async () => {
    // The block detector must not eat solvable challenges: this is the case that keeps working.
    const harness = new FakeHarness();
    harness.responses = [
      { status: 403, contentType: 'text/html; charset=UTF-8', text: CHALLENGE_HTML },
      JSON_OK,
    ];
    const transport = build(harness);

    const response = await post(transport);

    expect(response.status).toBe(200);
    expect(harness.fetchScripts).toHaveLength(2); // re-solved and replayed once
    expect(harness.gotoCalls).toBe(2);
  });

  it('looksBlocked agrees with the error map, and a block is not a challenge', () => {
    const block: IchancyTransportResponse = {
      status: 403,
      contentType: 'text/html',
      text: BLOCK_HTML,
    };
    expect(looksBlocked(block)).toBe(true);
    expect(looksChallenged(block)).toBe(false); // block wins over challenge
    expect(looksBlocked({ status: 403, contentType: 'application/json', text: '{}' })).toBe(false);
    expect(looksBlocked({ status: 200, contentType: 'text/html', text: BLOCK_HTML })).toBe(false);
  });

  describe('session persistence', () => {
    it('serializes a cookie jar into a Cookie header, dropping empty pairs', () => {
      expect(
        serializeCookieJar([
          { name: 'PHPSESSID', value: 'abc123' },
          { name: 'cf_clearance', value: 'granted' },
        ]),
      ).toBe('PHPSESSID=abc123; cf_clearance=granted');
      expect(
        serializeCookieJar([
          { name: 'empty', value: '' },
          { name: '', value: 'orphan' },
        ]),
      ).toBe('');
    });

    it('resolves the stock login selectors, and an override always wins', () => {
      expect(resolveLoginSelectors({})).toEqual({
        user: expect.stringContaining('name="username"'),
        password: 'input[type="password"]',
        submit: expect.stringContaining('button[type="submit"]'),
      });
      const override = resolveLoginSelectors({
        user: 'input#agent_email',
        password: 'input#agent_secret',
        submit: 'button.topbar-login',
      });
      expect(override).toEqual({
        user: 'input#agent_email',
        password: 'input#agent_secret',
        submit: 'button.topbar-login',
      });
    });

    it('only persists a jar that actually carries a cf_clearance', () => {
      expect(sessionWorthPersisting([{ name: 'cf_clearance', value: 'granted' }])).toBe(true);
      expect(sessionWorthPersisting([{ name: 'cf_clearance', value: '' }])).toBe(false);
      expect(sessionWorthPersisting([{ name: 'PHPSESSID', value: 'abc123' }])).toBe(false);
    });

    it('fills the configured login form after the solve, then persists the full session', async () => {
      const harness = new FakeHarness();
      // A real context reports what it ANNOUNCED, i.e. the masked UA; Cloudflare binds the clearance
      // to that string, so it is the one the harvest must carry.
      harness.reportedUserAgent = HEADLESS_UA.replace('HeadlessChrome', 'Chrome');
      harness.cookieJar = [
        { name: 'cf_clearance', value: 'granted' },
        { name: 'PHPSESSID', value: 'panel-session-42' },
      ];
      const selectors = resolveLoginSelectors({});
      harness.knownSelectors = new Set([selectors.user, selectors.password, selectors.submit]);
      harness.responses = [JSON_OK];
      const store = new FakeCookieStore();
      const transport = build(
        harness,
        8_000,
        null,
        { url: 'https://agents.ichancy.com/login', username: 'cd', password: 'secret' },
        store,
      );

      const response = await post(transport);

      expect(response.status).toBe(200);
      // The login navigated to ICHANCY_LOGIN_URL after the origin solve (two gotos total).
      expect(harness.gotoCallsByUrl).toContain('https://agents.ichancy.com/login');
      // Credentials went into the RESOLVED stock selectors.
      expect(harness.loginFills).toContainEqual([selectors.user, 'cd']);
      expect(harness.loginFills).toContainEqual([selectors.password, 'secret']);
      expect(harness.loginClicks).toContain(selectors.submit);
      // The persisted harvest carries the whole jar (clearance + panel session) and the masked UA.
      expect(store.writes).toHaveLength(1);
      const harvest = store.writes[0];
      expect(harvest).toBeDefined();
      expect(harvest?.cookie).toContain('cf_clearance=granted');
      expect(harvest?.cookie).toContain('PHPSESSID=panel-session-42');
      expect(harvest?.userAgent).toBe(HEADLESS_UA.replace('HeadlessChrome', 'Chrome'));
      // Nothing about the password or the cookie VALUES may reach the logs.
      const joined = transport.logged.join('\n');
      expect(joined.toLowerCase()).not.toContain('secret');
      expect(joined).not.toContain('panel-session-42');
    });

    it('does nothing DOM-shaped when the login is not configured', async () => {
      const harness = new FakeHarness();
      harness.responses = [JSON_OK];
      const transport = build(harness);

      const response = await post(transport);

      expect(response.status).toBe(200);
      expect(harness.locatorCalls).toHaveLength(0);
      expect(harness.gotoCallsByUrl).toHaveLength(1); // origin solve only, no login page
    });

    it('resumes a stored session into the context, minus the Cloudflare-owned cookies', async () => {
      const harness = new FakeHarness();
      harness.responses = [JSON_OK];
      const store = new FakeCookieStore();
      store.stored = {
        cookie: 'PHPSESSID=resumed-77; cf_clearance=STALE-CANNOT-BE-SEEDED',
        userAgent: HEADLESS_UA.replace('HeadlessChrome', 'Chrome'),
        harvestedAt: new Date().toISOString(),
      };
      const transport = build(harness, 8_000, null, null, store);

      const response = await post(transport);

      expect(response.status).toBe(200);
      const names = harness.seededCookies.map((cookie) => cookie.name);
      expect(names).toContain('PHPSESSID'); // panel session survives the restart
      expect(names).not.toContain('cf_clearance'); // the browser must re-earn its own
    });

    it('fails OPEN when the login form is missing, and never bricks the call', async () => {
      const harness = new FakeHarness();
      // No selectors are "known" to the fake page, so waitFor rejects at the first locator.
      harness.responses = [JSON_OK];
      const store = new FakeCookieStore();
      // The store is empty, so the only observable state is: the call still goes through.
      const transport = build(
        harness,
        8_000,
        null,
        { url: 'https://agents.ichancy.com/login', username: 'cd', password: 'secret' },
        store,
      );

      const response = await post(transport);

      expect(response.status).toBe(200); // login failed, the POST did not
      expect(transport.logged.join('\n')).toContain('did not complete');
    });
  });
});
