/**
 * The boot gate. What matters here is WHICH failures are fatal and which are not — get that wrong
 * in either direction and you either crash-loop a worker over a passing network condition, or ship
 * the 2026-08-20 failure again where a missing prerequisite surfaced at the first player.
 */
import { type AppConfigService } from '@core/config/config.service';

import { type BrowserIchancyTransport, MISSING_PLAYWRIGHT_MESSAGE } from './browser.transport';
import { IchancyTransportPreflightService } from './ichancy-transport-preflight.service';

/**
 * Playwright IS installed on a dev machine, so the interesting states — resolvable-but-absent
 * binary, unresolvable path, absent package — cannot be reached by running the real thing. The
 * module is faked instead, and `mockExecutablePath` is what each test steers.
 *
 * The name has to start with `mock` for the factory to be allowed to close over it: jest hoists
 * `jest.mock` above the imports and rejects any other out-of-scope reference.
 */
const mockExecutablePath = jest.fn<string, []>();
jest.mock('playwright', () => ({ chromium: { executablePath: (): string => mockExecutablePath() } }));

interface Settings {
  fake?: boolean;
  transport?: 'fetch' | 'browser';
  cookie?: string | null;
  userAgentIsDefault?: boolean;
}

function build(settings: Settings): {
  service: IchancyTransportPreflightService;
  warmUp: jest.Mock;
  warn: jest.SpyInstance;
} {
  const config = {
    ichancy: {
      fake: settings.fake ?? false,
      transport: settings.transport ?? 'browser',
      cookie: settings.cookie ?? null,
      userAgentIsDefault: settings.userAgentIsDefault ?? true,
      browserHeadless: true,
    },
  } as unknown as AppConfigService;

  const warmUp = jest.fn().mockResolvedValue(undefined);
  const browser = {
    warmUp,
    describeTransport: () => ({
      transport: 'browser',
      headless: true,
      launched: true,
      chromiumUserAgent: 'Chrome/151',
    }),
  } as unknown as BrowserIchancyTransport;

  const service = new IchancyTransportPreflightService(config, browser);
  const warn = jest.spyOn(
    (service as unknown as { logger: { warn: (message: string) => void } }).logger,
    'warn',
  );
  return { service, warmUp, warn };
}

