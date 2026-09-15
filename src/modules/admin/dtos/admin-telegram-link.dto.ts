/**
 * What POST /v1/admin/admins/:id/telegram-link-code answers (owner decision 4, 2026-09-15).
 *
 * The code is in this response and nowhere else: not stored (only a keyed digest is), not logged, not
 * in the audit row. The console shows it once, with the command to send and the bot to send it to.
 */
export interface StaffTelegramLinkCodeView {
  adminUserId: string;
  /** Grouped for reading, `ABCD-EFGH`. `/link` accepts it with or without the hyphen, in any case. */
  code: string;
  /** Exactly what to send the bot in a private chat: `/link ABCD-EFGH`. */
  command: string;
  expiresAt: string;
  /** The code's whole lifetime, so a console can show a countdown without trusting its own clock. */
  ttlSeconds: number;
  /** The operator's bot, without `@`. Null until Telegram has confirmed the bot once. */
  botUsername: string | null;
  /** `https://t.me/<botUsername>`, which opens the private chat. Null when the username is. */
  botUrl: string | null;
}
