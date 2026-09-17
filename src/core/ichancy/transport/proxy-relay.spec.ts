/**
 * The proxy relay, over REAL loopback sockets (no browser, no network).
 *
 * The one behaviour that costs the whole feature if it regresses: the relay must inject the
 * upstream's `Proxy-Authorization: Basic …` on the CONNECT it opens, because headless Chromium
 * cannot do that itself (measured 2026-09-16). Everything else here pins the URL/credential
 * plumbing that feeds it.
 */
import * as net from 'node:net';

import { ProxyAgent } from 'undici';

import {
  authenticatedProxyUrl,
  basicAuthHeader,
  createProxyDispatcher,
  parseProxyServer,
  relayUpstreamFrom,
  startProxyRelay,
  type ProxyRelay,
} from './proxy-relay';

describe('proxy URL helpers', () => {
  it('basicAuthHeader is RFC-7617 Basic base64(user:pass)', () => {
    expect(basicAuthHeader('exit', 'pw')).toBe(`Basic ${Buffer.from('exit:pw').toString('base64')}`);
  });

  it('parses scheme://host:port for http, https and socks5', () => {
    expect(parseProxyServer('http://proxy.example:3128')).toEqual({
      scheme: 'http',
      host: 'proxy.example',
      port: 3128,
    });
    expect(parseProxyServer('https://secure.example:8443').scheme).toBe('https');
    expect(parseProxyServer('socks5://exit.example:1080').port).toBe(1080);
  });

  it('reassembles the authenticated URL, percent-encoding the credentials', () => {
    // A ':' or '@' in the password must not corrupt the URL undici parses.
    expect(authenticatedProxyUrl({ server: 'http://p:3128', username: 'u', password: 'a:b@c' })).toBe(
      'http://u:a%3Ab%40c@p:3128',
    );
    // No credentials => server unchanged.
    expect(
      authenticatedProxyUrl({ server: 'http://p:3128', username: null, password: null }),
    ).toBe('http://p:3128');
  });

  it('relayUpstreamFrom carries host/port/tls/mode and the pre-emptive Basic header', () => {
    expect(relayUpstreamFrom({ server: 'https://p:8443', username: 'u', password: 'pw' })).toEqual({
      mode: 'http-connect',
      host: 'p',
      port: 8443,
      tls: true,
      auth: basicAuthHeader('u', 'pw'),
      username: 'u',
      password: 'pw',
    });
    expect(relayUpstreamFrom({ server: 'http://p:3128', username: 'u', password: 'pw' }).tls).toBe(
      false,
    );
  });

  it('relayUpstreamFrom maps socks5 to the RFC 1929 mode with carried credentials', () => {
    expect(
      relayUpstreamFrom({ server: 'socks5://exit.example:1080', username: 'res', password: 'k3y' }),
    ).toEqual({
      mode: 'socks5',
      host: 'exit.example',
      port: 1080,
      tls: false,
      auth: '',
      username: 'res',
      password: 'k3y',
    });
  });
});

describe('createProxyDispatcher', () => {
  it('returns null when there is no proxy', async () => {
    expect(await createProxyDispatcher(null)).toBeNull();
  });

  it('builds an undici ProxyAgent from the authenticated URL when a proxy is set', async () => {
    const dispatcher = await createProxyDispatcher({
      server: 'http://p:3128',
      username: 'u',
      password: 'pw',
    });
    expect(dispatcher).toBeInstanceOf(ProxyAgent);
    // Close it so the test leaves no open handle.
    await (dispatcher as ProxyAgent).close();
  });
});

/**
 * A stand-in upstream HTTP proxy: it records the CONNECT request it receives, answers 200, and then
 * echoes tunnelled bytes back — enough to prove the relay both authenticated and spliced the sockets.
 */
function fakeUpstreamProxy(): Promise<{
  host: string;
  port: number;
  connectRequest: Promise<string>;
  close: () => void;
}> {
  let resolveRequest: (value: string) => void;
  const connectRequest = new Promise<string>((resolve) => {
    resolveRequest = resolve;
  });

  const server = net.createServer((socket: net.Socket) => {
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const separator = head.indexOf('\r\n\r\n');
      if (separator === -1) {
        socket.once('data', onData);
        return;
      }
      resolveRequest(head.subarray(0, separator).toString('latin1'));
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      // Everything after the CONNECT head is tunnel payload; echo it so the client can verify.
      const rest = head.subarray(separator + 4);
      if (rest.length > 0) socket.write(rest);
      socket.on('data', (payload: Buffer) => socket.write(payload));
    };
    socket.once('data', onData);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolve({
        host: '127.0.0.1',
        port: address.port,
        connectRequest,
        close: () => server.close(),
      });
    });
  });
}

