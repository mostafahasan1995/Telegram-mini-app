/**
 * The harvester and the fetch transport's use of it, without a browser or a Redis.
 *
 * Pinned here because each of these cost hours to find on 2026-08-19/20 and none of them announce
 * themselves when they break:
 *
 *  1. The harvested User-Agent travels WITH the cookie. Cloudflare binds a clearance to the browser
 *     that earned it; sending it under ICHANCY_USER_AGENT fails exactly as if no cookie were sent.
 *  2. A challenge triggers ONE refresh and ONE replay — never a loop.
 *  3. A harvest that produced no cf_clearance is a FAILURE, not a success with fewer cookies.
 *  4. Duplicate cookie names are collapsed: Cloudflare issues cf_clearance for both the apex and the
 *     subdomain, and a header carrying it twice is malformed.
 */
import { type AppConfigService } from '@core/config/config.service';

import { CookieHarvesterService } from './cookie-harvester.service';
import { FetchIchancyTransport } from './fetch.transport';
import { type HarvestedCookies, type IchancyCookieStore } from './ichancy-cookie.store';

const HARVESTED_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/151.0.0.0 Safari/537.36';
const CONFIGURED_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Firefox/153.0';

const CHALLENGE_BODY =
  '<html><head><title>Just a moment...</title></head><body>cf-browser-verification</body></html>';
const JSON_BODY = '{"status":true,"result":1,"notification":[]}';

const HARVEST: HarvestedCookies = {
  cookie: 'cf_clearance=abc; __cf_bm=def; PHPSESSID_x=ghi',
  userAgent: HARVESTED_UA,
  harvestedAt: '2026-08-20T10:00:00.000Z',
};

function configFor(cookieHarvest: boolean): AppConfigService {
  return {
    ichancy: {
      baseUrl: 'https://agents.ichancy.com',
      userAgent: CONFIGURED_UA,
      cookie: null,
      cookieHarvest,
      cookieProfileDir: '/tmp/profile',
      timeoutMs: 8_000,
    },
    app: { isWorker: true },
  } as unknown as AppConfigService;
}

/** Captures what each fetch was called with, and answers from a scripted queue. */
function stubFetch(responses: { status: number; body: string; contentType: string }[]) {
  const calls: { headers: Record<string, string> }[] = [];
  const impl = jest.fn((_url: string, init: { headers: Record<string, string> }) => {
    calls.push({ headers: init.headers });
    const next = responses.shift();
    if (next === undefined) throw new Error('the stub ran out of scripted responses');
    return Promise.resolve({
      status: next.status,
      headers: {
        get: (name: string) => (name === 'content-type' ? next.contentType : null),
        getSetCookie: () => [],
      },
      text: () => Promise.resolve(next.body),
    });
  });
  return { impl, calls };
}

describe('the harvested clearance reaches the wire', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('sends the harvested cookie AND its User-Agent, never the configured one', async () => {
    const { impl, calls } = stubFetch([
      { status: 200, body: JSON_BODY, contentType: 'application/json' },
    ]);
    globalThis.fetch = impl as unknown as typeof fetch;

    const store = { read: jest.fn().mockResolvedValue(HARVEST) } as unknown as IchancyCookieStore;
    const harvester = { harvest: jest.fn() } as unknown as CookieHarvesterService;
    const transport = new FetchIchancyTransport(configFor(true), store, harvester);

    await transport.post({ url: 'https://x/y', body: {}, accessToken: null, timeoutMs: 8_000 });

    expect(calls[0]?.headers['cookie']).toBe(HARVEST.cookie);
    // The pair must not be split — this is the mismatch that caused two outages.
    expect(calls[0]?.headers['user-agent']).toBe(HARVESTED_UA);
    expect(calls[0]?.headers['user-agent']).not.toBe(CONFIGURED_UA);
  });

  it('falls back to ICHANCY_USER_AGENT when harvesting is off', async () => {
    const { impl, calls } = stubFetch([
      { status: 200, body: JSON_BODY, contentType: 'application/json' },
    ]);
    globalThis.fetch = impl as unknown as typeof fetch;

    const read = jest.fn();
    const store = { read } as unknown as IchancyCookieStore;
    const harvester = { harvest: jest.fn() } as unknown as CookieHarvesterService;
    const transport = new FetchIchancyTransport(configFor(false), store, harvester);

    await transport.post({ url: 'https://x/y', body: {}, accessToken: null, timeoutMs: 8_000 });

    expect(calls[0]?.headers['user-agent']).toBe(CONFIGURED_UA);
    // Redis is not even consulted when the feature is off.
    expect(read).not.toHaveBeenCalled();
  });

  it('refreshes once on a challenge and replays the call exactly once', async () => {
    const { impl, calls } = stubFetch([
      { status: 403, body: CHALLENGE_BODY, contentType: 'text/html' },
      { status: 200, body: JSON_BODY, contentType: 'application/json' },
    ]);
    globalThis.fetch = impl as unknown as typeof fetch;

    const store = { read: jest.fn().mockResolvedValue(HARVEST) } as unknown as IchancyCookieStore;
    const harvest = jest.fn().mockResolvedValue(HARVEST);
    const transport = new FetchIchancyTransport(
      configFor(true),
      {
        ...store,
      } as unknown as IchancyCookieStore,
      { harvest } as unknown as CookieHarvesterService,
    );

    const result = await transport.post({
      url: 'https://x/y',
      body: {},
      accessToken: null,
      timeoutMs: 8_000,
    });

    // Replaying a CHALLENGE is safe: Cloudflare's edge answered, so the request never reached
    // Ichancy and nothing was registered. Exactly one retry, never a loop.
    expect(harvest).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(result.status).toBe(200);
  });

  it('gives up after one retry rather than looping when the harvest cannot help', async () => {
    const { impl, calls } = stubFetch([
      { status: 403, body: CHALLENGE_BODY, contentType: 'text/html' },
    ]);
    globalThis.fetch = impl as unknown as typeof fetch;

    const store = { read: jest.fn().mockResolvedValue(null) } as unknown as IchancyCookieStore;
    const harvest = jest.fn().mockResolvedValue(null); // harvest failed or is disabled
    const transport = new FetchIchancyTransport(configFor(true), store, {
      harvest,
    } as unknown as CookieHarvesterService);

    const result = await transport.post({
      url: 'https://x/y',
      body: {},
      accessToken: null,
      timeoutMs: 8_000,
    });

    expect(calls).toHaveLength(1);
    expect(result.status).toBe(403);
  });
});

