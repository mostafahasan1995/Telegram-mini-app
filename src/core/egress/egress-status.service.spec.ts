/**
 * The egress status = three pure parsers + two cache rules + one proxy-summary. No real network and
 * no real /proc: `fetch` is mocked for the public-IP probe and the system probe is injected.
 */
import { type AppConfigService } from '@core/config/config.service';

import {
  EgressStatusService,
  type EgressSystemProbe,
  IPIFY_URL,
  vpnActive,
  vpnInterfacesFromDev,
  vpnTunnelInUse,
} from './egress-status.service';

const DEV_LINES = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
  eth0: 123456    1000    0    0    0     0          0         0  123456    1000    0    0    0      0       0          0
  tun0:   2048    1000    0    0    0     0          0         0  123456    1000    0    0    0      0       0          0
   wg0:   1024    1000    0    0    0     0          0         0     512    1000    0    0    0      0       0          0
`;

const VPN_INTERFACES = vpnInterfacesFromDev(DEV_LINES);

/** /proc/net/route with the VPN as the default gateway. */
const ROUTE_VIA_TUNNEL = `Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
tun0\t00000000\t0F22000A\t0003\t0\t0\t0\t00000000\t0\t0\t0
eth0\t001A0A0A\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0
`;

/** /proc/net/route where eth0 owns the default — tunnel present but NOT carrying traffic. */
const ROUTE_NOT_VIA_TUNNEL = `Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
eth0\t00000000\t0F22000A\t0003\t0\t0\t0\t00000000\t0\t0\t0
tun0\t001A0A0A\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0
`;

function configFor(overrides: {
  proxy?: { server: string; username: string | null; password: string | null } | null;
  transport?: 'browser' | 'fetch';
}): AppConfigService {
  const ichancy = {
    transport: overrides.transport ?? 'browser',
    proxy: overrides.proxy ?? null,
    loginUrl: null,
    loginUsername: null,
    loginPassword: null,
    loginUserSelector: null,
    loginPasswordSelector: null,
    loginSubmitSelector: null,
  } as unknown as AppConfigService['ichancy'];
  return { ichancy } as unknown as AppConfigService;
}

function probeWith(dev: string | null, route: string | null): EgressSystemProbe {
  return {
    platform: 'linux',
    readProc: (file: 'dev' | 'route'): string | null => (file === 'dev' ? dev : route),
  };
}

function installIpify(ip: string | null, error?: Error): jest.Mock {
  const mock = jest.fn((url: string | URL) => {
    if (String(url) !== IPIFY_URL) return Promise.reject(new Error('unexpected probe url'));
    if (error !== undefined) return Promise.reject(error);
    return Promise.resolve({
      ok: ip !== null,
      status: ip === null ? 503 : 200,
      json: () => Promise.resolve({ ip }),
    });
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).fetch = mock;
  return mock;
}

afterEach(() => {
  jest.restoreAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).fetch = undefined;
});

describe('vpn parsers', () => {
  it('finds tun/wg interfaces in /proc/net/dev and not friendly headers', () => {
    expect(VPN_INTERFACES.map((iface) => iface.name)).toEqual(['tun0', 'wg0']);
  });

  it('ignores a plain host NIC', () => {
    expect(vpnInterfacesFromDev(DEV_LINES.replace(/tun0.*|wg0.*/g, ''))).toEqual([]);
  });

  it('says the VPN is carrying traffic only when a default route sits on a tunnel iface', () => {
    expect(vpnTunnelInUse(ROUTE_VIA_TUNNEL, VPN_INTERFACES)).toBe(true);
    expect(vpnTunnelInUse(ROUTE_NOT_VIA_TUNNEL, VPN_INTERFACES)).toBe(false);
    expect(vpnTunnelInUse(null, VPN_INTERFACES)).toBe(false);
  });

  it('correlates interface-up with default-route for the honest "installed, not routing" state', () => {
    expect(vpnActive(VPN_INTERFACES, true)).toBe(true);
    expect(vpnActive(VPN_INTERFACES, false)).toBe(false);
    expect(vpnActive([], false)).toBe(false);
  });
});

describe('EgressStatusService.publicIp', () => {
  it('probes once, caches the answer across calls, and labels it fresh-first, cached-after', async () => {
    const fetchMock = installIpify('203.0.113.42');
    const service = new EgressStatusService(configFor({}), probeWith(DEV_LINES, ROUTE_VIA_TUNNEL));

    const first = await service.publicIp();
    const second = await service.publicIp();

    expect(first).toEqual({ ip: '203.0.113.42', source: 'fresh', error: null });
    expect(second).toEqual({ ip: '203.0.113.42', source: 'cached', error: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('survives a dead network with a null ip and a reason, without throwing', async () => {
    installIpify(null, new Error('ECONNRESET'));
    const service = new EgressStatusService(configFor({}), probeWith(null, null));

    const result = await service.publicIp();

    expect(result.source).toBe('unreachable');
    expect(result.ip).toBeNull();
    expect(result.error).toContain('ECONNRESET');
  });
});

describe('EgressStatusService.status', () => {
  it('reports the whole picture: server IP, VPN carrying traffic, credentialed proxy through the relay', async () => {
    installIpify('91.240.10.42');
    const config = configFor({
      proxy: { server: 'socks5://exit.example:1080', username: 'res', password: 'k3y' },
      transport: 'browser',
    });
    const service = new EgressStatusService(config, probeWith(DEV_LINES, ROUTE_VIA_TUNNEL));

    const status = await service.status();

    expect(status.transport).toBe('browser');
    expect(status.publicIp.ip).toBe('91.240.10.42');
    expect(status.vpn.active).toBe(true);
    expect(status.vpn.tunnelDefaultRoute).toBe(true);
    expect(status.vpn.interfaces.map((iface) => iface.name)).toEqual(['tun0', 'wg0']);
    // host:port, scheme, auth-present — and never the password.
    expect(status.proxy).toEqual({
      configured: true,
      scheme: 'socks5',
      hostport: 'exit.example:1080',
      authenticated: true,
      route: 'relay',
    });
    expect(JSON.stringify(status)).not.toContain('k3y');
  });

  it('reports direct egress honestly when no proxy is set', async () => {
    installIpify('1.2.3.4');
    const service = new EgressStatusService(configFor({}), probeWith(null, null));

    const status = await service.status();

    expect(status.proxy).toEqual({
      configured: false,
      scheme: null,
      hostport: null,
      authenticated: false,
      route: 'direct',
    });
    expect(status.vpn.active).toBe(false);
  });

  it('says a tunnel interface up but NOT the default route is NOT the VPN carrying traffic', async () => {
    installIpify('1.2.3.4');
    const service = new EgressStatusService(configFor({}), probeWith(DEV_LINES, ROUTE_NOT_VIA_TUNNEL));

    const { vpn } = await service.status();

    expect(vpn.active).toBe(false);
    expect(vpn.tunnelDefaultRoute).toBe(false);
    expect(vpn.note).toContain('NOT the default route');
  });

  it('never exposes proxy credentials in the payload, whatever the proxy', async () => {
    installIpify('1.2.3.4');
    const service = new EgressStatusService(
      configFor({
        proxy: { server: 'http://proxy.exit:3128', username: 'user', password: 'p@ss:word' },
        transport: 'fetch',
      }),
      probeWith(null, null),
    );

    const status = await service.status();

    expect(status.proxy.route).toBe('undici');
    const json = JSON.stringify(status);
    expect(json).not.toContain('user');
    expect(json).not.toContain('p@ss');
    expect(status.proxy).toEqual({
      configured: true,
      scheme: 'http',
      hostport: 'proxy.exit:3128',
      authenticated: true,
      route: 'undici',
    });
  });
});