/**
 * A stand-in credentialed SOCKS5 upstream. It always demands the RFC 1929 username/password
 * sub-negotiation (when `acceptAuth`), records the credentials and the CONNECT target, answers the
 * tunnel, and then echoes tunnelled bytes — enough to prove the relay authenticates and splices.
 */
function fakeSocks5Proxy(acceptAuth = true): Promise<{
  port: number;
  credentials: Promise<{ user: string; pass: string }>;
  target: Promise<{ host: string; port: number }>;
  close: () => void;
}> {
  let resolveCredentials: (value: { user: string; pass: string }) => void;
  let resolveTarget: (value: { host: string; port: number }) => void;
  const credentials = new Promise<{ user: string; pass: string }>((resolve) => {
    resolveCredentials = resolve;
  });
  const target = new Promise<{ host: string; port: number }>((resolve) => {
    resolveTarget = resolve;
  });

  const server = net.createServer((socket: net.Socket) => {
    let input = Buffer.alloc(0);
    let stage: 'greeting' | 'auth' | 'request' = 'greeting';
    const onData = (chunk: Buffer): void => {
      input = Buffer.concat([input, chunk]);
      for (;;) {
        if (stage === 'greeting') {
          if (input.length < 2) break;
          const nmethods = input.readUInt8(1);
          if (input.length < 2 + nmethods) break;
          input = input.subarray(2 + nmethods);
          socket.write(Buffer.from([0x05, 0x02]));
          stage = 'auth';
          continue;
        }
        if (stage === 'auth') {
          if (input.length < 2) break;
          const ulen = input.readUInt8(1);
          if (input.length < 2 + ulen + 1) break;
          const plen = input.readUInt8(2 + ulen);
          if (input.length < 2 + ulen + 1 + plen) break;
          const user = input.subarray(2, 2 + ulen).toString('utf8');
          const pass = input.subarray(2 + ulen + 1, 2 + ulen + 1 + plen).toString('utf8');
          input = input.subarray(2 + ulen + 1 + plen);
          resolveCredentials({ user, pass });
          socket.write(Buffer.from([0x01, acceptAuth ? 0x00 : 0x01]));
          stage = 'request';
          continue;
        }
        if (stage === 'request') {
          if (input.length < 4) break;
          const atyp = input.readUInt8(3);
          if (atyp === 0x03 && input.length < 5) break;
          const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : input.readUInt8(4);
          const addrStart = atyp === 0x03 ? 5 : 4;
          if (input.length < addrStart + addrLen + 2) break;
          const host =
            atyp === 0x03
              ? input.subarray(addrStart, addrStart + addrLen).toString('utf8')
              : input.subarray(addrStart, addrStart + addrLen).toString('hex');
          const port = input.readUInt16BE(addrStart + addrLen);
          const addr = input.subarray(addrStart, addrStart + addrLen);
          input = input.subarray(addrStart + addrLen + 2);
          resolveTarget({ host, port });
          // RFC 1928: for ATYP 0x03 the reply's BND.ADDR carries the same 1-byte length prefix the
          // request address did — a reply without it would stall a standards-conformant client.
          const boundAddr = atyp === 0x03 ? Buffer.concat([Buffer.from([addrLen]), addr]) : addr;
          socket.write(
            Buffer.concat([
              Buffer.from([0x05, 0x00, 0x00, atyp]),
              boundAddr,
              Buffer.from([(port >> 8) & 0xff, port & 0xff]),
            ]),
          );
          socket.removeListener('data', onData);
          socket.on('data', (payload: Buffer) => socket.write(payload));
          return;
        }
        break;
      }
    };
    socket.on('data', onData);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolve({ port: address.port, credentials, target, close: () => server.close() });
    });
  });
}

