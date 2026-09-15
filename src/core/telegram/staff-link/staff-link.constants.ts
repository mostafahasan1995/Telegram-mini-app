/**
 * Fixed values of the staff Telegram link (owner decision 4, 2026-09-15). See StaffTelegramLinkService
 * for the whole flow.
 */

/** Stable `<entity>.<action>` verbs, written in the operator's own audit log. Never the code. */
export const StaffTelegramLinkAuditActions = {
  /** The console issued a code for a staff account. Records the code row id, never the code. */
  CODE_ISSUED: 'admin.telegramLink.codeIssued',
  /** A staff account was linked to the Telegram account that sent its code. */
  LINKED: 'admin.telegramLink.linked',
  /** A `/link` with a code of this operator that did not link, and why. */
  REFUSED: 'admin.telegramLink.refused',
  /** A staff account's Telegram link was removed. */
  UNLINKED: 'admin.telegramLink.unlinked',
} as const;

/** The audit subject: the staff account whose Telegram id is (or would be) changed. */
export const STAFF_TELEGRAM_LINK_AUDIT_SUBJECT = 'AdminUser';

/**
 * How long a code works. Long enough to switch from the console to Telegram and type it; short enough
 * that a code on a screenshot or in a browser tab left open is dead by the time anyone finds it.
 */
export const STAFF_LINK_CODE_TTL_MINUTES = 10;

/**
 * `/link` attempts one Telegram account may make at one operator's bot per window, counted before the
 * code is looked at. A real person needs one. The limit is per sender and not per operator on purpose:
 * an operator-wide ceiling would let anybody lock every staff member out of linking for the window.
 */
export const STAFF_LINK_ATTEMPTS_PER_WINDOW = 5;
export const STAFF_LINK_ATTEMPT_WINDOW_SECONDS = 15 * 60;

export const staffLinkAttemptsKey = (tenantId: string, telegramUserId: bigint): string =>
  `staff-link:attempts:${tenantId}:${telegramUserId.toString()}`;

/**
 * Marks one update as already counted, so a BullMQ retry of the same update (a transient database
 * failure during redemption) does not spend another of the sender's attempts. Update ids are numbered
 * per bot, hence the operator in the key.
 */
export const staffLinkAttemptCountedKey = (tenantId: string, updateId: number): string =>
  `staff-link:attempt-counted:${tenantId}:${String(updateId)}`;

/** `telegram_updates.handler` for a `/link` update the link flow handled and grammY never saw. */
export const STAFF_TELEGRAM_LINK_HANDLER = 'StaffTelegramLink';
