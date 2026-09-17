/**
 * `ichancy:probe` — the egress audit that answers "is the configured proxy actually wired, and is
 * its exit IP also blocked". Pure unit test: the global fetch is mocked, so nothing dials out; the
 * proxy path builds a real undici ProxyAgent but never connects it.
 */
import { Logger } from '@nestjs/common';

import type { AppConfigService } from '@core/config/config.service';

import { IchancyProbeCommand } from './ichancy-probe.command';

const BLOCK_HTML =
  '<html><title>Attention Required! | Cloudflare</title><body>Request blocked</body></html>';
const CHALLENGE_HTML =
  '<html><title>Just a moment...</title><body>Enable JavaScript and cookies to continue</body></html>';

interface FakeResponse {
  status: number;
  contentType: string | null;
  body: string;
}

function fakeResponse({ status, contentType, body }: FakeResponse) {
  return {
    status,
    headers: {
      get: (name: string): string | null => (name.toLowerCase() === 'content-type' ? contentType : null),
    },
    text: (): Promise<string> => Promise.resolve(body),
  };
}

interface FetchRoute {
  /** Called for the origin landing page. Return `null` to simulate a network throw. */
  origin: (viaDispatcher: boolean) => FakeResponse | null;
  /** Called for api.ipify.org. Return `null` to simulate a network throw. */
  ipify: () => string | null;
}

function installFetch(route: FetchRoute): jest.Mock {
  const mock = jest.fn(async (url: string | URL, init?: Record<string, unknown>) => {
    const href = String(url);
    if (href.includes('api.ipify.org')) {
      const ip = route.ipify();
      return ip === null
        ? Promise.reject(new Error('ipify unreachable'))
        : fakeResponse({ status: 200, contentType: 'text/plain', body: ip });
    }
    const answer = route.origin(init?.dispatcher !== undefined);
    return answer === null
      ? Promise.reject(new Error('ECONNREFUSED 10.0.0.5:3128'))
      : fakeResponse(answer);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).fetch = mock;
  return mock;
}

function build(config: { proxy?: { server: string; username: string | null; password: string | null } | null }): {
  command: IchancyProbeCommand;
  lines: string[];
} {
  const lines: string[] = [];
  jest.spyOn(Logger.prototype, 'log').mockImplementation((...args: unknown[]) => lines.push(String(args[0])));
  jest.spyOn(Logger.prototype, 'error').mockImplementation((...args: unknown[]) => lines.push(String(args[0])));
  jest.spyOn(Logger.prototype, 'warn').mockImplementation((...args: unknown[]) => lines.push(String(args[0])));
  const ichancy = {
    fake: false,
    transport: 'browser',
    baseUrl: 'https://agents.ichancy.com',
    proxy: config.proxy ?? null,
  };
  // `app` is never touched by the probe; the cast keeps the test free of the full config surface.
  const app = {} as AppConfigService['app'];
  const command = new IchancyProbeCommand({ ichancy, app } as unknown as AppConfigService);
  return { command, lines };
}

afterEach(() => {
  jest.restoreAllMocks();
});

// `process.exitCode` is process-global and only ever set, never cleared — each test must start clean
// or the "reachable" assertions inherit the exit 1 left by an earlier blocked/challenge probe.
beforeEach(() => {
  process.exitCode = 0;
});

describe('ichancy:probe', () => {
  it('no proxy, origin reachable: reports direct REACHABLE and exits 0', async () => {
    const fetchMock = installFetch({ origin: () => ({ status: 200, contentType: 'text/html', body: '<html>app</html>' }), ipify: () => '203.0.113.7' });
    const { command, lines } = build({ proxy: null });

    await command.run();

    expect(fetchMock).toHaveBeenCalledTimes(2); // origin + ipify, both direct
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('dispatcher'); // direct dials with no proxy
    expect(lines.join(' ')).toContain('via-proxy   (no proxy configured)');
    expect(lines.join(' ')).toContain('direct      REACHABLE — HTTP 200');
    expect(lines.join(' ')).toContain('✅ the configured egress reached');
    expect(lines.join(' ')).toContain('direct      203.0.113.7');
    expect(process.exitCode).toBe(0);
  });

  it('no proxy, Cloudflare at the edge: reports BLOCKED, names the IP, exits 1', async () => {
    const fetchMock = installFetch({ origin: () => ({ status: 403, contentType: 'text/html; charset=UTF-8', body: BLOCK_HTML }), ipify: () => '91.240.10.42' });
    const { command, lines } = build({ proxy: null });

    await command.run();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lines.join(' ')).toContain('direct      BLOCKED — HTTP 403, Cloudflare block page');
    // The two key facts an operator needs: it is a block (not a challenge) and WHICH IP is blocked.
    expect(lines.join(' ')).toContain('this egress IP is terminal-blocked');
    expect(lines.join(' ')).toContain('direct      91.240.10.42');
    expect(process.exitCode).toBe(1);
  });

  it('a solvable challenge is NOT reported as blocked', async () => {
    installFetch({ origin: () => ({ status: 403, contentType: 'text/html; charset=UTF-8', body: CHALLENGE_HTML }), ipify: () => '1.1.1.1' });
    const { command, lines } = build({ proxy: null });

    await command.run();

    expect(lines.join(' ')).toContain('direct      CHALLENGE — HTTP 403');
    expect(lines.join(' ')).not.toContain('❌');
    expect(process.exitCode).toBe(1); // needs a clearance, so still not "money-path fixed"
  });

  it('proxy configured: REACHABLE via the proxy even when direct is BLOCKED', async () => {
    const fetchMock = installFetch({
      origin: (viaDispatcher) =>
        viaDispatcher
          ? { status: 200, contentType: 'text/html', body: '<html>app</html>' }
          : { status: 403, contentType: 'text/html', body: BLOCK_HTML },
      ipify: () => '45.127.170.12',
    });
    const { command, lines } = build({
      proxy: { server: 'socks5://exit.example:1080', username: 'res', password: 'k3y' },
    });

    await command.run();

    // Both routes were probed: the configured one (with a ProxyAgent dispatcher) and direct.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0][1]).toHaveProperty('dispatcher'); // proxy path first
    expect(lines.join(' ')).toContain('via-proxy   REACHABLE — HTTP 200');
    expect(lines.join(' ')).toContain('direct      BLOCKED — HTTP 403');
    // The proxy's exit IP is printed so the operator can compare it to the provider's advertised IP.
    expect(lines.join(' ')).toContain('via-proxy   45.127.170.12');
    // Conclusion names the verdict the money path will actually see.
    expect(lines.join(' ')).toContain('✅ the configured egress reached');
    expect(process.exitCode).toBe(0);
  });

  it('proxy configured but unreachable: FAILED via proxy, direct REACHABLE, exit 1', async () => {
    installFetch({
      origin: (viaDispatcher) =>
        viaDispatcher
          ? null // the proxy dial is refused
          : { status: 200, contentType: 'text/html', body: '<html>app</html>' },
      ipify: () => '203.0.113.7',
    });
    const { command, lines } = build({
      proxy: { server: 'http://10.0.0.5:3128', username: 'exit', password: 'pw' },
    });

    await command.run();

    expect(lines.join(' ')).toContain('via-proxy   FAILED — ECONNREFUSED 10.0.0.5:3128');
    expect(lines.join(' ')).toContain('direct      REACHABLE — HTTP 200');
    expect(lines.join(' ')).toContain('the egress itself failed');
    expect(process.exitCode).toBe(1);
  });
});