/**
 * `npm run ichancy:probe` — WHAT IP does this process reach Ichancy from, and does Cloudflare accept
 * it? READ-ONLY egress audit for the "still blocked on the VPS" case.
 *
 * WHY THIS EXISTS: CLOUDFLARE_BLOCKED rows say only "your egress IP is blocked". They cannot say
 * whether the proxy is wired at all, whether the proxy's own IP is ALSO blocked, or whether the proxy
 * config is simply unreachable — the three states that need three different fixes, and each is
 * invisible until you actually dial out. This command dials out with the REAL configured egress (the
 * same undici ProxyAgent the fetch transport builds) and prints both verdicts side by side:
 *   * via the configured proxy   -> the landing page of ICHANCY_BASE_URL, classified
 *   * direct (bonus, proxy set)  -> the same, WITHOUT the proxy
 * …plus the public IP that exit presents (best-effort, via api.ipify.org through the same egress).
 *
 * It sends NO credentials and writes nothing: it GETs a web page and an IP echo, which is why it is a
 * separate read-only command rather than part of ichancy:check (whose sign-in changes state).
 *
 * Exit status: 0 when the configured egress reached the origin cleanly (REACHABLE), 1 when it is
 * blocked, challenged, or unreachable — so a deploy script can gate on it.
 */
import { Logger } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';

import { AppConfigService, proxyHostPort } from '@core/config/config.service';
import {
  isCloudflareBlock,
  isCloudflareChallenge,
} from '@core/ichancy/error-map';
import { createProxyDispatcher, type ProxySettings } from '@core/ichancy/transport/proxy-relay';

interface ProbeVerdict {
  readonly label: string;
  readonly detail: string;
}

const PROBE_TIMEOUT_MS = 20_000;

@Command({
  name: 'ichancy:probe',
  description:
    'Read-only egress audit: what IP does this deployment reach Ichancy from, and is that IP blocked by Cloudflare?',
})
export class IchancyProbeCommand extends CommandRunner {
  private readonly logger = new Logger('ichancy:probe');

  constructor(private readonly config: AppConfigService) {
    super();
  }

  async run(): Promise<void> {
    const settings = this.config.ichancy;
    const proxy = settings.proxy ?? null;

    if (settings.fake) {
      this.logger.warn('ICHANCY_FAKE is on. The probe is still real (it dials the network itself).');
    }

    this.logger.log('── config ───────────────────────────────────────────────────');
    this.logger.log(`origin      ${settings.baseUrl}`);
    this.logger.log(`transport   ${settings.transport}`);
    if (proxy === null) {
      this.logger.log('proxy       NONE — this process exits via the server’s own IP');
    } else {
      // host:port only, and NEVER the password: same rule as describeTransport/preflight.
      this.logger.log(`proxy       ${proxy.server.split('://')[0]}://${proxyHostPort(proxy.server)}`);
      this.logger.log(
        `auth        ${proxy.username === null && proxy.password === null ? 'none' : 'username/password (never printed)'}`,
      );
    }

    const originUrl = new URL(settings.baseUrl).origin;
    this.logger.log('── ichancy origin (landing GET, no credentials) ─────────────');
    // The configured egress is the whole ballgame. When a proxy is set, ALSO probe direct so the
    // operator can tell "the proxy IP is blocked too" from "the proxy is not actually being used".
    const viaProxy = proxy === null ? null : await this.probe(originUrl, proxy);
    const direct = await this.probe(originUrl, null);

    this.logger.log(
      `via-proxy   ${viaProxy === null ? '(no proxy configured)' : this.renderVerdict(viaProxy)}`,
    );
    this.logger.log(`direct      ${this.renderVerdict(direct)}`);
    // The verdict that matters is the one a live call will use: the proxy, when one is configured.
    this.logger.log(this.renderConclusion(viaProxy ?? direct));

    this.logger.log('── public egress ip (api.ipify.org, best effort) ────────────');
    const ipViaProxy = proxy === null ? null : await this.publicIp(proxy);
    const ipDirect = await this.publicIp(null);
    this.logger.log(`via-proxy   ${ipViaProxy ?? 'no proxy configured'}`);
    this.logger.log(`direct      ${ipDirect ?? '<ip echo unreachable>'}`);

    const primary = viaProxy ?? direct;
    if (primary.label === 'FAILED' || primary.label === 'BLOCKED' || primary.label === 'CHALLENGE') {
      this.logger.log(
        'FIX: if via-proxy is FAILED, ICHANCY_PROXY_URL/credentials are wrong or the provider is ' +
          'down. If it is BLOCKED, the proxy’s exit IP is ALSO on Cloudflare’s block list — talk to ' +
          'the proxy provider or pick another exit. If it is CHALLENGE, the IP is fine but the agent ' +
          'API is still hiding behind a solve that undici cannot do. Only when via-proxy is REACHABLE ' +
          'is the money path fixed.',
      );
      // A deploy script gating on the probe sees a non-zero exit for the two states that keep the
      // money path broken. (main.cli.ts turns serviceErrorHandler-style failures into the status;
      // a resolved command without a throw exits 0, so the command says so itself.)
      process.exitCode = 1;
    }
  }

  private renderVerdict(verdict: ProbeVerdict): string {
    return `${verdict.label} — ${verdict.detail}`;
  }

  private renderConclusion(verdict: ProbeVerdict): string {
    switch (verdict.label) {
      case 'REACHABLE':
        return '✅ the configured egress reached the origin and Cloudflare did NOT block it.';
      case 'CHALLENGE':
        return 'solvable challenge: egress is fine, but a call needs a live clearance for this IP.';
      case 'BLOCKED':
        return '❌ this egress IP is terminal-blocked at Cloudflare; no cookie/UA/re-auth can help.';
      default:
        return '❌ the egress itself failed; inspect the error above (proxy config most likely).';
    }
  }

  /** GET the origin landing page through the given egress and classify what Cloudflare served. */
  private async probe(originUrl: string, proxy: ProxySettings | null): Promise<ProbeVerdict> {
    const init: RequestInit = {
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { accept: 'text/html,application/xhtml+xml' },
    };
    // undici's Dispatcher type and Node's RequestInit disagree about FormData; the fetch transport
    // carries it the same way — assign via a cast rather than declare it in the initial shape.
    if (proxy !== null) {
      (init as { dispatcher?: unknown }).dispatcher = await createProxyDispatcher(proxy);
    }
    try {
      const response = await fetch(`${originUrl}/`, init);
      const contentType = response.headers.get('content-type');
      const body = await response.text();
      const text = body.slice(0, 4_000);

      if (isCloudflareBlock(response.status, text, contentType)) {
        return { label: 'BLOCKED', detail: `HTTP ${response.status}, Cloudflare block page at the edge` };
      }
      if (isCloudflareChallenge(response.status, text, contentType)) {
        return { label: 'CHALLENGE', detail: `HTTP ${response.status}, "Just a moment" turnaround page` };
      }
      return {
        label: 'REACHABLE',
        detail: `HTTP ${response.status}, content-type ${contentType ?? 'unknown'}`,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { label: 'FAILED', detail: message };
    }
  }

  /** The public IP the given egress presents, or null when the echo service is unreachable. */
  private async publicIp(proxy: ProxySettings | null): Promise<string | null> {
    const init: RequestInit = { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) };
    if (proxy !== null) {
      (init as { dispatcher?: unknown }).dispatcher = await createProxyDispatcher(proxy);
    }
    try {
      const response = await fetch('https://api.ipify.org', init);
      const ip = (await response.text()).trim();
      return ip.length > 0 ? ip : null;
    } catch {
      return null;
    }
  }
}