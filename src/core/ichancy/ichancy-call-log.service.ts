/**
 * WHY: Ichancy gives us no idempotency key, no operation-by-reference lookup and no webhook. When a
 * deposit ends up in NEEDS_RECONCILIATION at 3am, this table is the entire forensic record: what we
 * sent, what came back, how long it took, and which attempt it was. So the write happens in the
 * transport itself (impossible to forget) and it can NEVER throw — losing the audit row is bad, but
 * turning a successful money call into an exception because the audit insert failed is worse.
 *
 * Everything is redacted on the way in: the signin request carries the agent password and the signin
 * RESPONSE carries the token pair, which is the single credential for the whole agent account.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { IchancyOperation, IchancyOutcome, Prisma } from '@prisma/client';
// ASSUMPTION: the prisma agent exposes `PrismaService` (extending PrismaClient) at this path.
import { PrismaService } from '@core/prisma/prisma.service';

export const ICHANCY_CALL_LOG = 'ICHANCY_CALL_LOG';

export interface IchancyCallRecord {
  readonly operation: IchancyOperation;
  /** 1-based within one logical operation; a refresh+replay produces attempt 2. */
  readonly attempt: number;
  /** null when the transport never produced a status code (timeout, DNS, reset). */
  readonly httpStatus: number | null;
  readonly outcome: IchancyOutcome;
  readonly requestBody: unknown;
  readonly responseBody: unknown;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly durationMs: number;
  readonly depositRequestId?: string | null;
  readonly playerId?: string | null;
  readonly correlationId?: string | null;
}

export interface IchancyCallLogPort {
  record(entry: IchancyCallRecord): Promise<void>;
}

const REDACTED = '[REDACTED]';
const SECRET_KEY_RE = /pass(word)?|token|secret|authorization|credential|apikey|api_key/i;
const MAX_DEPTH = 8;
const MAX_ARRAY = 100;
const MAX_STRING = 2_000;
const MAX_ERROR_MESSAGE = 500;

/**
 * Deep copy with secrets removed and hard size caps, so a hostile/huge body cannot blow up a JSONB
 * column or leak a credential into the audit trail.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (depth >= MAX_DEPTH) return '[TRUNCATED_DEPTH]';

  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[TRUNCATED]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();

  if (Array.isArray(value)) {
    const capped = value.slice(0, MAX_ARRAY).map((item) => redactSecrets(item, depth + 1));
    if (value.length > MAX_ARRAY)
      capped.push(`[TRUNCATED ${String(value.length - MAX_ARRAY)} more]`);
    return capped;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY_RE.test(key) ? REDACTED : redactSecrets(item, depth + 1);
    }
    return out;
  }

  // symbol / function: never legitimate in a request body, so record the type and move on.
  return `[UNSERIALIZABLE ${typeof value}]`;
}

function truncateMessage(message: string | null): string | null {
  if (message === null) return null;
  return message.length > MAX_ERROR_MESSAGE ? `${message.slice(0, MAX_ERROR_MESSAGE)}…` : message;
}

@Injectable()
export class IchancyCallLogService implements IchancyCallLogPort {
  private readonly logger = new Logger(IchancyCallLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: IchancyCallRecord): Promise<void> {
    const request = redactSecrets(entry.requestBody) as Prisma.InputJsonValue;
    const response =
      entry.responseBody === null || entry.responseBody === undefined
        ? undefined
        : (redactSecrets(entry.responseBody) as Prisma.InputJsonValue);

    try {
      await this.prisma.ichancyCall.create({
        data: {
          operation: entry.operation,
          attempt: entry.attempt,
          httpStatus: entry.httpStatus,
          outcome: entry.outcome,
          requestBody: request,
          responseBody: response,
          errorCode: entry.errorCode,
          errorMessage: truncateMessage(entry.errorMessage),
          durationMs: entry.durationMs,
          depositRequestId: entry.depositRequestId ?? null,
          playerId: entry.playerId ?? null,
          correlationId: entry.correlationId ?? null,
        },
      });
    } catch (error) {
      // Deliberately swallowed: the caller is mid-money-operation and the outcome it computed is
      // still valid. We shout instead, because a missing row means a blind spot in reconciliation.
      this.logger.error(
        `Failed to persist ichancy_call (${entry.operation}/${String(entry.attempt)} -> ${entry.outcome}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/** For unit tests and any context without a database. Keeps the last N entries in memory. */
export class InMemoryIchancyCallLog implements IchancyCallLogPort {
  readonly entries: IchancyCallRecord[] = [];

  record(entry: IchancyCallRecord): Promise<void> {
    this.entries.push({
      ...entry,
      requestBody: redactSecrets(entry.requestBody),
      responseBody: redactSecrets(entry.responseBody),
    });
    return Promise.resolve();
  }
}
