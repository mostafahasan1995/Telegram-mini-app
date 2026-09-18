/**
 * WHAT IP does this deployment reach the internet from, and is a VPN carrying its default route?
 *
 * This is the tiny, dependency-free answer to the operational question that the Cloudflare-BLOCKED
 * rows could never answer on their own: "is the VPS's raw IP (which Cloudflare has reputation-
 * blocked) actually what is leaving the box, or is the Indian proxy / a WireGuard / Windscribe
 * tunnel in front of it?" The dashboard panel and the operator cannot tell from the money-path
 * output alone, because a proxy applied INSIDE the Nest process (ICHANCY_PROXY_URL) never moves the
 * host's own IP — and the host's own IP is what every NON-Ichancy egress still uses.
 *
 * DESIGN POINTS
 *   * The public IP is probed from the DEVICE's own network stack (sober, no credentials, 6s
 *     AbortSignal ceiling), cached for 90s, and single-flighted: concurrent dashboard hits must not
 *     stampede one probe box. A failure answers `source: 'unreachable'` and caches for 30s so a
 *     broken box gently reports itself instead of hammering the echo service.
 *   * VPN detection reads /proc/net/{dev,route} — no `ip`, no `wg`, no privileges, nothing to
 *     install. A `tun0`/`wg0` interface alone does NOT make the dashboard say VPN is carrying
 *     traffic; only a DEFAULT ROUTE on such an interface does. That distinction is the whole reason
 *     the "installed but not routing" Windscribe state is reported honestly instead of as a lie.
 *   * Linux-only detection. On Windows/macOS the panel degrades to `active:false` with a note; the
 *     alert-grade use of this endpoint is the Linux VPS anyway.
 *   * The proxy line is REPUTATIONAL, not secret: scheme + host:port and whether auth is set. The
 *     password (and the login credentials) never reach this endpoint or any log.
 */
import { Injectable, Logger } from '@nestjs/common';

import { readFileSync } from 'node:fs';

import { AppConfigService, proxyHostPort } from '@core/config/config.service';

/** How long a FRESH public-IP answer is trusted without re-probing. */
export const PUBLIC_IP_CACHE_MS = 90_000;
/** How long an UNREACHABLE answer is remembered, so a dead box does not retry on every hit. */
export const PUBLIC_IP_FAIL_CACHE_MS = 30_000;
/** Ceiling on the ipify probe — the dashboard must never wait for a boot-flapping network. */
export const IP_PROBE_TIMEOUT_MS = 6_000;
/** The JSON echo service; plain GET, no keys. */
export const IPIFY_URL = 'https://api.ipify.org?format=json';

export type VpnInterfaceKind = 'wireguard' | 'tunnel' | 'ppp' | 'other';

export interface VpnInterfaceInfo {
  readonly name: string;
  readonly kind: VpnInterfaceKind;
}

/** What a live public-IP determination looks like; `source` tells the panel how stale to read it. */
export interface EgressPublicIp {
  readonly ip: string | null;
  readonly source: 'fresh' | 'cached' | 'unreachable';
  readonly error: string | null;
}

export interface EgressStatusPayload {
  readonly evaluatedAt: string;
  readonly transport: 'browser' | 'fetch';
  readonly publicIp: EgressPublicIp;
  readonly vpn: {
    readonly active: boolean;
    /** The tunnel is the DEFAULT route, i.e. VPN is actually carrying outbound traffic. */
    readonly tunnelDefaultRoute: boolean;
    readonly interfaces: readonly VpnInterfaceInfo[];
    readonly note: string | null;
  };
  readonly proxy: {
    readonly configured: boolean;
    readonly scheme: string | null;
    readonly hostport: string | null;
    readonly authenticated: boolean;
    /** Where the Ichancy egress actually goes, given the transport and proxy credentials. */
    readonly route: 'direct' | 'relay' | 'inline' | 'undici';
  };
}

/**
 * The only seams the service needs: the two proc files and the platform. Kept as an injectable so
 * the unit spec can pin every parser and every cache rule without touching the real /proc.
 */
