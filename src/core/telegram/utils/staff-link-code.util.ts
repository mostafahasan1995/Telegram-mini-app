/**
 * Pure rules for the staff Telegram link code (owner decision 4, 2026-09-15): what a code looks like,
 * how the `/link <code>` command reads, and how the webhook keeps the code out of everything it stores.
 * No Nest, no database, no network, so each rule is tested on its own.
 *
 * ══ WHY THE ALPHABET OMITS I, O, 0 AND 1 ══════════════════════════════════════════════════════════
 * A person reads the code off the console and types it into Telegram, usually on a phone. Ambiguous
 * glyphs turn a working code into a support conversation (the same rule as the player login code).
 *
 * ══ WHY EIGHT CHARACTERS ARE ENOUGH ═══════════════════════════════════════════════════════════════
 * 32^8 is about 1.1e12. A code lives STAFF_LINK_CODE_TTL_MINUTES, works once, and each Telegram account
 * gets a handful of attempts per window at one operator's bot. Offline guessing is what a short code
 * cannot survive, which is why only a KEYED digest is ever stored (TenantSecretService).
 *
 * ══ THE CODE NEVER RESTS ANYWHERE ═════════════════════════════════════════════════════════════════
 * An update is written to `telegram_updates.payload` and queued in Redis before the worker reads it,
 * and a refused attempt (sent to the wrong operator's bot, or from a Telegram account already linked)
 * leaves the code live. So the webhook replaces the code with its keyed digest before storing or
 * queueing (redactStaffLinkCode), and the worker accepts ONLY that digest form. A person typing the
 * digest form themselves must not link anything, so the webhook neutralises a typed one. The webhook is
 * the only producer of update jobs.
 *
 * EDITS TOO: the webhook is subscribed to `edited_message`, and the realistic way a code reaches one is a
 * typo fixed in place (`/link ABCD-EFG`, which is not a code and is left alone, edited to the full code).
 * Telegram sends the edited text in `edited_message`, which is stored and queued exactly like `message`,
 * so both are redacted the same way. The worker never redeems an edit (StaffTelegramLinkService answers
 * it with "send it as a new message"), so the code an edit carried stays live; that is only safe because
 * it was redacted here.
 */
import { randomInt } from 'node:crypto';

import type { Message, Update } from 'grammy/types';

/** No I, O, 0 or 1: see the header. */
export const STAFF_LINK_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const STAFF_LINK_CODE_LENGTH = 8;

/** Exactly a normalized code: eight symbols of the alphabet. */
const NORMALIZED_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

/** A fresh code, normalized (no separator). CSPRNG, one independent draw per symbol. */
export function newStaffLinkCode(): string {
  return Array.from(
    { length: STAFF_LINK_CODE_LENGTH },
    () => STAFF_LINK_CODE_ALPHABET[randomInt(STAFF_LINK_CODE_ALPHABET.length)],
  ).join('');
}

