/**
 * THE PROXY RELAY — how the Ichancy egress reaches a CREDENTIALED forward proxy.
 *
 * ══ WHY THIS EXISTS (measured on the VPS 2026-09-16) ══════════════════════════════════════════
 * Headless Chromium CANNOT authenticate to an HTTP forward proxy on an HTTPS target. Given
 * `chromium.launch({ proxy: { server, username, password } })` against agents.ichancy.com the
 * CONNECT fails with net::ERR_PROXY_CONNECTION_FAILED — even though the proxy answers a perfectly
 * correct `407 Proxy Authentication Required` with `Proxy-Authenticate: Basic`. The headless build
 * simply never replays the CONNECT with credentials. Passing the credentials to launch is therefore
 * a dead end and is deliberately not shipped.
 *
 * What DOES work, proven end to end: a tiny in-process CONNECT relay on 127.0.0.1 that speaks plain
 * CONNECT to Chromium (no auth) and injects the upstream `Proxy-Authorization` PRE-EMPTIVELY on the
 * CONNECT it opens to the real proxy. Chromium never sees a 407. The in-page signin POST then
 * returned real Ichancy JSON (HTTP 401 for dummy creds) through the edge instead of the block page.
 *
 * undici's ProxyAgent (the fetch transport) needs none of this — it handles proxy Basic auth from
 * the URL itself. This relay is only for Chromium.
 */
import * as net from 'node:net';
import * as tls from 'node:tls';

/** Pre-emptive `Proxy-Authorization` header value from a username and password. */
export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

/** The proxy fields as AppConfigService exposes them: server never carries the credentials. */
export interface ProxySettings {
  readonly server: string;
  readonly username: string | null;
  readonly password: string | null;
}

/** `scheme://host:port` split into its parts. The env schema guarantees this exact shape. */
export function parseProxyServer(server: string): {
  scheme: string;
  host: string;
  port: number;
} {
  const match = /^([a-z0-9]+):\/\/(.+):(\d{1,5})$/i.exec(server);
  const scheme = match?.[1];
  const host = match?.[2];
  const port = match?.[3];
  if (scheme === undefined || host === undefined || port === undefined) {
    throw new Error(`ICHANCY_PROXY_URL is not scheme://host:port: ${server}`);
  }
  return { scheme: scheme.toLowerCase(), host, port: Number(port) };
}

/**
 * The full authenticated proxy URL for undici's ProxyAgent, reassembled from the credential-free
 * `server` plus the separate username/password. undici reads the userinfo and sets
 * `Proxy-Authorization: Basic …` itself. Returns `server` unchanged when there are no credentials.
 * Credentials are percent-encoded so a `@` or `:` in a password cannot corrupt the URL.
 */
export function authenticatedProxyUrl(proxy: ProxySettings): string {
  if (proxy.username === null && proxy.password === null) return proxy.server;
  const match = /^([a-z0-9]+:\/\/)(.*)$/i.exec(proxy.server);
  const scheme = match?.[1];
  const rest = match?.[2];
  if (scheme === undefined || rest === undefined) return proxy.server;
  const user = encodeURIComponent(proxy.username ?? '');
  const pass = encodeURIComponent(proxy.password ?? '');
  return `${scheme}${user}:${pass}@${rest}`;
}

/** undici's Dispatcher, built lazily so `undici` need not be imported unless a proxy is configured. */
export async function createProxyDispatcher(proxy: ProxySettings | null): Promise<unknown> {
  if (proxy === null) return null;
  // Dynamic so the fetch transport's proxy support adds no static dependency to the browser path.
  const { ProxyAgent } = await import('undici');
  return new ProxyAgent(authenticatedProxyUrl(proxy));
}

/** The upstream a relay tunnels to. `auth` is the whole `Basic <base64>` header value. */
export interface RelayUpstream {
  readonly host: string;
  readonly port: number;
  /** true when the proxy URL scheme is https (TLS to the proxy itself); false for plain http. */
  readonly tls: boolean;
  readonly auth: string;
}

/** Build the relay upstream from the proxy settings; the credentials become a pre-emptive header. */
export function relayUpstreamFrom(proxy: ProxySettings): RelayUpstream {
  const parsed = parseProxyServer(proxy.server);
  return {
    host: parsed.host,
    port: parsed.port,
    tls: parsed.scheme === 'https',
    auth: basicAuthHeader(proxy.username ?? '', proxy.password ?? ''),
  };
}

