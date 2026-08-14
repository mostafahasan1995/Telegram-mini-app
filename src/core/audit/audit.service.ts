/**
 * WHY the Tx parameter, and why this is NOT queued:
 *
 * An audit row is not a notification. It is the evidence that a decision was taken, and it is only
 * evidence if it is impossible for the decision to exist without it. Writing it through the outbox
 * (or after the commit) would create a window in which a deposit is approved and nothing records
 * who approved it — precisely the window an auditor asks about. So the row goes into the SAME
 * transaction as the change it describes: they commit together or neither happened.
 *
 * That is also why this service does no IO of its own, has no retries and never throws a "nice"
 * error: if the audit insert fails, the business transaction MUST fail with it.
 *
 * Append-only is enforced below the application (prisma/sql/002 triggers, 003 grants revoke
 * UPDATE/DELETE from the app role), so there is deliberately no update() or delete() here — a
 * correction is a new row, never an edit.
 */
import { Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { Prisma } from '@prisma/client';

import { toJsonObject, toNullableJson } from '@core/queue/json.util';
import type { Tx } from '@core/prisma/tx.type';

import { AUDIT_AMOUNT_KEY, AUDIT_CONTEXT_KEY, type AuditWriteInput } from './audit.types';

/**
 * `actor_id` is a `@db.Uuid` column. Handing it a Telegram id or a login would abort the whole
 * money transaction on a type error — the audit row must never be the thing that kills a credit.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  /** Returns the audit row id, so a caller can reference it from a transition or a break. */
  async write(tx: Tx, input: AuditWriteInput): Promise<string> {
    const data = this.buildRow(input);
    await tx.auditLog.create({ data, select: { id: true } });
    return data.id;
  }

  /**
   * One INSERT for several rows — a bulk admin action should not cost N round trips inside a
   * transaction that is holding locks. Returns the ids in input order.
   */
  async writeMany(tx: Tx, inputs: readonly AuditWriteInput[]): Promise<string[]> {
    if (inputs.length === 0) return [];
    const rows = inputs.map((input) => this.buildRow(input));
    await tx.auditLog.createMany({ data: rows });
    return rows.map((row) => row.id);
  }

  private buildRow(input: AuditWriteInput): Prisma.AuditLogCreateManyInput & { id: string } {
    return {
      // uuidv7 rather than the column default: an append-only log is read in time order, and a
      // time-ordered primary key makes that an index scan instead of a sort.
      id: uuidv7(),
      actorType: input.actor.type,
      actorId: this.normalizeActorId(input.actor.id, input.action),
      action: input.action,
      entityType: input.subjectType,
      entityId: input.subjectId,
      before: toNullableJson(input.before),
      after: this.buildAfter(input),
      // Left undefined on purpose when the caller did not supply them: the Prisma actor-stamp
      // extension then fills them from the ambient request context. Passing null would win over it
      // and throw away information we already had.
      ...(input.ip !== undefined ? { ip: input.ip } : {}),
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    };
  }

  /**
   * `after` carries the snapshot plus, under the reserved `$meta` key, the amount and metadata the
   * table has no columns for. When there is neither, the column stays exactly what the caller
   * passed — including SQL NULL for "no snapshot taken".
   */
  private buildAfter(input: AuditWriteInput): Prisma.InputJsonValue | typeof Prisma.DbNull {
    const context: Record<string, unknown> = { ...(input.metadata ?? {}) };
    if (input.amountMinor !== undefined) {
      context[AUDIT_AMOUNT_KEY] = input.amountMinor.toString();
    }
    if (Object.keys(context).length === 0) return toNullableJson(input.after);
    return toJsonObject({ ...(input.after ?? {}), [AUDIT_CONTEXT_KEY]: context });
  }

  private normalizeActorId(actorId: string | null, action: string): string | null {
    if (actorId === null) return null;
    if (UUID_PATTERN.test(actorId)) return actorId;
    this.logger.warn(
      `Audit actor id "${actorId}" for "${action}" is not a uuid; recording the action without an actor id`,
    );
    return null;
  }
}
