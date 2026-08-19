/**
 * WHY: consumers inject ICHANCY_PORT and never learn which adapter they got. The choice is made
 * once, here, from ICHANCY_FAKE — so a dev machine, an e2e run and production differ by an env var
 * instead of by an `if (isTest)` sprinkled through the money path.
 *
 * Both adapters are constructed either way (Nest instantiates a module's providers eagerly), which
 * is free: nothing here opens a connection at construction time — the Redis connection belongs to
 * @core/cache and the HTTP client only dials on the first call. So an e2e run on the fake never
 * touches Ichancy or a socket of its own.
 *
 * ASSUMPTIONS about other agents' code (both verified against the files on disk):
 *  - `PrismaModule` (@Global) provides PrismaService — injected by IchancyCallLogService.
 *  - `CacheModule` (@Global) provides RedisService + LockService — injected by the session store.
 *  - ICHANCY_FAKE IS now declared in env.schema.ts and read via AppConfigService.
 *    It previously was not, and that was a live safety hole rather than a tidiness issue:
 *    @nestjs/config parses .env with dotenv.parse() (which does not touch process.env) and then
 *    copies only the VALIDATED keys across. An undeclared key is stripped by the schema, so
 *    `process.env.ICHANCY_FAKE` read undefined no matter what .env said, and the factory quietly
 *    selected the REAL adapter. A deployment that set ICHANCY_FAKE=true and a real base URL would
 *    have moved real money while believing it was in fake mode.
 */
import { Logger, Module, type Provider } from '@nestjs/common';
import { AppConfigService } from '@core/config/config.service';
import { FakeIchancyAdapter } from './fake-ichancy.adapter';
import { HttpIchancyAdapter } from './http-ichancy.adapter';
import { ICHANCY_CALL_LOG, IchancyCallLogService } from './ichancy-call-log.service';
import { ICHANCY_AUTH_CLIENT, IchancyHttpClient } from './ichancy-http.client';
import { IchancySessionService } from './ichancy-session.service';
import { ICHANCY_SESSION_STORE, RedisIchancySessionStore } from './ichancy-session.store';
import { ICHANCY_PORT, type IchancyPort } from './ichancy.port';
import { IchancyCheckCommand } from './commands/ichancy-check.command';
import { BrowserIchancyTransport } from './transport/browser.transport';
import { FetchIchancyTransport } from './transport/fetch.transport';
import { ICHANCY_TRANSPORT, type IchancyTransport } from './transport/ichancy-transport';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * Fake unless explicitly told otherwise; NODE_ENV=test defaults to the fake so no test can ever
 * reach the real agent API by forgetting a flag (that would move real money).
 */
export function isFakeIchancyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['ICHANCY_FAKE'];
  if (raw !== undefined && raw.trim().length > 0) return TRUTHY.has(raw.trim().toLowerCase());
  return env['NODE_ENV'] === 'test';
}

const portProvider: Provider = {
  provide: ICHANCY_PORT,
  // Resolved from VALIDATED config, never from raw process.env: @nestjs/config parses .env with
  // dotenv.parse(), which does not populate process.env, so reading the flag there returned
  // undefined and silently selected the real adapter. See ICHANCY_FAKE in env.schema.ts.
  useFactory: (
    config: AppConfigService,
    http: HttpIchancyAdapter,
    fake: FakeIchancyAdapter,
  ): IchancyPort => {
    const useFake = config.ichancy.fake;
    new Logger('IchancyModule').log(
      useFake
        ? 'Ichancy adapter: FAKE (in-memory). No real money can move.'
        : `Ichancy adapter: REAL -> ${config.ichancy.baseUrl}`,
    );
    return useFake ? fake : http;
  },
  inject: [AppConfigService, HttpIchancyAdapter, FakeIchancyAdapter],
};

/**
 * WHICH TRANSPORT the HTTP client uses — Node's fetch, or a real Chromium.
 *
 * Both are constructed either way, which is free: neither opens anything at construction time (the
 * browser is launched lazily on the first call, and only if it is the one selected). Selecting by
 * env keeps "how bytes leave the process" a deployment decision rather than a code change — the same
 * reasoning as the fake/real adapter split above.
 */
const transportProvider: Provider = {
  provide: ICHANCY_TRANSPORT,
  useFactory: (
    config: AppConfigService,
    fetchTransport: FetchIchancyTransport,
    browserTransport: BrowserIchancyTransport,
  ): IchancyTransport => {
    const useBrowser = config.ichancy.transport === 'browser';
    new Logger('IchancyModule').log(
      useBrowser
        ? 'Ichancy transport: BROWSER (Chromium solves the Cloudflare challenge itself)'
        : 'Ichancy transport: fetch',
    );
    return useBrowser ? browserTransport : fetchTransport;
  },
  inject: [AppConfigService, FetchIchancyTransport, BrowserIchancyTransport],
};

@Module({
  providers: [
    IchancyCallLogService,
    { provide: ICHANCY_CALL_LOG, useExisting: IchancyCallLogService },
    FetchIchancyTransport,
    BrowserIchancyTransport,
    transportProvider,
    IchancyHttpClient,
    { provide: ICHANCY_AUTH_CLIENT, useExisting: IchancyHttpClient },
    RedisIchancySessionStore,
    { provide: ICHANCY_SESSION_STORE, useExisting: RedisIchancySessionStore },
    IchancySessionService,
    HttpIchancyAdapter,
    FakeIchancyAdapter,
    portProvider,
    // A read-only diagnostic; nest-commander only instantiates it when main.cli.ts drives the app,
    // exactly as TelegramModule carries webhook:set and bot:setup.
    IchancyCheckCommand,
  ],
  exports: [
    ICHANCY_PORT,
    // The worker's warm-up/health checks call ensureSession()/describe(); tests script the fake.
    IchancySessionService,
    FakeIchancyAdapter,
  ],
})
export class IchancyModule {}
