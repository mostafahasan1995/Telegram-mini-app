/**
 * WHY this file is the only place that decides an HTTP error status: three very different error
 * dialects reach the edge — our AppExceptions, Nest's HttpExceptions (including ValidationPipe's
 * array-of-strings payload), and Prisma's `P####` codes — and if each controller translated them,
 * the same unique-violation would surface as a 409 in one route and a 500 in another.
 *
 * Two rules that are easy to get wrong and are load-bearing here:
 *
 *  1. NOTHING from an unexpected error reaches the client. Prisma's messages embed table names,
 *     column names and sometimes the offending VALUE (which for us can be a refresh-token hash or
 *     an Ichancy login). Unknown failures become an opaque INTERNAL_ERROR plus a correlation id;
 *     the real error goes to the log, with its stack, under that same id.
 *
 *  2. Prisma errors are detected STRUCTURALLY, not with `instanceof`. `instanceof` compares
 *     constructor identity, so a second copy of @prisma/client anywhere in node_modules (or a
 *     re-generated client in the worker image) silently turns every 409 into a 500. Matching on
 *     `code: /^P\d{4}$/` + `clientVersion` cannot break that way.
 *
 * The same structural approach is what lets this file translate @core/prisma's RepositoryError
 * family (UNIQUE_CONSTRAINT / RECORD_NOT_FOUND / FOREIGN_KEY_CONSTRAINT) without importing it —
 * `common` may not import `core`, and a repository error that reached a controller unmapped would
 * otherwise be reported as a 500 when it is really a 409.
 */
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { type Request, type Response } from 'express';
import { type ApiEnvelope, type ApiErrorBody } from '../dtos/api-response.dto';
import { AppException } from '../exceptions/app.exception';
import { CommonErrorCodes } from '../exceptions/error-codes';
import { resolveCorrelationId } from '../interceptors/correlation-id.interceptor';

interface PrismaKnownRequestErrorLike {
  code: string;
  clientVersion: string;
  message: string;
  meta?: Record<string, unknown>;
}

interface NormalizedError {
  status: number;
  body: ApiErrorBody;
  /** Unexpected failures are logged at error level WITH the stack; expected ones are not. */
  unexpected: boolean;
}

function asPrismaKnownRequestError(error: unknown): PrismaKnownRequestErrorLike | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as Record<string, unknown>;
  if (
    typeof candidate.code === 'string' &&
    /^P\d{4}$/.test(candidate.code) &&
    typeof candidate.clientVersion === 'string'
  ) {
    return candidate as unknown as PrismaKnownRequestErrorLike;
  }
  return null;
}

/**
 * Stable codes owned by @core/prisma/prisma-errors. Duplicated here as literals rather than
 * imported, because the layering rules forbid common -> core. They are API-stable by contract.
 */
const REPOSITORY_ERROR_CODES = new Set([
  'UNIQUE_CONSTRAINT',
  'RECORD_NOT_FOUND',
  'FOREIGN_KEY_CONSTRAINT',
  'REPOSITORY_FAILURE',
]);

interface RepositoryErrorLike {
  code: string;
  message: string;
  fields?: readonly string[];
  field?: string;
}

function asRepositoryError(error: unknown): RepositoryErrorLike | null {
  if (!(error instanceof Error)) return null;
  const candidate = error as unknown as Record<string, unknown>;
  if (typeof candidate.code === 'string' && REPOSITORY_ERROR_CODES.has(candidate.code)) {
    return candidate as unknown as RepositoryErrorLike;
  }
  return null;
}

function prismaErrorName(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' && name.startsWith('Prisma') ? name : null;
}

/** `meta.target` is the column list of the violated constraint; safe to echo, values are not. */
function conflictFields(meta: Record<string, unknown> | undefined): string[] | undefined {
  const target = meta?.target;
  if (Array.isArray(target)) return target.filter((t): t is string => typeof t === 'string');
  if (typeof target === 'string') return [target];
  return undefined;
}

