/**
 * The fetch transport's PROXY wiring: when ICHANCY_PROXY_URL is set, the egress must leave through
 * an undici ProxyAgent (undici authenticates to the proxy from the URL — no relay needed here),
 * sharing the trusted exit IP the browser transport uses; when it is unset, fetch is called exactly
 * as before, with no dispatcher.
 */
import { type AppConfigService } from '@core/config/config.service';

import { ProxyAgent } from 'undici';

import { type CookieHarvesterService } from './cookie-harvester.service';
import { FetchIchancyTransport } from './fetch.transport';
import { type IchancyCookieStore } from './ichancy-cookie.store';
import { type IchancyTransportRequest } from './ichancy-transport';

interface ProxyConfig {
  server: string;
  username: string | null;
  password: string | null;
}

function build(proxy: ProxyConfig | null): FetchIchancyTransport {
  const config = {
    ichancy: {
      baseUrl: 'https://agents.ichancy.com',
      cookie: null,
      cookieHarvest: false,
      userAgent: 'UA/1.0',
      proxy,
    },
  } as unknown as AppConfigService;
  const store = { read: () => Promise.resolve(null) } as unknown as IchancyCookieStore;
  const harvester = { harvest: () => Promise.resolve(null) } as unknown as CookieHarvesterService;
  return new FetchIchancyTransport(config, store, harvester);
}

const REQUEST: IchancyTransportRequest = {
  url: 'https://agents.ichancy.com/global/api/UserApi/signin',
  body: { username: 'probe@example.invalid', password: 'not-a-real-password' },
  accessToken: null,
  timeoutMs: 8_000,
  agentKey: 'agent-1',
};

/** A minimal JSON Response — enough for the transport to read status, content-type, cookies, text. */
function jsonResponse(): Response {
  return {
    status: 401,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      getSetCookie: () => [] as string[],
    },
    text: () =>
      Promise.resolve('{"status":true,"result":false,"content":"Invalid username or password."}'),
  } as unknown as Response;
}

describe('FetchIchancyTransport — proxy egress', () => {
  const dispatchers: ProxyAgent[] = [];
  let fetchMock: jest.Mock;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn().mockResolvedValue(jsonResponse());
    globalThis.fetch = fetchMock;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    // Close any ProxyAgent the transport built so the suite leaves no open handle.
    for (const dispatcher of dispatchers.splice(0)) await dispatcher.close();
  });

  const initOf = (call = 0): Record<string, unknown> =>
    fetchMock.mock.calls[call]?.[1] as Record<string, unknown>;

  it('attaches an undici ProxyAgent dispatcher when a proxy is configured', async () => {
    const transport = build({ server: 'http://proxy.example:3128', username: 'exit', password: 'pw' });

    await transport.post(REQUEST);

    const dispatcher = initOf().dispatcher;
    expect(dispatcher).toBeInstanceOf(ProxyAgent);
    dispatchers.push(dispatcher as ProxyAgent);
  });

  it('attaches NO dispatcher when there is no proxy (unchanged direct behaviour)', async () => {
    const transport = build(null);

    await transport.post(REQUEST);

    expect(initOf()).not.toHaveProperty('dispatcher');
  });

  it('builds the ProxyAgent once and reuses it across calls', async () => {
    const transport = build({ server: 'http://proxy.example:3128', username: 'exit', password: 'pw' });

    await transport.post(REQUEST);
    await transport.post(REQUEST);

    expect(initOf(0).dispatcher).toBe(initOf(1).dispatcher);
    dispatchers.push(initOf(0).dispatcher as ProxyAgent);
  });
});
