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
 * The same relay also front-ends a CREDENTIALED SOCKS5 proxy (RFC 1928 + RFC 1929 username/password
 * sub-negotiation). Chromium speaks plain SOCKS5 without auth natively, but it has NO support for
 * SOCKS5 authentication — a credentialed SOCKS5 upstream therefore fails inside the browser unless
 * the relay terminates the auth handshake for it.
 *
 * undici's ProxyAgent (the fetch transport) needs none of this — it handles proxy Basic auth from
 * the URL itself and ships its own SOCKS5 client. This relay is only for Chromium.
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

/** How the relay talks to the upstream proxy. */
export type RelayMode = 'http-connect' | 'socks5';

/** The upstream a relay tunnels to. `auth` is the whole `Basic <base64>` header value (connect mode). */
export interface RelayUpstream {
  readonly mode: RelayMode;
  readonly host: string;
  readonly port: number;
  /** true when the proxy URL scheme is https (TLS to the proxy itself); false for plain http. */
  readonly tls: boolean;
  /** http-connect only: the pre-emptive `Proxy-Authorization` header value. */
  readonly auth: string;
  /** socks5 only: the RFC 1929 username (empty when the proxy needs none). */
  readonly username: string;
  /** socks5 only: the RFC 1929 password (empty when the proxy needs none). */
  readonly password: string;
}

