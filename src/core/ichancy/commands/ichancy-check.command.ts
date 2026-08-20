/**
 * `npm run ichancy:check` — does this deployment actually reach the agent API, and as whom?
 *
 * WHY THIS EXISTS AS A COMMAND: every failure mode of this integration looks the same from the
 * outside ("deposits stopped crediting"), and they need completely different fixes:
 *   - Cloudflare answered with a challenge  -> refresh ICHANCY_COOKIE / allowlist the server IP
 *   - wrong username or password            -> fix ICHANCY_USERNAME / ICHANCY_PASSWORD
 *   - no session in Redis, running as api   -> start the worker once
 *   - signed in fine, wallet is empty       -> top the agent up; nothing is broken
 * Reading that off a live call takes seconds; inferring it from a stuck deposit queue takes an
 * afternoon. It is READ-ONLY on purpose — it signs in, reads the wallet, and writes nothing.
 *
 * WHY IT PRINTS THE AGENT ID IT WILL PARENT PLAYERS TO: the single most expensive misconfiguration
 * here is a correct login paired with somebody else's ICHANCY_AGENT_ID, because registration then
 * succeeds and hangs every player off the wrong agent. Seeing the id next to the wallet that will
 * pay for their credits is what makes that visible before the first player arrives.
 */
import { Inject, Logger } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { Command, CommandRunner } from 'nest-commander';

import { AppConfigService } from '@core/config/config.service';
import { formatMinorToDecimal } from '@common/helpers/money.util';

import { CLOUDFLARE_CHALLENGE_CODE } from '../error-map';
import { BrowserIchancyTransport } from '../transport/browser.transport';
import { IchancySessionService } from '../ichancy-session.service';
import { ICHANCY_PORT, type IchancyPort } from '../ichancy.port';
import { isIchancyOk, isIchancyRejected } from '../ichancy.types';

@Command({
  name: 'ichancy:check',
  description: 'Sign in to the agent API and read the agent wallet. Read-only.',
})
export class IchancyCheckCommand extends CommandRunner {
  private readonly logger = new Logger('ichancy:check');

  constructor(
    private readonly config: AppConfigService,
    private readonly session: IchancySessionService,
    @Inject(ICHANCY_PORT) private readonly ichancy: IchancyPort,
    // The concrete class, not the ICHANCY_TRANSPORT token: this command has to be able to say what
    // the browser transport WOULD do even when the fetch one is selected.
    private readonly browser: BrowserIchancyTransport,
  ) {
    super();
  }

  async run(): Promise<void> {
    const settings = this.config.ichancy;

    this.logger.log('── configuration ────────────────────────────────────────────');
    this.logger.log(`base url    ${settings.baseUrl}`);
    this.logger.log(`username    ${settings.username}`);
    this.logger.log(`agent id    ${settings.agentId}   (parentId for every registerPlayer)`);
    this.logger.log(`currency    ${settings.currency}`);
    this.logger.log(`role        ${this.config.app.role}`);
    this.logger.log(
      `cookie      ${settings.cookie === null ? 'NOT SET' : `${String(settings.cookie.length)} chars`}`,
    );
    // PRINTED IN FULL, and not as a length: a User-Agent that does not match the browser which
    // earned cf_clearance fails EXACTLY like no cookie at all, with no hint anywhere that the two
    // disagree. That mismatch (Chrome/140 configured, Chrome/150 in the browser) is what made this
    // integration look permanently blocked when it was one string away from working.
    this.logger.log(`user-agent  ${settings.userAgent}`);
    this.logger.log(`adapter     ${settings.fake ? 'FAKE — nothing real is contacted' : 'REAL'}`);
    // Until 2026-08-20 this command could not tell an operator WHICH transport was in effect — the
    // only signal was a line in the boot log, which is exactly what nobody has in front of them
    // while an integration is down. The transport is the first thing to check now that a pasted
    // cf_clearance is no longer the supported path.
    await this.reportTransport();

    // MIRRORS the guard in WorkerBootstrapService: ICHANCY_FAKE means this process does not CONTACT
    // Ichancy, not merely that it does not move money. ensureSession() would sign in for real even
    // in fake mode — the session layer is wired to the HTTP client unconditionally — so a diagnostic
    // that skipped this check would reach across the network from a deployment whose whole point is
    // that it cannot.
    if (settings.fake) {
      this.logger.warn('ICHANCY_FAKE is on: the real API is NOT contacted and no session is opened.');
      this.logger.warn('Set ICHANCY_FAKE=false to check the real agent account.');
      await this.reportWallet(settings.currency);
      return;
    }

    this.logger.log('── session ──────────────────────────────────────────────────');
    try {
      await this.session.ensureSession();
      const info = await this.session.describe();
      this.logger.log(
        `signed in   yes (via ${info.source ?? 'unknown'}, generation ${String(info.generation ?? 0)})`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`signed in   NO — ${message}`);
      this.explain(message);
      throw new Error('ichancy:check failed at sign-in');
    }

    await this.reportWallet(settings.currency);
  }

