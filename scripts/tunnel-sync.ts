/**
 * One command to point Telegram at the tunnel that is running right now:
 * read ngrok's public URL, write it to .env as API_BASE_URL, then run webhook:set.
 *
 * WHY this exists: doing it by hand is three steps, and step one is the dangerous one. ngrok's web
 * UI moves to 4041 when 4040 is taken, so a second ngrok (or a leftover from a previous session)
 * silently serves a DIFFERENT tunnel on the port you looked at. That exact mistake pointed Telegram
 * at a stranger's tunnel once already; every update went nowhere and the bot looked dead. So this
 * script scans every ngrok web port, keeps only tunnels that forward to OUR port, and refuses to
 * guess when there is more than one.
 *
 * Usage:  npm run tunnel:sync
 * (start `ngrok http 3000` in another terminal first)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** ngrok's local dashboard: 4040 normally, 4041+ when another agent already holds it. */
const NGROK_WEB_PORTS = [4040, 4041, 4042];
const ENV_FILE = '.env';

interface NgrokTunnel {
  public_url: string;
  proto: string;
  config?: { addr?: string };
}

async function fetchTunnels(port: number): Promise<NgrokTunnel[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/tunnels`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { tunnels?: NgrokTunnel[] };
    return body.tunnels ?? [];
  } catch {
    return []; // nothing listening there — normal
  }
}

/** The local port our API serves on, read from .env so the two cannot drift. */
function apiPort(env: string): string {
  return /^PORT=(\d+)/m.exec(env)?.[1] ?? '3000';
}

async function main(): Promise<void> {
  if (!existsSync(ENV_FILE)) throw new Error('.env not found. Copy .env.example to .env first.');
  const env = readFileSync(ENV_FILE, 'utf8');
  const port = apiPort(env);

  const found: Array<{ url: string; webPort: number; addr: string }> = [];
  for (const webPort of NGROK_WEB_PORTS) {
    for (const t of await fetchTunnels(webPort)) {
      const addr = t.config?.addr ?? '';
      // Keep only https tunnels that actually forward to OUR api port. A tunnel pointing somewhere
      // else belongs to another project and must never be registered as our webhook.
      if (t.public_url.startsWith('https://') && addr.endsWith(`:${port}`)) {
        found.push({ url: t.public_url, webPort, addr });
      }
    }
  }

  if (found.length === 0) {
    throw new Error(
      `No ngrok tunnel forwarding to localhost:${port}.\n` +
        `Start one in another terminal:   ngrok http ${port}`,
    );
  }
  if (found.length > 1) {
    // Refusing beats picking: the wrong choice fails silently for hours.
    const list = found.map((f) => `  ${f.url}  (ngrok UI :${f.webPort} -> ${f.addr})`).join('\n');
    throw new Error(
      `More than one ngrok tunnel points at localhost:${port}; refusing to guess.\n${list}\n` +
        `Stop the extras and re-run. Only ONE ngrok should be running.`,
    );
  }

  const url = found[0]!.url;
  const current = /^API_BASE_URL=(.*)$/m.exec(env)?.[1]?.trim();

  if (current === url) {
    console.log(`API_BASE_URL already ${url} — no change`);
  } else {
    const next = /^API_BASE_URL=.*$/m.test(env)
      ? env.replace(/^API_BASE_URL=.*$/m, `API_BASE_URL=${url}`)
      : `${env.replace(/\s*$/, '')}\nAPI_BASE_URL=${url}\n`;
    writeFileSync(ENV_FILE, next);
    console.log(`API_BASE_URL  ${current ?? '(unset)'}  ->  ${url}`);
  }

  console.log('Registering the webhook with Telegram...\n');
  // Spawned rather than imported so it reads the .env we just wrote, not a stale in-process copy.
  const done = spawnSync('npm', ['run', 'webhook:set'], { stdio: 'inherit', shell: true });
  if (done.status !== 0) throw new Error(`webhook:set exited with ${String(done.status)}`);
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