/** Build the relay upstream from the proxy settings; the credentials become a pre-emptive header. */
export function relayUpstreamFrom(proxy: ProxySettings): RelayUpstream {
  const parsed = parseProxyServer(proxy.server);
  const socks5 = parsed.scheme === 'socks5';
  return {
    mode: socks5 ? 'socks5' : 'http-connect',
    host: parsed.host,
    port: parsed.port,
    tls: parsed.scheme === 'https',
    auth: socks5 ? '' : basicAuthHeader(proxy.username ?? '', proxy.password ?? ''),
    username: proxy.username ?? '',
    password: proxy.password ?? '',
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
 * answers — splice the two sockets together. Any failure closes both sides; the client is told
 * with a 502 only while it is still expecting the CONNECT reply.
 */
function openUpstream(
  client: net.Socket,
  target: string,
  up: RelayUpstream,
  track: (socket: net.Socket) => void,
): void {
  if (up.mode === 'socks5') {
    openSocks5Upstream(client, target, up, track);
    return;
  }
  openHttpConnectUpstream(client, target, up, track);
}

/** RFC 1928 constants. */
const SOCKS5_METHOD_NO_AUTH = 0x00;
const SOCKS5_METHOD_USER_PASS = 0x02;
const SOCKS5_METHOD_NONE = 0xff;
const SOCKS5_CMD_CONNECT = 0x01;
const SOCKS5_ATYP_IPV4 = 0x01;
const SOCKS5_ATYP_DOMAIN = 0x03;
const SOCKS5_ATYP_IPV6 = 0x04;

/** Parse a CONNECT target (`host:port`, `[v6]:port`) into host + port, or null when malformed. */
function splitTarget(target: string): { host: string; port: number } | null {
  const trimmed = target.trim();
  if (trimmed.length === 0) return null;
  let host: string;
  let portRaw: string;
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    if (close === -1) return null;
    host = trimmed.slice(1, close);
    portRaw = trimmed.slice(close + 1);
    if (!portRaw.startsWith(':')) return null;
    portRaw = portRaw.slice(1);
  } else {
    const colon = trimmed.lastIndexOf(':');
    if (colon === -1) return null;
    host = trimmed.slice(0, colon);
    portRaw = trimmed.slice(colon + 1);
  }
  const port = Number(portRaw);
  if (host.length === 0 || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/** Build the SOCKS5 CONNECT request (atyp: IPv4 literal, IPv6 literal, or domain name). */
function socks5ConnectRequest(host: string, port: number): Buffer | null {
  const parts: number[] = [0x05, SOCKS5_CMD_CONNECT, 0x00];
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    parts.push(SOCKS5_ATYP_IPV4, ...host.split('.').map((part) => Number(part)));
  } else if (ipVersion === 6) {
    // No ripe IPv6 literals in practice (targets are hostnames); sent as a domain string. Most
    // residential proxies resolve it or reject it the same way they would reject a bad name.
    parts.push(SOCKS5_ATYP_DOMAIN, host.length, ...Buffer.from(host, 'utf8'));
  } else {
    const label = Buffer.from(host, 'utf8');
    if (label.length === 0 || label.length > 255) return null;
    parts.push(SOCKS5_ATYP_DOMAIN, label.length, ...label);
  }
  parts.push((port >> 8) & 0xff, port & 0xff);
  return Buffer.from(parts);
}

/**
 * Front a CREDENTIALED SOCKS5 upstream. Performs the RFC 1928 method selection and, when the proxy
 * demands it, the RFC 1929 username/password sub-negotiation, then a CONNECT request for the
 * client's target. On success the bytes are spliced exactly like the HTTP CONNECT path.
 */
function openSocks5Upstream(
  client: net.Socket,
  target: string,
  up: RelayUpstream,
  track: (socket: net.Socket) => void,
): void {
  const upstream = net.connect(up.port, up.host);
  track(upstream);

  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    client.destroy();
    upstream.destroy();
  }, CONNECT_TIMEOUT_MS);

  const fail = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    upstream.destroy();
  };

  const decided = splitTarget(target);
  if (decided === null) {
    upstream.destroy();
    fail();
    return;
  }
  const hasAuth = up.username.length > 0 || up.password.length > 0;

  let input = Buffer.alloc(0);
  type Stage = 'greeting' | 'auth' | 'request';
  let stage: Stage = 'greeting';

  const sendRequest = (): void => {
    const request = socks5ConnectRequest(decided.host, decided.port);
    if (request === null) {
      fail();
      return;
    }
    upstream.write(request);
    stage = 'request';
  };

  const onData = (chunk: Buffer): void => {
    if (settled) return;
    input = Buffer.concat([input, chunk]);

    while (!settled) {
      if (stage === 'greeting') {
        // Reply: [version, method]
        if (input.length < 2) return;
        const version = input[0];
        const method = input[1];
        input = input.subarray(2);
        if (version !== 0x05 || method === SOCKS5_METHOD_NONE) return fail();
        if (method === SOCKS5_METHOD_NO_AUTH) {
          sendRequest();
          continue;
        }
        if (method === SOCKS5_METHOD_USER_PASS) {
          const user = Buffer.from(up.username, 'utf8');
          const pass = Buffer.from(up.password, 'utf8');
          if (user.length > 255 || pass.length > 255) return fail();
          upstream.write(Buffer.from([0x01, user.length, ...user, pass.length, ...pass]));
          stage = 'auth';
          continue;
        }
        return fail();
      }
      if (stage === 'auth') {
        // Reply: [version, status]
        if (input.length < 2) return;
        const status = input[1];
        input = input.subarray(2);
        if (status !== 0x00) return fail();
        sendRequest();
        continue;
      }
      // Reply: [ver, rep, rsv, atyp, addr, port]
      if (input.length < 4) return;
      const version = input[0];
      const rep = input[1];
      const atyp = input[3];
      if (version !== 0x05) return fail();
      let need = 4; // ver + rep + rsv + atyp
      if (atyp === SOCKS5_ATYP_IPV4) need += 4;
      else if (atyp === SOCKS5_ATYP_IPV6) need += 16;
      else if (atyp === SOCKS5_ATYP_DOMAIN) {
        if (input.length < 5) return;
        need += 1 + input.readUInt8(4);
      } else return fail();
      need += 2; // port
      if (input.length < need) return;
      const leftover = input.subarray(need);
      if (rep !== 0x00) return fail();
      settled = true;
      clearTimeout(timer);
      upstream.removeListener('data', onData);
      client.write('HTTP/1.1 200 Connection established\r\n\r\n');
      if (leftover.length > 0) client.write(leftover);
      upstream.pipe(client);
      client.pipe(upstream);
      return;
    }
  };

  upstream.once('connect', () => {
    const greeting = hasAuth
      ? Buffer.from([0x05, 0x02, SOCKS5_METHOD_USER_PASS, SOCKS5_METHOD_NO_AUTH])
      : Buffer.from([0x05, 0x01, SOCKS5_METHOD_NO_AUTH]);
    upstream.write(greeting);
  });
  upstream.on('data', onData);
  upstream.on('error', () => {
    if (settled) client.destroy();
    else fail();
  });
  client.on('error', () => upstream.destroy());
}

/** HTTP CONNECT path: inject the upstream `Proxy-Authorization` pre-emptively (see File header). */
function openHttpConnectUpstream(
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