/** Grouped for reading: `ABCD-EFGH`. The command accepts it with or without the hyphen. */
export function formatStaffLinkCode(normalized: string): string {
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

/**
 * The normalized code in what somebody typed, or null. Case, spaces and hyphens are forgiven, because
 * that is what keyboards and copy-paste produce; any other character means it is not a code.
 */
export function normalizeStaffLinkCode(raw: string): string | null {
  const normalized = raw.toUpperCase().replace(/[\s-]/g, '');
  return NORMALIZED_CODE.test(normalized) ? normalized : null;
}

/**
 * `/link` or `/link@bot`, ended by whitespace or the end of the text, then EVERYTHING after it as the
 * payload. No length cap and no single-line rule: normalizing drops all whitespace, so a code padded
 * with spaces or put on the next line is still a code, and a pattern that failed to match it would
 * leave that live code unredacted in the stored update. Linear on an unchecked body: one lookahead and
 * one greedy class, nothing that backtracks.
 */
const LINK_COMMAND = /^\/link(?:@([A-Za-z0-9_]{1,64}))?(?=\s|$)([\s\S]*)$/;

const DIGEST_PREFIX = 'digest:';
const DIGEST_PAYLOAD = /^digest:([0-9a-f]{64})$/;
/** What a typed digest payload becomes: not a code, not a digest, so never a link. */
const NEUTRALISED_PAYLOAD = '[not-a-link-code]';

interface RawLinkCommand {
  mention: string | null;
  payload: string;
}

/** `/link[@bot] [payload]` in a text message of any chat, or null. */
function rawLinkCommandOf(message: Message | undefined): RawLinkCommand | null {
  if (message === undefined || message === null || typeof message !== 'object') return null;
  // Read as Partial: the webhook runs this on an authenticated body BEFORE its shape is otherwise
  // checked, and a malformed one must be passed through, not crash into a Telegram retry loop.
  const partial = message as Partial<Message>;
  if (typeof partial.text !== 'string') return null;
  const match = LINK_COMMAND.exec(partial.text);
  if (match === null) return null;
  return { mention: match[1] ?? null, payload: (match[2] ?? '').trim() };
}

export interface StaffLinkCommand {
  /** The bot the command names, without `@`, or null when it names none. */
  mention: string | null;
  /** The keyed digest the webhook put in place of the code, or null when there was no usable code. */
  digest: string | null;
}

/**
 * The link command as the WORKER reads it: only the digest form carries a code. A raw code here never
 * came through the webhook and is treated as no code at all (see THE CODE NEVER RESTS ANYWHERE).
 */
export function staffLinkCommandOf(message: Message | undefined): StaffLinkCommand | null {
  const command = rawLinkCommandOf(message);
  if (command === null) return null;
  const digest = DIGEST_PAYLOAD.exec(command.payload)?.[1] ?? null;
  return { mention: command.mention, digest };
}

/**
 * The fields of a subscribed update that carry a person's text (TELEGRAM_ALLOWED_UPDATES). A new
 * text-bearing update type subscribed there must be added here, or its `/link` code would be stored.
 */
const TEXT_MESSAGE_FIELDS = ['message', 'edited_message'] as const;

/** True when the update is a `/link` command, sent or edited, in any chat. */
export function isStaffLinkUpdate(update: Update | undefined): boolean {
  if (update === undefined || update === null) return false;
  const partial = update as Partial<Update>;
  return TEXT_MESSAGE_FIELDS.some((field) => rawLinkCommandOf(partial[field]) !== null);
}

/**
 * The update as it may be stored and queued: a link command's code replaced by `digest:<hex>` (the
 * caller's keyed digest of the normalized code), and a typed digest payload neutralised, in a sent and in
 * an edited message alike (see EDITS TOO). Every other update, including a `/link` with no code in it, is
 * returned as the same object. Never mutates its argument; the command entity's offsets stay valid
 * because only the text after `/link[@bot] ` changes.
 */
export function redactStaffLinkCode(update: Update, digestOf: (normalizedCode: string) => string): Update {
  // Read as Partial: an authenticated body whose shape is not otherwise checked yet (see rawLinkCommandOf).
  const body = update as Partial<Update> | null | undefined;
  if (body === null || body === undefined || typeof body !== 'object') return update;
  let redacted: Update = update;
  for (const field of TEXT_MESSAGE_FIELDS) {
    const message = body[field];
    const text = redactedLinkText(message, digestOf);
    if (message !== undefined && text !== null) {
      redacted = { ...redacted, [field]: { ...message, text } };
    }
  }
  return redacted;
}

/** The text a `/link` message may be stored with, or null when it needs no change. */
function redactedLinkText(
  message: Message | undefined,
  digestOf: (normalizedCode: string) => string,
): string | null {
  const command = rawLinkCommandOf(message);
  if (command === null || command.payload === '') return null;

  let payload: string;
  const normalized = normalizeStaffLinkCode(command.payload);
  if (normalized !== null) {
    payload = `${DIGEST_PREFIX}${digestOf(normalized)}`;
  } else if (command.payload.toLowerCase().startsWith(DIGEST_PREFIX)) {
    payload = NEUTRALISED_PAYLOAD;
  } else {
    return null;
  }
  const head = command.mention === null ? '/link' : `/link@${command.mention}`;
  return `${head} ${payload}`;
}
