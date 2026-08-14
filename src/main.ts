// MUST be the first import in the process: it installs BigInt.prototype.toJSON. Money is bigint
// minor units everywhere, and without this every JSON.stringify of a response, a log line, a BullMQ
// payload or an audit row throws "Do not know how to serialize a BigInt" — at runtime, in
// production, on the money path. Importing it first means no module can serialise anything before
// the patch is in place.
import '@common/helpers/bigint-json';

import { Logger as NestLogger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger as PinoLogger } from 'nestjs-pino';

import { GlobalExceptionFilter } from '@common/filters/global-exception.filter';
import {
  CorrelationIdInterceptor,
  CORRELATION_ID_HEADER,
} from '@common/interceptors/correlation-id.interceptor';
import { TransformInterceptor } from '@common/interceptors/transform.interceptor';
import { AppConfigService } from '@core/config/config.service';
import { IDEMPOTENCY_HEADER } from '@core/idempotency/idempotency.constants';
import { findUnmatchedRules } from '@core/throttler/throttle-routes';

import { AppModule } from './app.module';
import { bodyParserErrorHandler, createBodyParsers } from './body-parser.middleware';
import { requestContextMiddleware } from './request-context.middleware';
import { WorkerModule } from './worker.module';

/**
 * The options BOTH entrypoints must use — `bootstrapApi()` and the e2e app factory. Exported so
 * they cannot drift: `bodyParser: false` is load-bearing (see body-parser.middleware.ts), and an
 * e2e app created without it would silently get Express' 100 KB default and fail every proof test
 * for a reason that has nothing to do with the code under test.
 */
export const API_APP_OPTIONS = {
  bodyParser: false,
} as const;

/**
 * Telegram renders a mini-app inside an iframe on web clients. Two consequences:
 *  1. X-Frame-Options must NOT be sent — it has no wildcard support, so any value we could pick
 *     would break either web.telegram.org or a future client. `frameguard: false` below.
 *  2. frame-ancestors is the CSP replacement that CAN express this, so it is set explicitly.
 * This service returns JSON rather than the mini-app's HTML, so these headers matter mainly for
 * /docs and for any future page — but getting them wrong is silent, so they are set once, here.
 */
const TELEGRAM_FRAME_ANCESTORS = [
  "'self'",
  'https://web.telegram.org',
  'https://*.telegram.org',
  'https://telegram.org',
];

function buildCspDirectives(
  isProduction: boolean,
  frameAncestors: readonly string[],
): Record<string, string[]> {
  if (isProduction) {
    // A JSON API needs to load nothing at all. 'none' everywhere means a reflected-content bug
    // cannot turn into script execution.
    return {
      'default-src': ["'none'"],
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
      'frame-ancestors': [...frameAncestors],
      'script-src': ["'none'"],
      'style-src': ["'none'"],
      'img-src': ["'none'"],
    };
  }

  // Non-production also serves Swagger UI at /docs, which ships inline scripts and styles.
  return {
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': [...frameAncestors],
    'script-src': ["'self'", "'unsafe-inline'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:'],
    'connect-src': ["'self'"],
  };
}

/**
 * A throttle rule whose pattern matches no registered route is a rate limit that has silently
 * switched itself off — the failure mode you discover during the incident it was meant to prevent.
 * The OpenAPI document is used as the route table because it is a supported API, unlike walking
 * Express' internal router stack, and it lists every path with its parameters intact.
 */
function verifyThrottleRules(document: OpenAPIObject, logger: NestLogger): void {
  const routes: { method: string; path: string }[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of Object.keys(item)) {
      routes.push({ method, path });
    }
  }

  const unmatched = findUnmatchedRules(routes);
  if (unmatched.length === 0) return;

  // Loud, but not fatal: refusing to boot the whole cashier because a rate limit lost its route
  // would trade a small risk for a total outage.
  logger.error(
    `Rate limiting is INACTIVE for ${unmatched.length} rule(s) — no route matches them: ` +
      unmatched.map((rule) => `${rule.name} (${rule.method} ${rule.samplePath})`).join(', '),
  );
}