export interface EgressSystemProbe {
  readonly platform: NodeJS.Platform;
  /** Contents of /proc/net/dev or /proc/net/route, or null when unreadable/not linux. */
  readProc(file: 'dev' | 'route'): string | null;
}

export const defaultSystemProbe: EgressSystemProbe = {
  platform: process.platform,
  readProc(file: 'dev' | 'route'): string | null {
    if (process.platform !== 'linux') return null;
    try {
      return readFileSync(`/proc/net/${file}`, 'utf8');
    } catch {
      return null;
    }
  },
};

/**
 * Interface-name patterns that mean "this is a VPN-ish virtual link". Linux WireGuard is `wg0..wgN`;
 * a generic point-to-point tunnel is `tun0..tunN` (WireGuard conf, OpenVPN, Tailscale); macOS/BSD
 * uses `utun*`; dial-up / PPPoE is `ppp*`; Windscribe's own adapter is `windscribe*` — matching by
 * prefix keeps detection honest without needing any vendor binary.
 */
const VPN_NAME_PATTERNS: { readonly kind: VpnInterfaceKind; readonly pattern: RegExp }[] = [
  { kind: 'wireguard', pattern: /^wg\d+$/ },
  { kind: 'tunnel', pattern: /^tun\d+$/ },
  { kind: 'tunnel', pattern: /^tap\d+$/ },
  { kind: 'tunnel', pattern: /^utun\d+$/ },
  { kind: 'ppp', pattern: /^ppp\d+$/ },
  { kind: 'other', pattern: /^windscribe/i },
];

export function classifyVpnInterface(name: string): VpnInterfaceKind | null {
  for (const { kind, pattern } of VPN_NAME_PATTERNS) {
    if (pattern.test(name)) return kind;
  }
  return null;
}

/** `LinuxIf:4096 ...` /proc/net/dev lines -> the VPN-ish interfaces, in document order. */
export function vpnInterfacesFromDev(devLines: string | null): VpnInterfaceInfo[] {
  if (devLines === null) return [];
  const interfaces: VpnInterfaceInfo[] = [];
  for (const line of devLines.split('\n')) {
    const name = line.split(':')[0]?.trim();
    if (name === undefined || name.length === 0) continue;
    // The first line of /proc/net/dev is a label header and parses to a garbage "name"; skipping a
    // non-interface line is safer than trusting split(':')[0] blindly.
    if (name.includes('Inter-|') || name === 'Receive' || name === 'face') continue;
    const kind = classifyVpnInterface(name);
    if (kind !== null) interfaces.push({ name, kind });
  }
  return interfaces;
}

/** `/proc/net/route` claims the tunnel as the default gateway? The only corridor that means the VPN
 * is actually carrying traffic, as opposed to merely being up. */
export function vpnTunnelInUse(routeLines: string | null, interfaces: VpnInterfaceInfo[]): boolean {
  if (routeLines === null || interfaces.length === 0) return false;
  const names = new Set(interfaces.map((iface) => iface.name.toLowerCase()));
  for (const line of routeLines.split('\n')) {
    const columns = line.trim().split(/\s+/);
    const iface = columns[0] ?? '';
    const destination = columns[1] ?? '';
    if (iface.length === 0 || destination.length === 0) continue;
    // First line is the header (`Iface Destination Gateway ...`); only a real default entry counts.
    if (iface === 'Iface' || destination === 'Gateway') continue;
    if (destination === '00000000' && names.has(iface.toLowerCase())) return true;
  }
  return false;
}

export function vpnActive(interfaces: VpnInterfaceInfo[], tunnelDefaultRoute: boolean): boolean {
  return interfaces.length > 0 && tunnelDefaultRoute;
}

@Injectable()
export class EgressStatusService {
  private readonly logger = new Logger(EgressStatusService.name);

