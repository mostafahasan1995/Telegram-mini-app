/**
 * WHY a CLI command rather than a boot step: setMyCommands, setMyDescription and setChatMenuButton
 * are global, account-wide mutations — the same reasoning as webhook:set. If every replica pushed
 * them on startup, a rolling deploy would rewrite the bot's public UI once per replica, and a stale
 * replica could push menus from an older release.
 *
 * IDEMPOTENT by construction: every Bot API call below is an absolute overwrite of the previous
 * value, never an append. Run it after any deploy that changes the command surface, and again
 * whenever an admin is added — the per-admin scoped menus only exist for rows present at run time.
 *
 *   npm run bot:setup
 */
import { Logger } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import type { BotCommand } from 'grammy/types';
import { AppConfigService } from '../../config/config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BotService } from '../services/bot.service';

/**
 * The player-facing menu, in the order a confused person needs them. MIRRORS the @OnCommand surface
 * of src/modules/player/telegram/player.handlers.ts: a listed command that never answers reads as a
 * broken bot, so nothing may appear here without a handler there.
 */
const PLAYER_COMMANDS: readonly BotCommand[] = Object.freeze([
  { command: 'start', description: '🚀 بدء واستخدام البوت' },
  { command: 'help', description: 'ℹ️ القائمة والمساعدة' },
  { command: 'deposit', description: '💰 شحن الرصيد' },
  { command: 'methods', description: '💳 طرق الدفع' },
  { command: 'deposits', description: '🧾 إيداعاتي' },
  { command: 'balance', description: '💵 رصيدي' },
  { command: 'profile', description: '👤 حسابي' },
  { command: 'about', description: '✅ حالة الخدمة' },
  { command: 'terms', description: '📄 الشروط' },
  { command: 'paysupport', description: '🆘 مشكلة بالدفع' },
]);

/**
 * What admins see ON TOP of the player list. MIRRORS the @OnCommand surface of
 * src/modules/admin/telegram/admin.handlers.ts. Pushed ONLY to chat-scoped menus (the admin group
 * and each admin's private chat), never to the DEFAULT scope: AdminTelegramHandlers answers
 * non-admins with silence precisely so the staff surface cannot be enumerated, and a global menu
 * listing /queue would undo that.
 */
const ADMIN_EXTRA_COMMANDS: readonly BotCommand[] = Object.freeze([
  { command: 'queue', description: '📥 الطابور' },
  { command: 'report', description: '📊 تقرير النشاط' },
  { command: 'float', description: '🏦 رصيد الكاشيرة' },
  { command: 'breaks', description: '⚠️ مشاكل التسوية' },
]);

/** Shown on the empty chat screen BEFORE the player taps Start. Bot API cap: 512 characters. */
const BOT_DESCRIPTION = [
  'شحن رصيدك في Ichancy بسهولة وأمان 💰',
  'ابدأ بالضغط على زر Start 👇',
  'جميع الإيداعات تُراجع من فريقنا قبل إضافة الرصيد ✅',
].join('\n');

/** The bio line on the bot's profile page. Bot API cap: 120 characters. */
const BOT_SHORT_DESCRIPTION = 'بوت شحن رصيد Ichancy — سريع وآمن ⚡';

interface CallOutcome {
  readonly call: string;
  readonly ok: boolean;
  /** A failed fatal call makes the whole run exit non-zero; a non-fatal one is only a warning. */
  readonly fatal: boolean;
  readonly detail: string;
}

@Command({
  name: 'bot:setup',
  description: 'Push the bot’s command menus, descriptions and menu button to Telegram.',
})
export class SetupBotCommand extends CommandRunner {
  private readonly logger = new Logger(SetupBotCommand.name);
  private readonly outcomes: CallOutcome[] = [];

