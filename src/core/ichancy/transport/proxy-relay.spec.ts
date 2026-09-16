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

  it('relayUpstreamFrom carries host/port/tls and the pre-emptive Basic header', () => {
    expect(relayUpstreamFrom({ server: 'https://p:8443', username: 'u', password: 'pw' })).toEqual({
      host: 'p',
      port: 8443,
      tls: true,
      auth: basicAuthHeader('u', 'pw'),
    });
    expect(relayUpstreamFrom({ server: 'http://p:3128', username: 'u', password: 'pw' }).tls).toBe(
      false,
    );
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
    relay = await startProxyRelay({ host: upstream.host, port: upstream.port, tls: false, auth });

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
      host: '127.0.0.1',
      port: denier.port,
      tls: false,
      auth: basicAuthHeader('u', 'p'),
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
});