  private cached: EgressPublicIp | null = null;
  private cachedAt = 0;
  private inflight: Promise<EgressPublicIp> | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly probe: EgressSystemProbe = defaultSystemProbe,
  ) {}

  async status(): Promise<EgressStatusPayload> {
    const publicIp = await this.publicIp();
    const vpn = this.detectVpn();
    return {
      evaluatedAt: new Date().toISOString(),
      transport: this.config.ichancy.transport,
      publicIp,
      vpn,
      proxy: this.proxySummary(),
    };
  }

  /** The device's own public IP, cached and single-flighted (see the header for the rules). */
  async publicIp(): Promise<EgressPublicIp> {
    const now = Date.now();
    if (this.cached !== null) {
      // A successful answer is trusted for PUBLIC_IP_CACHE_MS; an unreachable one for much less, so
      // a box that recovered is re-measured quickly. `source` labels THIS READ: a stored fresh
      // answer returned from the cache is 'cached', never falsely re-stamped 'fresh'.
      const ttl =
        this.cached.source === 'unreachable' ? PUBLIC_IP_FAIL_CACHE_MS : PUBLIC_IP_CACHE_MS;
      if (now - this.cachedAt < ttl) {
        return this.cached.source === 'unreachable' ? this.cached : { ...this.cached, source: 'cached' };
      }
    }
    if (this.inflight === null) {
      this.inflight = this.resolveIp().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async resolveIp(): Promise<EgressPublicIp> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), IP_PROBE_TIMEOUT_MS);
      try {
        const response = await fetch(IPIFY_URL, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`ipify answered HTTP ${String(response.status)}`);
        const body = (await response.json()) as { ip?: unknown };
        const ip = typeof body.ip === 'string' && body.ip.length > 0 ? body.ip : null;
        if (ip === null) throw new Error('ipify answered without an ip field');
        this.cached = { ip, source: 'fresh', error: null };
      } finally {
        clearTimeout(timer);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Egress public-IP probe failed: ${message}`);
      this.cached = { ip: this.cached?.ip ?? null, source: 'unreachable', error: message };
    }
    this.cachedAt = Date.now();
    return this.cached;
  }

  private detectVpn(): EgressStatusPayload['vpn'] {
    if (this.probe.platform !== 'linux') {
      return {
        active: false,
        tunnelDefaultRoute: false,
        interfaces: [],
        note: 'vpn detection reads /proc (linux only)',
      };
    }
    const interfaces = vpnInterfacesFromDev(this.probe.readProc('dev'));
    const tunnelDefaultRoute = vpnTunnelInUse(this.probe.readProc('route'), interfaces);
    const active = vpnActive(interfaces, tunnelDefaultRoute);
    if (interfaces.length === 0) {
      return { active, tunnelDefaultRoute, interfaces, note: 'no tunnel interface is up' };
    }
    // The two rows are CORRELATED on purpose: `tun0` up but not the default route is the
    // "Windscribe installed, routing reserved for future marked routes" state, and the panel shows
    // exactly that rather than guessing.
    return {
      active,
      tunnelDefaultRoute,
      interfaces,
      note: active
        ? 'a tunnel interface is the default route — egress is via the VPN'
        : 'tunnel interface(s) up but NOT the default route — egress is still the host network',
    };
  }

  private proxySummary(): EgressStatusPayload['proxy'] {
    const proxy = this.config.ichancy.proxy ?? null;
    const transport = this.config.ichancy.transport;
    if (proxy === null) return { configured: false, scheme: null, hostport: null, authenticated: false, route: 'direct' };
    const parsed = /^([a-z0-9]+):\/\/(.+)$/i.exec(proxy.server);
    const scheme = parsed?.[1]?.toLowerCase() ?? null;
    const credentials = proxy.username !== null && proxy.password !== null;
    // Credentialed browser egress goes through the loopback relay (Chromium cannot auth); the
    // credential-free browser egress is passed to chromium.launch directly; undici handles both
    // itself. host:port only — passwords are never exposed here.
    const route = credentials && transport === 'browser' ? 'relay' : 'inline';
    return {
      configured: true,
      scheme,
      hostport: proxyHostPort(proxy.server),
      authenticated: credentials,
      route: transport === 'fetch' ? 'undici' : route,
    };
  }
}