  constructor(
    private readonly config: AppConfigService,
    private readonly bot: BotService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async run(): Promise<void> {
    const adminCommands: BotCommand[] = [...PLAYER_COMMANDS, ...ADMIN_EXTRA_COMMANDS];

    // 1 — the DEFAULT scope: what every player sees. The one call that must succeed.
    await this.attempt('setMyCommands scope=default (player menu)', true, () =>
      this.bot.api.setMyCommands([...PLAYER_COMMANDS], { scope: { type: 'default' } }),
    );

    // 2 — the shared admin chat gets the admin menu.
    const adminChatId = this.toChatId(this.config.telegram.adminChatId);
    await this.attempt(`setMyCommands scope=chat:${adminChatId} (admin chat)`, false, () =>
      this.bot.api.setMyCommands(adminCommands, {
        scope: { type: 'chat', chat_id: adminChatId },
      }),
    );

    // 3 — the same admin menu in each active admin's PRIVATE chat, so /queue autocompletes when
    // they talk to the bot directly and not only in the group.
    const admins = await this.prisma.adminUser.findMany({
      where: { isActive: true },
      select: { telegramUserId: true, displayName: true },
      orderBy: { displayName: 'asc' },
    });

    for (const admin of admins) {
      const chatId = this.toChatId(admin.telegramUserId);
      await this.attempt(
        `setMyCommands scope=chat:${chatId} (admin “${admin.displayName}”)`,
        false,
        () =>
          this.bot.api.setMyCommands(adminCommands, {
            scope: { type: 'chat', chat_id: chatId },
          }),
        // Telegram answers 400 "chat not found" for a user who never pressed Start on this bot.
        // That is the admin's to fix, not a reason to abort the other menus.
        `has ${admin.displayName} started the bot? A chat-scoped menu needs an existing chat`,
      );
    }

    // 4 — the texts on the bot's profile / empty-chat screen.
    await this.attempt('setMyDescription', true, () =>
      this.bot.api.setMyDescription(BOT_DESCRIPTION),
    );
    await this.attempt('setMyShortDescription', true, () =>
      this.bot.api.setMyShortDescription(BOT_SHORT_DESCRIPTION),
    );

    // 5 — the ≡ menu button next to the input field opens the command list.
    await this.attempt('setChatMenuButton default=commands', true, () =>
      this.bot.api.setChatMenuButton({ menu_button: { type: 'commands' } }),
    );

    this.printSummary(admins.length);

    const fatalFailures = this.outcomes.filter((outcome) => !outcome.ok && outcome.fatal);
    const first = fatalFailures[0];
    if (first !== undefined) {
      // Thrown AFTER the summary so the operator still sees every result; main.cli.ts turns this
      // into a non-zero exit.
      throw new Error(`bot:setup failed: ${first.call} — ${first.detail}`);
    }
  }

  /** Runs one Bot API call, records its outcome, and never lets it abort the run. */
  private async attempt(
    call: string,
    fatal: boolean,
    invoke: () => Promise<unknown>,
    hintOnFailure?: string,
  ): Promise<void> {
    try {
      await invoke();
      this.outcomes.push({ call, ok: true, fatal, detail: 'ok' });
      this.logger.log(`ok    ${call}`);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      const detail = hintOnFailure === undefined ? reason : `${reason} (${hintOnFailure})`;
      this.outcomes.push({ call, ok: false, fatal, detail });
      if (fatal) {
        this.logger.error(`FAIL  ${call}: ${detail}`);
      } else {
        this.logger.warn(`warn  ${call}: ${detail}`);
      }
    }
  }

  private printSummary(adminCount: number): void {
    const ok = this.outcomes.filter((outcome) => outcome.ok).length;
    const failed = this.outcomes.length - ok;

    this.logger.log('── bot:setup summary ─────────────────────────────────────────');
    for (const outcome of this.outcomes) {
      const verdict = outcome.ok ? 'OK  ' : outcome.fatal ? 'FAIL' : 'WARN';
      this.logger.log(`${verdict}  ${outcome.call}${outcome.ok ? '' : ` — ${outcome.detail}`}`);
    }
    this.logger.log(
      `${this.outcomes.length} calls (${adminCount} admin private chats): ${ok} ok, ${failed} failed`,
    );
  }

  /**
   * MIRRORS BotService.toChatId: chat ids are stored as bigint, the Bot API accepts a numeric
   * string for chat_id, and stringifying a bigint is lossless where Number() would not be.
   */
  private toChatId(chatId: bigint): string {
    return chatId.toString();
  }
}