describe('IchancyTransportPreflightService', () => {
  it('does nothing at all in fake mode', async () => {
    // This is what keeps `npx jest` and every dev boot Chromium-free: NODE_ENV=test implies
    // ICHANCY_FAKE, and the preflight must return before it ever touches `import('playwright')`.
    const { service, warmUp } = build({ fake: true, transport: 'browser' });

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(warmUp).not.toHaveBeenCalled();
  });

  it('warns rather than throws when the deployment chose the fetch fallback', async () => {
    const { service, warn } = build({ transport: 'fetch', cookie: 'PHPSESSID=x' });

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).toContain('FALLBACK');
  });

  it('says so loudly when fetch mode has no cookie at all', async () => {
    // Not merely suboptimal: with no cookie and no allowlist, every single agent-API call is
    // answered with the interstitial, so this deployment cannot register anyone.
    const { service, warn } = build({ transport: 'fetch', cookie: null });

    await service.onApplicationBootstrap();

    expect(warn.mock.calls.flat().join(' ')).toContain('ICHANCY_COOKIE is not set');
  });

  it('refuses to boot in browser mode when the Chromium binary is absent', async () => {
    // The case the transport's friendly guard misses entirely: the JS resolves, only the ~400 MB
    // browser is missing. That is the default state of any image built with `npm ci` alone, and it
    // used to surface as an unexplained TRANSPORT_ERROR/UNKNOWN row on the first player.
    const { service } = build({ transport: 'browser' });
    jest
      .spyOn(
        service as unknown as { requireChromium: () => Promise<void> },
        'requireChromium',
      )
      .mockImplementation(() => {
        throw new Error(
          'ICHANCY_TRANSPORT=browser needs a Chromium binary and none exists at /ms-playwright/x. ' +
            'Run `npm run playwright:install`',
        );
      });

    await expect(service.onApplicationBootstrap()).rejects.toThrow('npm run playwright:install');
  });

  it('warns — but boots — when a User-Agent is configured in browser mode', async () => {
    // The variable is ignored there; the warning exists so nobody spends an outage chasing a UA
    // mismatch that no longer applies.
    const { service, warmUp, warn } = build({ transport: 'browser', userAgentIsDefault: false });
    jest
      .spyOn(service as unknown as { requireChromium: () => Promise<void> }, 'requireChromium')
      .mockResolvedValue(undefined);

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).toContain('IGNORED in browser mode');
    expect(warmUp).toHaveBeenCalledTimes(1);
  });

  /**
   * The five tests above stub `requireChromium` out, which is right for asking "is this failure
   * fatal?" and useless for asking "does it DETECT anything?" — a version of that method which
   * swallowed every error would pass all of them. These drive the real one.
   */
  describe('requireChromium, unstubbed', () => {
    const runPreflight = (settings: Settings = {}): Promise<void> =>
      build({ transport: 'browser', ...settings }).service.onApplicationBootstrap();

    it('refuses to boot when Chromium resolves to a path that does not exist', async () => {
      // THE `npm ci` DEFAULT: the JS is installed, so the import succeeds and every friendly guard
      // in the transport passes — only the ~400 MB binary is missing, because Playwright 1.62 has
      // no postinstall hook. This used to surface as TRANSPORT_ERROR/UNKNOWN on the first player.
      //
      // A path that genuinely is not on disk, rather than a mocked `existsSync`: fs's exports are
      // non-configurable, and a stubbed filesystem check would be testing the stub.
      mockExecutablePath.mockReturnValue('/ms-playwright/chromium-1234/chrome-linux/chrome');

      await expect(runPreflight()).rejects.toThrow(
        /needs a Chromium binary and none exists at \/ms-playwright/,
      );
      // The error has to carry the fix, or it is just a different unexplained crash.
      await expect(runPreflight()).rejects.toThrow(/npm run playwright:install/);
    });

    it('refuses to boot when Playwright cannot resolve an executable path at all', async () => {
      mockExecutablePath.mockImplementation(() => {
        throw new Error('Unsupported platform');
      });

      await expect(runPreflight()).rejects.toThrow(/could not resolve a Chromium executable path/);
    });

    it('refuses to boot when the optional Playwright package is not installed', async () => {
      jest.resetModules();
      jest.doMock('playwright', () => {
        throw new Error("Cannot find module 'playwright'");
      });
      try {
        // Re-required through the reset registry so the throwing factory is the one that runs.
        const { IchancyTransportPreflightService: Reloaded } = await import(
          './ichancy-transport-preflight.service'
        );
        const service = new Reloaded(
          { ichancy: { fake: false, transport: 'browser' } } as unknown as AppConfigService,
          { warmUp: jest.fn() } as unknown as BrowserIchancyTransport,
        );

        await expect(service.onApplicationBootstrap()).rejects.toThrow(MISSING_PLAYWRIGHT_MESSAGE);
      } finally {
        // `doMock` outlives the test and the registry is shared by the whole file, so the healthy
        // fake has to be put back or every later test inherits an uninstallable Playwright.
        jest.resetModules();
        jest.doMock('playwright', () => ({
          chromium: { executablePath: (): string => mockExecutablePath() },
        }));
      }
    });

    it('boots, and warms up, when both prerequisites are actually present', async () => {
      // The other direction, and the one that would bite hardest: a preflight that threw on a
      // healthy image would crash-loop every deployment. `process.execPath` is a real executable on
      // every platform this runs on, so the existence check is the real one.
      mockExecutablePath.mockReturnValue(process.execPath);
      const harness = build({ transport: 'browser' });

      await expect(harness.service.onApplicationBootstrap()).resolves.toBeUndefined();
      expect(harness.warmUp).toHaveBeenCalledTimes(1);
    });
  });

  it('does NOT abort the boot when the warm-up itself fails', async () => {
    // Same split as WorkerBootstrapService: a missing binary is a deterministic config error and
    // must kill the boot, while a Cloudflare challenge that will not clear is a network condition.
    // Killing the worker for the second stops it draining the outbox and paying approved deposits.
    const { service, warmUp } = build({ transport: 'browser' });
    jest
      .spyOn(service as unknown as { requireChromium: () => Promise<void> }, 'requireChromium')
      .mockResolvedValue(undefined);
    warmUp.mockRejectedValue(new Error('Cloudflare did not clear'));

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