function statusToCode(status: number): string {
  switch (status) {
    case 400:
      return CommonErrorCodes.BAD_REQUEST;
    case 401:
      return CommonErrorCodes.UNAUTHENTICATED;
    case 403:
      return CommonErrorCodes.FORBIDDEN;
    case 404:
      return CommonErrorCodes.RESOURCE_NOT_FOUND;
    case 405:
      return CommonErrorCodes.METHOD_NOT_ALLOWED;
    case 409:
      return CommonErrorCodes.DUPLICATE_RESOURCE;
    case 413:
      return CommonErrorCodes.PAYLOAD_TOO_LARGE;
    case 415:
      return CommonErrorCodes.UNSUPPORTED_MEDIA_TYPE;
    case 422:
      return CommonErrorCodes.BUSINESS_RULE_VIOLATION;
    case 429:
      return CommonErrorCodes.RATE_LIMITED;
    case 503:
      return CommonErrorCodes.SERVICE_UNAVAILABLE;
    case 504:
      return CommonErrorCodes.UPSTREAM_TIMEOUT;
    default:
      return CommonErrorCodes.INTERNAL_ERROR;
  }
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    // Queue processors and the CLI have no response to write to; rethrowing lets BullMQ count the
    // attempt and apply its backoff instead of the job silently "succeeding".
    if (host.getType() !== 'http') throw exception;

    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const correlationId = resolveCorrelationId(request, response);

    const normalized = this.normalize(exception);

    this.log(normalized, exception, request, correlationId);

    // A streamed/partially-written response cannot be rewritten as JSON.
    if (response.headersSent) return;

    const envelope: ApiEnvelope<never> = {
      success: false,
      data: null,
      error: normalized.body,
      meta: { correlationId, timestamp: new Date().toISOString() },
    };

    response.status(normalized.status).json(envelope);
  }

  private normalize(exception: unknown): NormalizedError {
    if (exception instanceof AppException) {
      return {
        status: exception.httpStatus,
        body: exception.toJSON(),
        // A 5xx we raised ourselves is still worth a stack trace.
        unexpected: exception.httpStatus >= 500,
      };
    }

    const prismaKnown = asPrismaKnownRequestError(exception);
    if (prismaKnown) return this.fromPrisma(prismaKnown);

    const repositoryError = asRepositoryError(exception);
    if (repositoryError) return this.fromRepositoryError(repositoryError);

    const prismaName = prismaErrorName(exception);
    if (prismaName === 'PrismaClientValidationError') {
      // Our own query is malformed — a bug, not the caller's fault. Never echo the message: it
      // contains the full query with argument values.
      return {
        status: 500,
        body: {
          code: CommonErrorCodes.INTERNAL_ERROR,
          message: 'An unexpected error occurred.',
        },
        unexpected: true,
      };
    }
    if (
      prismaName === 'PrismaClientInitializationError' ||
      prismaName === 'PrismaClientRustPanicError'
    ) {
      return {
        status: 503,
        body: {
          code: CommonErrorCodes.SERVICE_UNAVAILABLE,
          message: 'The database is temporarily unavailable.',
        },
        unexpected: true,
      };
    }

    if (exception instanceof HttpException) return this.fromHttpException(exception);

    return {
      status: 500,
      body: { code: CommonErrorCodes.INTERNAL_ERROR, message: 'An unexpected error occurred.' },
      unexpected: true,
    };
  }

  private fromPrisma(error: PrismaKnownRequestErrorLike): NormalizedError {
    const fields = conflictFields(error.meta);

    switch (error.code) {
      // Unique constraint failed. Everywhere in this schema that means "already exists":
      // deposit_requests.short_id, players.telegram_user_id, player_sessions.refresh_token_hash,
      // outbox_messages.dedupe_key, telegram_updates.update_id.
      case 'P2002':
        return {
          status: 409,
          body: {
            code: CommonErrorCodes.DUPLICATE_RESOURCE,
            message: 'A record with these values already exists.',
            ...(fields ? { details: { fields } } : {}),
          },
          unexpected: false,
        };

      // An update/delete matched no rows. Usually an optimistic-concurrency guard losing its race
      // (e.g. `where: { id, status: 'SUBMITTED' }`), which is a legitimate 404 for the caller.
      case 'P2025':
      case 'P2001':
        return {
          status: 404,
          body: {
            code: CommonErrorCodes.RESOURCE_NOT_FOUND,
            message: 'The requested resource was not found or is no longer in the expected state.',
          },
          unexpected: false,
        };

      // Foreign key violation: pointing at something that does not exist, or deleting something
      // still referenced (every relation in this schema is onDelete: Restrict on purpose).
      case 'P2003':
        return {
          status: 409,
          body: {
            code: CommonErrorCodes.REFERENCE_CONSTRAINT,
            message: 'The operation references a record that does not exist or is still in use.',
            ...(fields ? { details: { fields } } : {}),
          },
          unexpected: false,
        };

      // Serialization failure / deadlock. The whole request is safe to retry — but only because
      // every money write is wrapped in a transaction, so nothing partial survived.
      case 'P2034':
        return {
          status: 409,
          body: {
            code: CommonErrorCodes.WRITE_CONFLICT,
            message: 'The request conflicted with a concurrent write. Please retry.',
          },
          unexpected: false,
        };

      // Value too long for the column.
      case 'P2000':
        return {
          status: 400,
          body: {
            code: CommonErrorCodes.VALIDATION_FAILED,
            message: 'A provided value is too long.',
            ...(fields ? { details: { fields } } : {}),
          },
          unexpected: false,
        };

      // Connection-level failures (unreachable, timed out, auth, closed pool).
      case 'P1001':
      case 'P1002':
      case 'P1008':
      case 'P1017':
        return {
          status: 503,
          body: {
            code: CommonErrorCodes.SERVICE_UNAVAILABLE,
            message: 'The database is temporarily unavailable.',
          },
          unexpected: true,
        };

      default:
        return {
          status: 500,
          body: { code: CommonErrorCodes.INTERNAL_ERROR, message: 'An unexpected error occurred.' },
          unexpected: true,
        };
    }
  }

  /** Already-translated Prisma failures coming out of a repository (see @core/prisma). */
  private fromRepositoryError(error: RepositoryErrorLike): NormalizedError {
    switch (error.code) {
      case 'UNIQUE_CONSTRAINT':
        return {
          status: 409,
          body: {
            code: CommonErrorCodes.DUPLICATE_RESOURCE,
            message: 'A record with these values already exists.',
            ...(error.fields && error.fields.length > 0
              ? { details: { fields: [...error.fields] } }
              : {}),
          },
          unexpected: false,
        };
      case 'RECORD_NOT_FOUND':
        return {
          status: 404,
          body: {
            code: CommonErrorCodes.RESOURCE_NOT_FOUND,
            message: 'The requested resource was not found or is no longer in the expected state.',
          },
          unexpected: false,
        };
      case 'FOREIGN_KEY_CONSTRAINT':
        return {
          status: 409,
          body: {
            code: CommonErrorCodes.REFERENCE_CONSTRAINT,
            message: 'The operation references a record that does not exist or is still in use.',
            ...(error.field !== undefined ? { details: { fields: [error.field] } } : {}),
          },
          unexpected: false,
        };
      default:
        return {
          status: 500,
          body: { code: CommonErrorCodes.INTERNAL_ERROR, message: 'An unexpected error occurred.' },
          unexpected: true,
        };
    }
  }

  private fromHttpException(exception: HttpException): NormalizedError {
    const status = exception.getStatus();
    const payload = exception.getResponse();

    if (typeof payload === 'string') {
      return {
        status,
        body: { code: statusToCode(status), message: payload },
        unexpected: status >= 500,
      };
    }

    const record = payload as Record<string, unknown>;

    // ValidationPipe answers with `{ statusCode, error, message: string[] }`. Hoisting that array
    // into `details.fields` is what lets the mini-app highlight the offending inputs.
    if (Array.isArray(record.message)) {
      return {
        status,
        body: {
          code: CommonErrorCodes.VALIDATION_FAILED,
          message: 'The request payload is invalid.',
          details: { fields: record.message.filter((m): m is string => typeof m === 'string') },
        },
        unexpected: false,
      };
    }

    const { statusCode: _statusCode, error: _error, message, code, ...rest } = record;

    return {
      status,
      body: {
        code: typeof code === 'string' ? code : statusToCode(status),
        message: typeof message === 'string' ? message : exception.message,
        ...(Object.keys(rest).length > 0 ? { details: rest } : {}),
      },
      unexpected: status >= 500,
    };
  }

  private log(
    normalized: NormalizedError,
    exception: unknown,
    request: Request,
    correlationId: string,
  ): void {
    const where = `${request.method} ${request.url}`;
    const context = `${normalized.body.code} ${where} correlationId=${correlationId}`;

    if (normalized.unexpected) {
      const stack = exception instanceof Error ? exception.stack : undefined;
      const detail = exception instanceof Error ? exception.message : String(exception);
      this.logger.error(`${context} :: ${detail}`, stack);
      return;
    }

    // 401/403/404 are ordinary traffic (expired tokens, deep links to deleted rows) and would
    // otherwise bury real problems in the log.
    if (normalized.status === 401 || normalized.status === 403 || normalized.status === 404) {
      this.logger.debug(context);
      return;
    }

    this.logger.warn(`${context} :: ${normalized.body.message}`);
  }
}
