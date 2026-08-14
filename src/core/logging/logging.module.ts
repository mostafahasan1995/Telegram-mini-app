/**
 * WHY pino's `genReqId` is where the correlation id is really minted (and not the interceptor):
 * nestjs-pino installs pino-http as MIDDLEWARE, which runs before guards. Since our AuthGuard is
 * global and fails closed, 401s are produced before any interceptor — minting the id here is the
 * only way every response, including rejected ones, carries one. `resolveCorrelationId` stamps the
 * request object and the response header as a side effect, so the interceptor and the exception
 * filter both find the id already there and simply reuse it.
 *
 * WHY autoLogging ignores /health: Kubernetes probes both endpoints every few seconds. Left on,
 * they are the majority of log volume in a quiet hour and push real traffic out of any retention
 * window.
 */
import { Module } from '@nestjs/common';
import { LoggerModule, type Params } from 'nestjs-pino';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  getCorrelationId,
  resolveCorrelationId,
} from '@common/interceptors/correlation-id.interceptor';
import { AppConfigService } from '../config/config.service';
import { REDACTED, REDACT_PATHS } from './redaction';

const HEALTH_PATHS = new Set(['/health/live', '/health/ready']);

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): Params => ({
        pinoHttp: {
          level: config.app.isProduction ? 'info' : 'debug',

          // Every log line says which of the two entrypoints emitted it. With one image running as
          // both api and worker, this is the difference between a readable log and a puzzle.
          base: { role: config.app.role },

          genReqId: (req: IncomingMessage, res: ServerResponse): string =>
            resolveCorrelationId(req, res),

          customProps: (req: IncomingMessage) => ({
            correlationId: getCorrelationId(req) ?? undefined,
          }),

          redact: { paths: [...REDACT_PATHS], censor: REDACTED },

          autoLogging: {
            ignore: (req: IncomingMessage): boolean => {
              const url = req.url ?? '';
              const path = url.split('?')[0] ?? '';
              return HEALTH_PATHS.has(path);
            },
          },

          // Default serializers dump every header, which re-introduces the secrets `redact` just
          // removed via paths we did not anticipate. Allow-list instead.
          serializers: {
            req: (req: IncomingMessage & { id?: string; params?: unknown }) => ({
              id: req.id,
              method: req.method,
              url: (req.url ?? '').split('?')[0],
            }),
            res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
          },

          // pino-pretty is a devDependency: never reference it in a production image.
          transport: config.app.isProduction
            ? undefined
            : {
                target: 'pino-pretty',
                options: {
                  singleLine: true,
                  colorize: true,
                  translateTime: 'SYS:HH:MM:ss.l',
                  ignore: 'pid,hostname',
                },
              },
        },
        // The webhook is high-volume and its body is logged (redacted) by the controller itself.
        exclude: [],
      }),
    }),
  ],
  exports: [LoggerModule],
})
export class LoggingModule {}
