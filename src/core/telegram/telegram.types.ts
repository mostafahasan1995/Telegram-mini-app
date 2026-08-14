/**
 * WHY ids are strings in the job payload: BullMQ stores job data as JSON in Redis. Telegram chat
 * and user ids are 64-bit, and `update_id` grows without bound — round-tripping any of them as a
 * JSON number risks a silent rounding that would attribute an action to the wrong chat.
 */
import { type Update } from 'grammy/types';

export interface TelegramUpdateJobData {
  /** `telegram_updates.id` — the durable row this job is processing. */
  updateRowId: string;
  /** Telegram's `update_id`, as a decimal string. */
  updateId: string;
  /** The raw update, replayed into `bot.handleUpdate()` by the worker. */
  update: Update;
}

/** Outcome of persisting an inbound update. `id` is null when the update was already recorded. */
export interface RecordedUpdate {
  isNew: boolean;
  id: string | null;
}

/** Coarse classification stored on the row, so the admin can filter without parsing JSON. */
export type TelegramUpdateKind =
  'message' | 'edited_message' | 'callback_query' | 'my_chat_member' | 'other';