  /**
   * WHICH transport, and — in browser mode — whether the prerequisites are actually on this box.
   * Read-only: it never launches Chromium just to answer, because a diagnostic that starts a
   * browser is a diagnostic that changes what it is measuring.
   */
  private async reportTransport(): Promise<void> {
    const settings = this.config.ichancy;
    this.logger.log('── transport ────────────────────────────────────────────────');

    if (settings.transport === 'fetch') {
      this.logger.log('transport   fetch  (Node fetch + ICHANCY_COOKIE)');
      this.logger.warn(
        'fetch is the FALLBACK path. A pasted cf_clearance decays with the IP trust score — ' +
          'measured ~17 minutes on 2026-08-19. Prefer ICHANCY_TRANSPORT=browser.',
      );
      return;
    }

    const described = this.browser.describeTransport();
    this.logger.log(`transport   browser  (headless=${String(described.headless)})`);

    let executable: string | null = null;
    try {
      const playwright = (await import('playwright')) as unknown as {
        chromium: { executablePath(): string };
      };
      executable = playwright.chromium.executablePath();
    } catch {
      executable = null;
    }
    if (executable === null) {
      this.logger.error('playwright  NOT INSTALLED — run `npm install playwright`');
    } else if (!existsSync(executable)) {
      this.logger.error(`chromium    MISSING at ${executable} — run \`npm run playwright:install\``);
    } else {
      this.logger.log(`chromium    ${executable}`);
    }

    // The RESOLVED UA, which is Chromium's own and only known once it has been launched. Printing
    // "not launched yet" rather than the configured value is the point: in browser mode
    // ICHANCY_USER_AGENT is ignored, and showing it here is what would send someone chasing a
    // mismatch that no longer exists.
    this.logger.log(
      `chromium UA ${described.chromiumUserAgent ?? 'not launched in this process yet'}`,
    );
    if (!settings.userAgentIsDefault) {
      this.logger.warn(
        'ICHANCY_USER_AGENT is set but IGNORED in browser mode; Chromium supplies its own.',
      );
    }
  }

  /** The wallet half, shared by the real path and the fake one so both print the same shape. */
  private async reportWallet(currency: string): Promise<void> {
    this.logger.log('── agent wallet ─────────────────────────────────────────────');
    const wallet = await this.ichancy.getAgentWallet({ correlationId: 'cli:ichancy:check' });

    if (isIchancyOk(wallet)) {
      this.logger.log(`balance     ${formatMinorToDecimal(wallet.data.balanceMinor)} ${currency}`);
      this.logger.log(
        `available   ${formatMinorToDecimal(wallet.data.availableMinor)} ${currency}` +
          '   (what an approval is actually drawn against)',
      );
      this.logger.log(
        this.config.ichancy.fake
          ? '✅ fake adapter answered. Nothing real was contacted.'
          : '✅ the agent API is reachable and these credentials work.',
      );
      return;
    }

    const detail = isIchancyRejected(wallet) ? `${wallet.code}: ${wallet.message}` : wallet.cause;
    this.logger.error(`wallet      UNREADABLE — ${detail}`);
    this.explain(detail);
    throw new Error('ichancy:check could not read the agent wallet');
  }

  /** Turns the failure into the one sentence that says what to change. */
  private explain(detail: string): void {
    if (detail.includes(CLOUDFLARE_CHALLENGE_CODE) || detail.toLowerCase().includes('cloudflare')) {
      this.logger.error(
        'FIX: Cloudflare blocked the call. Copy a fresh cf_clearance (plus __cf_bm and PHPSESSID) ' +
          'from a browser into ICHANCY_COOKIE, set ICHANCY_USER_AGENT to that same browser, and ' +
          'remember the clearance is bound to the public IP that earned it — from a server with a ' +
          "different IP it will not work. The durable fix is asking Ichancy to allowlist the server's IP.",
      );
      return;
    }
    if (detail.toLowerCase().includes('invalid username or password')) {
      this.logger.error('FIX: ICHANCY_USERNAME / ICHANCY_PASSWORD are wrong for this base URL.');
      return;
    }
    if (detail.includes('ICHANCY_SESSION_MISSING')) {
      this.logger.error(
        'FIX: APP_ROLE=api never signs in — it reuses the session the worker stored in Redis. ' +
          'Start the worker once, or re-run this command with APP_ROLE=worker (only when no worker ' +
          'is running: a second sign-in kills the first session).',
      );
    }
  }
}
