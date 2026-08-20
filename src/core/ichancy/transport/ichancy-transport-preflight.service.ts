/**
 * FAIL AT BOOT, NOT AT THE FIRST PLAYER.
 *
 * ══ WHY THIS EXISTS ═══════════════════════════════════════════════════════════════════════════
 * `ICHANCY_TRANSPORT=browser` has two prerequisites that `npm ci` does not satisfy: the OPTIONAL
 * `playwright` package, and — separately — its Chromium binary, because Playwright 1.62 has no
 * postinstall hook. Miss the package and the transport throws a friendly message at the first
 * player. Miss only the BINARY and it throws Playwright's raw "Executable doesn't exist", which is
 * recorded as `TRANSPORT_ERROR / UNKNOWN` on an `ichancy_calls` row and reads, to anyone looking, as
 * an Ichancy problem rather than a missing dependency in our own image.
 *
 * Both of those are deterministic configuration errors. A deployment that cannot possibly register
 * a player should refuse to start and say the install command, in the tradition of every other
 * schema validation in this project — not boot green and discover it when somebody presses /start.
 *
 * ══ WHY THE WARM-UP IS NOT FATAL AND THE PREREQUISITES ARE ════════════════════════════════════
 * Same split as WorkerBootstrapService: a missing binary is a config error and must kill the boot,
 * while a Cloudflare challenge that will not clear is a NETWORK condition. Killing the worker for
 * the second would stop it draining the outbox, paying out approved deposits and answering the bot
 * — over a problem that fixes itself. So the warm-up is attempted, logged when it fails, and feeds
 * the health breaker like any other failed call.
 *
 * ══ MEMORY, because browser mode is now the default ═══════════════════════════════════════════
 * Steady state is ONE Chromium and it lives in the WORKER: Telegram updates are dispatched by
 * TelegramUpdateProcessor, so `/start` -> `ensureLinked` runs there. The api launches one only when
 * an admin hits `/v1/admin/players/:id/ichancy`. Budget ~400 MB resident per launched browser; a
 * 1 GB VPS needs swap, or `ICHANCY_TRANSPORT=fetch` on the api role.
 */
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { existsSync } from 'node:fs';

import { AppConfigService } from '@core/config/config.service';

import { BrowserIchancyTransport, MISSING_PLAYWRIGHT_MESSAGE } from './browser.transport';

/** Only the sliver of Playwright's chromium object this file needs, so the import stays optional. */
interface ChromiumLauncher {
  executablePath(): string;
}

@Injectable()
export class IchancyTransportPreflightService implements OnApplicationBootstrap {
  private readonly logger = new Logger(IchancyTransportPreflightService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly browser: BrowserIchancyTransport,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const settings = this.config.ichancy;

    // This is what keeps `npx jest` and every dev boot Chromium-free: NODE_ENV=test implies
    // ICHANCY_FAKE, and a fake adapter never opens a socket, let alone a browser.
    if (settings.fake) {
      this.logger.log('Ichancy is FAKE — transport preflight skipped.');
      return;
    }

    if (settings.transport === 'fetch') {
      this.warnAboutFetch();
      return;
    }

    await this.requireChromium();

    if (!settings.userAgentIsDefault) {
      this.logger.warn(
        'ICHANCY_USER_AGENT is set but IGNORED in browser mode — Chromium supplies its own, and ' +
          'overriding it would make the UA header disagree with the TLS fingerprint. Clear the ' +
          'variable to avoid confusion.',
      );
    }

    await this.warmUp();
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────

  private warnAboutFetch(): void {
    this.logger.warn(
      'Ichancy transport: FETCH — this is the FALLBACK path. A pasted cf_clearance decays with the ' +
        "IP's Cloudflare trust score: measured at ~17 minutes on 2026-08-19, then a single request " +
        'hours later. Prefer ICHANCY_TRANSPORT=browser unless this host is IP-allowlisted.',
    );
    if (this.config.ichancy.cookie === null) {
      // Not merely "suboptimal": with no cookie at all, every call to agents.ichancy.com is answered
      // with the interstitial, so this deployment cannot register a player or read the float.
      this.logger.warn(
        'ICHANCY_COOKIE is not set while ICHANCY_TRANSPORT=fetch. Unless this host is allowlisted, ' +
          'every agent-API call will be answered with a Cloudflare challenge.',
      );
    }
  }

  /**
   * The two prerequisites, checked separately because they fail separately and have different fixes.
   * Throwing here aborts the Nest bootstrap, which is the intent: see the header.
   */
  private async requireChromium(): Promise<void> {
    let chromium: ChromiumLauncher;
    try {
      const playwright = (await import('playwright')) as unknown as { chromium: ChromiumLauncher };
      chromium = playwright.chromium;
    } catch (error: unknown) {
      throw new Error(
        `${MISSING_PLAYWRIGHT_MESSAGE} Or set ICHANCY_TRANSPORT=fetch to fall back consciously. ` +
          `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // The case the transport's friendly guard misses entirely: the JS is installed (so the dynamic
    // import succeeds) and only the ~400 MB browser is absent. That is the DEFAULT state of any
    // image built with `npm ci` alone, including this project's Dockerfile before 2026-08-20.
    let executable: string;
    try {
      executable = chromium.executablePath();
    } catch (error: unknown) {
      throw new Error(
        'ICHANCY_TRANSPORT=browser could not resolve a Chromium executable path. Run ' +
          '`npm run playwright:install` (`npx playwright install --with-deps chromium` on Linux), ' +
          `or set ICHANCY_TRANSPORT=fetch. Underlying error: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }

    if (!existsSync(executable)) {
      throw new Error(
        `ICHANCY_TRANSPORT=browser needs a Chromium binary and none exists at ${executable}. ` +
          'Run `npm run playwright:install` (`npx playwright install --with-deps chromium` on ' +
          'Linux), or set ICHANCY_TRANSPORT=fetch to fall back consciously.',
      );
    }

    this.logger.log(`Ichancy transport preflight OK: Chromium at ${executable}`);
  }

  private async warmUp(): Promise<void> {
    try {
      await this.browser.warmUp();
      const described = this.browser.describeTransport();
      this.logger.log(
        `Chromium warm and past Cloudflare (headless=${String(described.headless)}, ` +
          `UA=${described.chromiumUserAgent ?? 'unknown'})`,
      );
    } catch (error: unknown) {
      // Loud, but NOT fatal — see the header. The breaker will notice if calls keep failing, and
      // the admin group is told once rather than the worker dying with the outbox undrained.
      this.logger.error(
        'Ichancy browser warm-up failed; calls will be attempted anyway and will report ' +
          `CLOUDFLARE_CHALLENGE if still blocked: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }
  }
}
