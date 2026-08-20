/**
 * EARNS A CLOUDFLARE CLEARANCE IN A REAL BROWSER, SO THE MONEY PATH NEVER HAS TO.
 *
 * ══ WHAT THIS REPLACES ════════════════════════════════════════════════════════════════════════
 * Two dead ends preceded it, and both are worth knowing so neither is re-attempted:
 *
 *   1. PASTING a cookie from a human's browser. Works, for ~25 minutes. `__cf_bm` has a fixed
 *      30-minute TTL, measured twice: a cookie minted 09:42 served calls until 10:06 and was dead at
 *      10:11; one minted 09:50 was dead when tested at 10:25. That is not an integration, it is a
 *      person re-pasting a credential twelve times a working day.
 *   2. Doing the API calls INSIDE the browser (BrowserIchancyTransport). Correct in principle, but
 *      it puts a 60–90 second Chromium launch in front of a credit, and a browser that dies mid-call
 *      makes an ambiguous money outcome out of what should be a 400ms POST.
 *
 * This service keeps the browser and throws away both problems: Chromium runs every ~25 minutes, off
 * the money path, and hands a plain `Cookie:` header to the fetch transport. Credits stay ~400ms.
 *
 * ══ THE RECIPE, AND WHY EVERY PART OF IT IS LOAD-BEARING ══════════════════════════════════════
 * Measured on 2026-08-20 against the live endpoint. `navigator.webdriver` is the discriminator —
 * every failing configuration reported `true`, the working one reports `false`:
 *
 *   ignoreDefaultArgs: ['--enable-automation']   Playwright adds this flag by default and it is what
 *                                                sets navigator.webdriver = true. Removing it is the
 *                                                single most important line here.
 *   patchright instead of playwright             patches the CDP `Runtime.enable` leak, which is the
 *                                                detection signal Cloudflare leans on hardest in 2026.
 *   channel: 'chrome'                            a real Chrome build, not bundled Chromium.
 *   launchPersistentContext                      a profile that persists. A blank throwaway profile
 *                                                scores badly and never accumulates trust.
 *   headless: false                              the challenge did not release headless. On a Linux
 *                                                server this needs xvfb-run.
 *   NO --no-sandbox                              it raises Chrome's own "unsupported flag" warning
 *                                                bar, which is one more thing that is not a browser.
 *
 * With all six: cleared in 6–9 seconds, and the harvested cookies then worked from plain Node fetch.
 * Change any one of them and expect "Just a moment..." forever.
 *
 * ══ WHY IT IS OFF BY DEFAULT ══════════════════════════════════════════════════════════════════
 * It is a workaround for someone else's misconfiguration — bot protection in front of an API meant
 * for server-to-server use. The moment Ichancy allowlists the server's IP, set ICHANCY_COOKIE_HARVEST
 * to false and delete the Chrome from the image. Nothing else has to change.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { LockService } from '@core/cache/lock.service';
import { AppConfigService } from '@core/config/config.service';

import { IchancyCookieStore, type HarvestedCookies } from './ichancy-cookie.store';

/**
 * Ahead of `__cf_bm`'s 30 minutes, with enough margin that a slow harvest (a challenge can take ~45
 * seconds) still lands before the current clearance dies. Not configurable: the 30 minutes is
 * Cloudflare's, not ours, so there is no deployment in which a different number is correct.
 */
export const COOKIE_REFRESH_INTERVAL_MS = 25 * 60_000;

/** One harvest at a time across the cluster. A second browser is pure cost and earns nothing extra. */
export const COOKIE_HARVEST_LOCK_KEY = 'lock:ichancy:cookie-harvest';
const HARVEST_LOCK_TTL_MS = 120_000;

/** A Managed Challenge can legitimately run this long before it hands over a clearance. */
const CHALLENGE_TIMEOUT_MS = 60_000;
const CHALLENGE_POLL_MS = 1_000;

/** Cloudflare's interstitial, by page title. */
const CHALLENGE_TITLES = ['just a moment', 'attention required'];

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The slice of patchright/playwright this file touches — declared locally so the optional
 *  dependency's absence cannot break `tsc` for everyone else. */
interface HarvestPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  title(): Promise<string>;
  evaluate<T>(script: string): Promise<T>;
}
interface HarvestContext {
  pages(): HarvestPage[];
  newPage(): Promise<HarvestPage>;
  cookies(): Promise<{ name: string; value: string }[]>;
  close(): Promise<void>;
}
interface HarvestChromium {
  launchPersistentContext(dir: string, options: Record<string, unknown>): Promise<HarvestContext>;
}

@Injectable()
export class CookieHarvesterService {
  private readonly logger = new Logger(CookieHarvesterService.name);

