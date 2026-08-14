/**
 * WHY deduplication is not optional here: Telegram re-delivers any update it did not get a 200 for,
 * and our callback buttons are money decisions. A replayed `callback_query` carrying
 * `dep:approve:<shortId>` must approve exactly once, no matter how many times Telegram sends it.
 *
 * TWO LAYERS, ONE TRUTH:
 *  - `telegram_updates.update_id` is UNIQUE. That is the guarantee, and it survives a Redis flush.
 *  - A Redis claim in front of it is an optimisation, so ordinary retries never reach Postgres.
 *
 * THE SUBTLE PART — the claim must be undone if anything downstream fails. If Redis says "new",
 * the row is inserted, and then the enqueue fails, returning 500 makes Telegram retry; but by then
 * BOTH layers say "already seen" and the update would be dropped forever. So `rollback()` deletes
 * the row and releases the claim, restoring the state that lets the retry succeed. An update we
 * accepted and never processed is invisible; an update processed twice is a double credit.
 */
import { Injectable, Logger } from '@nestjs/common';
import { type Update } from 'grammy/types';
import { PrismaService } from '../../prisma/prisma.service';
import { LockService } from '../../cache/lock.service';
import { TELEGRAM_UPDATE_DEDUPE_TTL_SECONDS, telegramUpdateDedupeKey } from '../telegram.constants';
import { type RecordedUpdate, type TelegramUpdateKind } from '../telegram.types';

interface Classification {
  kind: TelegramUpdateKind;
  chatId: bigint | null;
  fromUserId: bigint | null;
}

/**
 * Pull out the fields an admin needs to filter on without opening the JSON payload. Anything we
 * did not subscribe to lands in 'other' rather than being rejected — Telegram adds update types
 * over time and an unknown one must still be recorded, not dropped.
 */
function classify(update: Update): Classification {
  if (update.message) {
    return {
      kind: 'message',
      chatId: BigInt(update.message.chat.id),
      fromUserId: update.message.from ? BigInt(update.message.from.id) : null,
    };
  }
  if (update.edited_message) {
    return {
      kind: 'edited_message',
      chatId: BigInt(update.edited_message.chat.id),
      fromUserId: update.edited_message.from ? BigInt(update.edited_message.from.id) : null,
    };
  }
  if (update.callback_query) {
    const message = update.callback_query.message;
    return {
      kind: 'callback_query',
      chatId: message ? BigInt(message.chat.id) : null,
      fromUserId: BigInt(update.callback_query.from.id),
    };
  }
  if (update.my_chat_member) {
    return {
      kind: 'my_chat_member',
      chatId: BigInt(update.my_chat_member.chat.id),
      fromUserId: BigInt(update.my_chat_member.from.id),
    };
  }
  return { kind: 'other', chatId: null, fromUserId: null };
}

@Injectable()
export class UpdateDedupeService {
  private readonly logger = new Logger(UpdateDedupeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: LockService,
  ) {}

  /**
   * Persists an update exactly once. `isNew: false` means it was already recorded and the caller
   * must NOT enqueue it again.
   */
  async record(update: Update): Promise<RecordedUpdate> {
    const dedupeKey = telegramUpdateDedupeKey(update.update_id);

    // Fast path: an ordinary Telegram retry never touches Postgres.
    const claimed = await this.locks
      .claimOnce(dedupeKey, TELEGRAM_UPDATE_DEDUPE_TTL_SECONDS)
      .catch(() => true); // Redis down -> fall through to the database, which is the real guard.

    if (!claimed) return { isNew: false, id: null };

    const { kind, chatId, fromUserId } = classify(update);

    try {
      // Raw SQL because Prisma's `createMany({ skipDuplicates: true })` does the ON CONFLICT part
      // but cannot RETURN the generated id, and we need it to enqueue and to roll back.
      // Ids are bound as text and cast, so a 64-bit value never passes through a JS number.
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO telegram_updates (update_id, kind, chat_id, from_user_id, payload)
        VALUES (
          ${String(update.update_id)}::bigint,
          ${kind},
          ${chatId === null ? null : chatId.toString()}::bigint,
          ${fromUserId === null ? null : fromUserId.toString()}::bigint,
          ${JSON.stringify(update)}::jsonb
        )
        ON CONFLICT (update_id) DO NOTHING
        RETURNING id
      `;

      const row = rows[0];
      if (row === undefined) {
        // Postgres overrules Redis: we have seen this update before (Redis was flushed or the TTL
        // lapsed while Telegram was still retrying).
        return { isNew: false, id: null };
      }

      return { isNew: true, id: row.id };
    } catch (error: unknown) {
      // The claim must not outlive a failed insert, or the retry would be silently swallowed.
      await this.locks.releaseClaim(dedupeKey).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Undo `record()` after a downstream failure, so Telegram's retry is accepted rather than
   * deduplicated into oblivion. Deliberately best-effort: it runs on an error path, and throwing
   * here would replace the real error with a less useful one.
   */
  async rollback(updateRowId: string, updateId: number | bigint): Promise<void> {
    try {
      await this.prisma.telegramUpdate.delete({ where: { id: updateRowId } });
    } catch (error: unknown) {
      this.logger.error(
        `Failed to roll back telegram_updates row ${updateRowId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    await this.locks.releaseClaim(telegramUpdateDedupeKey(updateId)).catch(() => undefined);
  }

  /** Marks an update as handled. Called by the worker after `bot.handleUpdate()` returns. */
  async markProcessed(updateRowId: string, handler?: string): Promise<void> {
    await this.prisma.telegramUpdate.update({
      where: { id: updateRowId },
      data: { processedAt: new Date(), handler: handler ?? null, processingError: null },
    });
  }

  /**
   * Records a processing failure WITHOUT setting processedAt, so the row stays visible to whatever
   * sweeps for stuck updates.
   */
  async markFailed(updateRowId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.prisma.telegramUpdate.update({
      where: { id: updateRowId },
      // Truncated: a Postgres error can carry a whole query, and this column is read in a UI.
      data: { processingError: message.slice(0, 2_000) },
    });
  }
}