describe('startProxyRelay — the CONNECT auth injection', () => {
  let relay: ProxyRelay | null = null;
  let upstream: Awaited<ReturnType<typeof fakeUpstreamProxy>> | null = null;

  afterEach(() => {
    relay?.close();
    upstream?.close();
    relay = null;
    upstream = null;
  });

  it('injects the upstream Basic auth on the CONNECT and then tunnels bytes both ways', async () => {
    upstream = await fakeUpstreamProxy();
    const auth = basicAuthHeader('exit', 'sekret');
    relay = await startProxyRelay({
      mode: 'http-connect',
      host: upstream.host,
      port: upstream.port,
      tls: false,
      auth,
      username: 'exit',
      password: 'sekret',
    });

    const client = net.connect(relay.port, '127.0.0.1');
    const clientData: Buffer[] = [];
    client.on('data', (chunk: Buffer) => clientData.push(chunk));

    await new Promise<void>((resolve) => client.on('connect', () => resolve()));
    // Chromium's CONNECT never carries auth — the relay adds it.
    client.write('CONNECT agents.ichancy.com:443 HTTP/1.1\r\nHost: agents.ichancy.com:443\r\n\r\n');

    // The relay must acknowledge the tunnel to the client.
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (Buffer.concat(clientData).toString('latin1').includes('200')) resolve();
        else client.once('data', check);
      };
      client.once('data', check);
    });

    const requestSeenUpstream = await upstream.connectRequest;
    expect(requestSeenUpstream).toContain('CONNECT agents.ichancy.com:443');
    // THE POINT: the credentials the relay was built with reached the upstream, pre-emptively.
    expect(requestSeenUpstream).toContain(`Proxy-Authorization: ${auth}`);

    // And the tunnel is live: bytes the client sends come back through the echo upstream.
    const echoed = new Promise<string>((resolve) => {
      client.on('data', () => {
        const seen = Buffer.concat(clientData).toString('latin1');
        if (seen.includes('ping-through-tunnel')) resolve(seen);
      });
    });
    client.write('ping-through-tunnel');
    expect(await echoed).toContain('ping-through-tunnel');

    client.destroy();
  });

  it('answers 502 and does not hang when the upstream refuses the CONNECT', async () => {
    // A proxy that denies the CONNECT (bad auth, blocked host) must not leave Chromium waiting.
    const denier = await new Promise<{ port: number; close: () => void }>((resolve) => {
      const server = net.createServer((socket: net.Socket) => {
        socket.once('data', () => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as net.AddressInfo;
        resolve({ port: address.port, close: () => server.close() });
      });
    });
    relay = await startProxyRelay({
      mode: 'http-connect',
      host: '127.0.0.1',
      port: denier.port,
      tls: false,
      auth: basicAuthHeader('u', 'p'),
      username: 'u',
      password: 'p',
    });

    const client = net.connect(relay.port, '127.0.0.1');
    const seen = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      client.on('connect', () => client.write('CONNECT x:443 HTTP/1.1\r\nHost: x:443\r\n\r\n'));
      client.on('data', (chunk: Buffer) => chunks.push(chunk));
      client.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
    });

    expect(seen).toContain('502');
    denier.close();
  });

  it('fronts a credentialed SOCKS5 upstream: RFC 1929 auth then a tunnel to the CONNECT target', async () => {
    const socks = await fakeSocks5Proxy();
    relay = await startProxyRelay({
      mode: 'socks5',
      host: '127.0.0.1',
      port: socks.port,
      tls: false,
      auth: '',
      username: 'res',
      password: 'k3y',
    });

    const client = net.connect(relay.port, '127.0.0.1');
    const clientData: Buffer[] = [];
    client.on('data', (chunk: Buffer) => clientData.push(chunk));

    await new Promise<void>((resolve) => client.on('connect', () => resolve()));
    client.write('CONNECT agents.ichancy.com:443 HTTP/1.1\r\nHost: agents.ichancy.com:443\r\n\r\n');

    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (Buffer.concat(clientData).toString('latin1').includes('200')) resolve();
        else client.once('data', check);
      };
      client.once('data', check);
    });

    // The relay must have performed the RFC 1929 sub-negotiation with the configured credentials…
    expect(await socks.credentials).toEqual({ user: 'res', pass: 'k3y' });
    // …and forwarded exactly the client's CONNECT target inside the SOCKS5 CONNECT request.
    expect(await socks.target).toEqual({ host: 'agents.ichancy.com', port: 443 });

    // And the tunnel is live end to end through the SOCKS5 hop.
    const echoed = new Promise<string>((resolve) => {
      client.on('data', () => {
        const seen = Buffer.concat(clientData).toString('latin1');
        if (seen.includes('socks-ping')) resolve(seen);
      });
    });
    client.write('socks-ping');
    expect(await echoed).toContain('socks-ping');

    client.destroy();
    socks.close();
  });

  it('answers 502 when the SOCKS5 upstream rejects the credentials', async () => {
    const socks = await fakeSocks5Proxy(false);
    relay = await startProxyRelay({
      mode: 'socks5',
      host: '127.0.0.1',
      port: socks.port,
      tls: false,
      auth: '',
      username: 'res',
      password: 'wrong',
    });

    const client = net.connect(relay.port, '127.0.0.1');
    const seen = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      client.on('connect', () => client.write('CONNECT x:443 HTTP/1.1\r\nHost: x:443\r\n\r\n'));
      client.on('data', (chunk: Buffer) => chunks.push(chunk));
      client.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
    });

    expect(seen).toContain('502');
    socks.close();
  });
});