  /** In-process single flight, on top of the cluster lock: a challenge burst must not queue browsers. */
  private inFlight: Promise<HarvestedCookies | null> | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly store: IchancyCookieStore,
    private readonly locks: LockService,
  ) {}

  /**
   * Refresh the clearance now. Returns the new value, or null when the harvest could not run —
   * never throws, because every caller is either a scheduler or a request that has already failed.
   */
  async harvest(): Promise<HarvestedCookies | null> {
    if (!this.config.ichancy.cookieHarvest) return null;

    this.inFlight ??= this.runOnce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * The 25-minute tick. Worker-only: `@Interval` fires wherever ScheduleModule is imported, and a
   * browser per api replica is exactly the waste the cluster lock is there to prevent — the guard
   * makes it never start in the first place.
   */
  @Interval('ichancy-cookie-harvest', COOKIE_REFRESH_INTERVAL_MS)
  async tick(): Promise<void> {
    if (!this.config.app.isWorker) return;
    if (!this.config.ichancy.cookieHarvest) return;
    await this.harvest();
  }

  private async runOnce(): Promise<HarvestedCookies | null> {
    const handle = await this.locks.acquire(COOKIE_HARVEST_LOCK_KEY, HARVEST_LOCK_TTL_MS);
    if (handle === null) {
      // Another process is already doing it. Its result lands in the shared store, so waiting here
      // would only duplicate work — the caller re-reads the store on its next attempt.
      this.logger.debug('A cookie harvest is already running elsewhere; skipping this one');
      return null;
    }

    try {
      const harvested = await this.launchAndHarvest();
      if (harvested !== null) await this.store.write(harvested);
      return harvested;
    } catch (error: unknown) {
      // Loud: a harvest that fails silently means every agent-API call is challenged until somebody
      // notices players are not being registered. IchancyHealthService raises the operator alarm
      // from the call site; this line is what names the cause.
      this.logger.error(`Cookie harvest failed: ${describe(error)}`);
      return null;
    } finally {
      await this.locks.release(handle).catch(() => false);
    }
  }

  private async launchAndHarvest(): Promise<HarvestedCookies | null> {
    const chromium = await this.loadChromium();
    const settings = this.config.ichancy;
    const startedAt = Date.now();

    const context = await chromium.launchPersistentContext(settings.cookieProfileDir, {
      channel: 'chrome',
      headless: false,
      viewport: { width: 1280, height: 800 },
      // THE decisive line — see the header. Without it navigator.webdriver is true and the
      // challenge never releases.
      ignoreDefaultArgs: ['--enable-automation'],
    });

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      const origin = new URL(settings.baseUrl).origin;

      await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: CHALLENGE_TIMEOUT_MS });

      const cleared = await this.waitForChallenge(page, startedAt);
      if (!cleared) {
        this.logger.error(
          `The Cloudflare challenge did not clear within ${String(CHALLENGE_TIMEOUT_MS)}ms; ` +
            'no cookies harvested. If this persists, the profile may need a manual sign-in.',
        );
        return null;
      }

      // The challenge writes its cookie a moment after the title flips; harvesting into that gap
      // yields a jar without cf_clearance, which looks like success and is not.
      await delay(2_500);

      const userAgent = await page.evaluate<string>('navigator.userAgent');
      const cookie = this.toCookieHeader(await context.cookies());

      if (!cookie.includes('cf_clearance=')) {
        this.logger.error('Harvest produced no cf_clearance; treating it as a failure');
        return null;
      }

      this.logger.log(
        `Harvested a Cloudflare clearance in ${String(Date.now() - startedAt)}ms ` +
          `(${String(cookie.split(';').length)} cookies)`,
      );
      return { cookie, userAgent, harvestedAt: new Date().toISOString() };
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  /** Poll the TITLE: a challenge takes anywhere from a second to a minute, so no fixed sleep is right. */
  private async waitForChallenge(page: HarvestPage, startedAt: number): Promise<boolean> {
    while (Date.now() - startedAt < CHALLENGE_TIMEOUT_MS) {
      const title = (await page.title().catch(() => 'just a moment')).toLowerCase();
      if (title.length > 0 && !CHALLENGE_TITLES.some((marker) => title.includes(marker))) {
        return true;
      }
      await delay(CHALLENGE_POLL_MS);
    }
    return false;
  }

  /**
   * DEDUPED BY NAME. Cloudflare issues `cf_clearance` for both `.ichancy.com` and the subdomain, and
   * a header carrying the same name twice is malformed — it was sending exactly that during the
   * investigation, which is its own way to fail.
   */
  private toCookieHeader(cookies: { name: string; value: string }[]): string {
    const jar = new Map<string, string>();
    for (const cookie of cookies) {
      if (cookie.value.length > 0) jar.set(cookie.name, cookie.value);
    }
    return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  /** Seam for the unit spec, mirroring BrowserIchancyTransport.loadChromium. */
  protected async loadChromium(): Promise<HarvestChromium> {
    try {
      const patchright = (await import('patchright')) as unknown as { chromium: HarvestChromium };
      return patchright.chromium;
    } catch (error: unknown) {
      throw new Error(
        'ICHANCY_COOKIE_HARVEST needs Patchright and a real Chrome. Install with ' +
          '`npm install patchright && npx patchright install chrome`. ' +
          `Underlying error: ${describe(error)}`,
      );
    }
  }
}