/**
 * Everything that turns a bare Nest application into THIS api: middleware order, body-parser caps,
 * security headers, CORS, and the global pipe/filter/interceptor set.
 *
 * It is exported and called by the e2e app factory as well as by `bootstrapApi()`. That is the
 * point: an e2e suite that builds its own approximation of the middleware stack tests a server that
 * does not exist — it would happily pass while the real one rejects every proof upload on a body
 * limit, or strips a field the ValidationPipe was configured differently about.
 *
 * MUST be called before `app.init()`: `useBodyParser` only takes effect if the parsers have not
 * been registered yet, and middleware added afterwards would run after Nest's own.
 */
export function configureApiApp(app: NestExpressApplication, config: AppConfigService): void {
  // Guards, interceptors and Prisma all clean up on SIGTERM through this: BullMQ drains, the pg
  // pool ends, Redis quits. Without it a rolling deploy kills jobs mid-flight.
  app.enableShutdownHooks();

  // `1` = exactly one reverse proxy in front of us. NOT `true`: trusting every hop lets any client
  // spoof X-Forwarded-For, which would let them forge the IP the rate limiter counts against and
  // the IP written to audit rows.
  app.set('trust proxy', 1);

  // ---- middleware, in the order it must run ----------------------------------------------
  // FIRST, before pino-http and before any guard: pins the correlation id into the request headers
  // so the logger and the actor context agree on it, and installs the lazy `actor` getter that
  // turns AuthGuard's principal into the Actor the audit stamping reads. See the file header.
  app.use(requestContextMiddleware);

  // This api owns its body parsing (see API_APP_OPTIONS.bodyParser === false): one route needs
  // megabytes, nothing else may have them, and a malformed body must not be reported as a 500.
  // The error handler goes immediately after the parsers — Express walks the stack FORWARD from
  // the point of failure, so an error middleware placed earlier would never be reached.
  for (const parser of createBodyParsers()) app.use(parser);
  app.use(bodyParserErrorHandler);

  const frameAncestors = [...TELEGRAM_FRAME_ANCESTORS, ...config.app.miniAppOrigins];
  app.use(
    helmet({
      // See TELEGRAM_FRAME_ANCESTORS: X-Frame-Options cannot express "Telegram may frame this".
      frameguard: false,
      contentSecurityPolicy: {
        useDefaults: false,
        directives: buildCspDirectives(config.app.isProduction, frameAncestors),
      },
      // The mini-app is served from a different origin than this API.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginEmbedderPolicy: false,
      hsts: config.app.isProduction ? { maxAge: 15_552_000, includeSubDomains: true } : false,
    }),
  );

  // ---- CORS ------------------------------------------------------------------------------
  const allowedOrigins = new Set(config.app.miniAppOrigins);
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // No Origin header: curl, health probes, the Telegram webhook. Not a browser, so CORS is not
      // the control that protects these — the AuthGuard and the webhook secret are.
      if (origin === undefined || origin.length === 0) {
        callback(null, true);
        return;
      }
      // `false` omits the CORS headers so the browser blocks it. Passing an Error instead would
      // surface as a 500 and bury the real cause.
      callback(null, allowedOrigins.has(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', IDEMPOTENCY_HEADER, CORRELATION_ID_HEADER],
    // Without these the mini-app cannot read them: the correlation id it should show in an error
    // toast, and the rate-limit headers it should back off on.
    exposedHeaders: [
      CORRELATION_ID_HEADER,
      'retry-after',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
    ],
    maxAge: 86_400,
  });

  // ---- global pipes, filters, interceptors ------------------------------------------------
  app.useGlobalPipes(
    new ValidationPipe({
      // Strips unknown properties, then rejects the request if there were any. `whitelist` alone
      // would silently drop a misspelled field and act on the default instead — on a money endpoint
      // "amount" vs "amountMinor" must be an error, not a shrug.
      whitelist: true,
      forbidNonWhitelisted: true,
      // Required: the DTOs rely on @Type/@Transform (money strings, pagination, base64 data URLs).
      transform: true,
      // Implicit conversion would coerce "abc" to NaN and an empty string to 0. Every DTO that
      // needs a conversion declares it explicitly.
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.useGlobalFilters(new GlobalExceptionFilter());
  // ActorContextInterceptor is already global (APP_INTERCEPTOR in ActorContextModule) and runs
  // before these two; both of the ones below only read the id this middleware already pinned.
  app.useGlobalInterceptors(new CorrelationIdInterceptor(), new TransformInterceptor());
}

export async function bootstrapApi(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    ...API_APP_OPTIONS,
    // Buffer until pino is wired, so early boot lines are not lost and are not double-formatted.
    bufferLogs: true,
  });

  const config = app.get(AppConfigService);
  const logger = new NestLogger('Bootstrap');

  app.useLogger(app.get(PinoLogger));
  app.flushLogs();

  configureApiApp(app, config);

  // ---- OpenAPI ---------------------------------------------------------------------------
  // The document is built in every environment because the throttle self-check reads it, but it is
  // only SERVED outside production: /docs enumerates every admin endpoint and is not something to
  // publish next to a cashier.
  const documentConfig = new DocumentBuilder()
    .setTitle('Ichancy cashier API')
    .setDescription(
      'Telegram mini-app cashier. Players create deposits, upload proof, and are credited on the ' +
        'Ichancy agent API. All money is integer minor units of NSP (scale 2) as decimal strings.',
    )
    .setVersion('0.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
    .addGlobalParameters({
      name: IDEMPOTENCY_HEADER,
      in: 'header',
      required: false,
      schema: { type: 'string' },
      description: 'Required on POST /v1/deposits. Replays return the original result.',
    })
    .build();
  const document = SwaggerModule.createDocument(app, documentConfig);

  verifyThrottleRules(document, logger);

  if (!config.app.isProduction) {
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  // NOTE ON THE ABSENT GLOBAL PREFIX: the spec asks for '/v1', and every feature controller already
  // declares it in its own @Controller('v1/...') path. Calling setGlobalPrefix('v1') here would
  // produce /v1/v1/deposits and break every documented endpoint and every module's tests. The two
  // routes that are deliberately NOT versioned — /health/* and the Telegram webhook, whose URL is
  // built by AppConfigService — confirm the intent: versioning is per-controller in this codebase.

  await app.listen(config.app.port, '0.0.0.0');

  logger.log(`API listening on port ${config.app.port} (${config.app.nodeEnv})`);
  logger.log(`Telegram webhook path: ${config.telegram.webhookPath}`);
  if (!config.app.isProduction) logger.log(`OpenAPI UI: ${config.app.baseUrl}/docs`);
}

export async function bootstrapWorker(): Promise<void> {
  // No HTTP server: this role consumes queues, runs schedules and owns the Ichancy session.
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });

  app.useLogger(app.get(PinoLogger));
  app.flushLogs();
  // Lets BullMQ finish in-flight jobs and the pg pool drain on SIGTERM instead of being killed.
  app.enableShutdownHooks();

  new NestLogger('Bootstrap').log('Worker started (no HTTP listener)');
}

export async function bootstrap(): Promise<void> {
  // Read straight from process.env: the validated config lives inside the Nest container, and
  // which container to build is exactly what we are deciding here.
  const role = process.env.APP_ROLE;
  if (role === 'worker') {
    await bootstrapWorker();
    return;
  }
  await bootstrapApi();
}

// Guarded so `main.worker.ts` can import bootstrapWorker without this side effect firing too.
if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    // The logger may not exist yet (a bad .env throws inside NestFactory.create), so this is the
    // one place a raw console write is the right tool.
    console.error('Fatal error during bootstrap:', error);
    process.exit(1);
  });
}