export interface ProxyRelay {
  /** The loopback port Chromium is launched against, as `http://127.0.0.1:<port>`. */
  readonly port: number;
  /** Stop accepting and drop every in-flight socket. Called once, when the browser closes. */
  close(): void;
}

/** How long one upstream CONNECT handshake may take before the client socket is dropped. */
const CONNECT_TIMEOUT_MS = 30_000;
/** Caps on how much we buffer before a `\r\n` while parsing a request/response head — abuse guard. */
const MAX_HEAD_BYTES = 64 * 1024;

/**
 * Start the relay. Binds a random loopback (IPv4 127.0.0.1) port, so nothing off the box can reach
 * it, and resolves once it is listening. One relay per browser lifetime; `close()` tears it down.
 */
export function startProxyRelay(up: RelayUpstream): Promise<ProxyRelay> {
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket): void => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  };

  const server = net.createServer((client: net.Socket) => {
    track(client);
    client.on('error', () => client.destroy());

    // Read the client's CONNECT request line. Chromium sends it as the first bytes on the socket;
    // buffer until the first CRLF in case the line is fragmented.
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const lineEnd = head.indexOf('\r\n');
      if (lineEnd === -1) {
        if (head.length > MAX_HEAD_BYTES) client.destroy();
        else client.once('data', onData);
        return;
      }
      const requestLine = head.subarray(0, lineEnd).toString('latin1');
      const match = /^CONNECT\s+(\S+)\s/i.exec(requestLine);
      const target = match?.[1];
      if (target === undefined) {
        client.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n');
        return;
      }
      openUpstream(client, target, up, track);
    };
    client.once('data', onData);
  });

  return new Promise<ProxyRelay>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('proxy relay did not bind to a TCP port'));
        return;
      }
      resolve({
        port: address.port,
        close: () => {
          server.close();
          for (const socket of sockets) socket.destroy();
          sockets.clear();
        },
      });
    });
  });
}

/**
 * Open the authenticated tunnel to the upstream proxy for one client CONNECT, and — once the proxy
 * answers 200 — splice the two sockets together. Any failure closes both sides; the client is told
 * with a 502 only while it is still expecting the CONNECT reply.
 */
function openUpstream(
  client: net.Socket,
  target: string,
  up: RelayUpstream,
  track: (socket: net.Socket) => void,
): void {
  const upstream = up.tls
    ? tls.connect({ host: up.host, port: up.port, servername: up.host })
    : net.connect(up.port, up.host);
  track(upstream);

  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    client.destroy();
    upstream.destroy();
  }, CONNECT_TIMEOUT_MS);

  const sendConnect = (): void => {
    upstream.write(
      `CONNECT ${target} HTTP/1.1\r\n` +
        `Host: ${target}\r\n` +
        `Proxy-Authorization: ${up.auth}\r\n` +
        'Proxy-Connection: keep-alive\r\n\r\n',
    );
  };
  if (up.tls) upstream.once('secureConnect', sendConnect);
  else upstream.once('connect', sendConnect);

  let response = Buffer.alloc(0);
  const onData = (chunk: Buffer): void => {
    if (settled) return;
    response = Buffer.concat([response, chunk]);
    const separator = response.indexOf('\r\n\r\n');
    if (separator === -1) {
      if (response.length > MAX_HEAD_BYTES) fail();
      return;
    }
    const statusLine = response.subarray(0, response.indexOf('\r\n')).toString('latin1');
    if (!/^HTTP\/\d(?:\.\d)?\s+200\b/i.test(statusLine)) {
      fail();
      return;
    }
    settled = true;
    clearTimeout(timer);
    upstream.removeListener('data', onData);
    client.write('HTTP/1.1 200 Connection established\r\n\r\n');
    // Bytes the upstream sent after its CONNECT reply belong to the tunnel and must not be lost.
    const leftover = response.subarray(separator + 4);
    if (leftover.length > 0) client.write(leftover);
    upstream.pipe(client);
    client.pipe(upstream);
    // The pre-established error handlers below already tear both sides down once settled.
  };
  const fail = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    upstream.destroy();
  };
  upstream.on('data', onData);
  upstream.on('error', () => {
    if (settled) client.destroy();
    else fail();
  });
  client.on('error', () => upstream.destroy());
}