describe('CookieHarvesterService', () => {
  /** Enough of a fake browser to exercise the harvest without launching one. */
  class FakeHarvester extends CookieHarvesterService {
    cookies: { name: string; value: string }[] = [
      { name: 'cf_clearance', value: 'apex' },
      { name: 'cf_clearance', value: 'subdomain' },
      { name: '__cf_bm', value: 'bm' },
    ];
    title = 'ichancy.com';

    protected override loadChromium(): Promise<never> {
      const context = {
        pages: () => [
          {
            goto: () => Promise.resolve(null),
            title: () => Promise.resolve(this.title),
            evaluate: () => Promise.resolve(HARVESTED_UA),
          },
        ],
        newPage: () => Promise.reject(new Error('unused')),
        cookies: () => Promise.resolve(this.cookies),
        close: () => Promise.resolve(),
      };
      return Promise.resolve({
        launchPersistentContext: () => Promise.resolve(context),
      }) as unknown as Promise<never>;
    }
  }

  const lockGranted = {
    acquire: jest.fn().mockResolvedValue({ key: 'k', token: 't', acquiredAt: 0, ttlMs: 0 }),
    release: jest.fn().mockResolvedValue(true),
  };

  function build(store: IchancyCookieStore): FakeHarvester {
    return new FakeHarvester(configFor(true), store, lockGranted as never);
  }

  it('collapses duplicate cookie names into a well-formed header', async () => {
    // Cloudflare sets cf_clearance for BOTH the apex and the subdomain; a header naming it twice is
    // malformed, and this transport was sending exactly that during the investigation.
    const written: HarvestedCookies[] = [];
    const store = {
      read: jest.fn(),
      write: jest.fn((v: HarvestedCookies) => {
        written.push(v);
        return Promise.resolve();
      }),
    } as unknown as IchancyCookieStore;

    const result = await build(store).harvest();

    expect(result).not.toBeNull();
    expect(result?.cookie.match(/cf_clearance=/g)).toHaveLength(1);
    expect(result?.userAgent).toBe(HARVESTED_UA);
    expect(written).toHaveLength(1);
  });

  it('treats a harvest with no cf_clearance as a failure, not a thin success', async () => {
    // A jar without a clearance looks like a result and is worthless: every call using it is
    // challenged, and the store would serve it for its full TTL.
    const write = jest.fn();
    const store = { read: jest.fn(), write } as unknown as IchancyCookieStore;
    const harvester = build(store);
    harvester.cookies = [{ name: '__cf_bm', value: 'bm' }];

    expect(await harvester.harvest()).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it('does nothing at all when the feature is off', async () => {
    const write = jest.fn();
    const store = { read: jest.fn(), write } as unknown as IchancyCookieStore;
    const harvester = new FakeHarvester(configFor(false), store, lockGranted as never);

    expect(await harvester.harvest()).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });
});
