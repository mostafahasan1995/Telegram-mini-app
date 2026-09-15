/**
 * Pushes an OPERATOR's command menus, descriptions and menu button through that operator's own bot.
 *
 *   npm run bot:setup -- --tenant <slug>
 *   npm run bot:setup -- --all-active
 *
 * WHY a CLI command rather than a boot step: setMyCommands, setMyDescription and setChatMenuButton
 * are account-wide mutations — the same reasoning as webhook:set. If every replica pushed them on
 * startup, a rolling deploy would rewrite a bot's public UI once per replica, and a stale replica
 * could push menus from an older release.
 *
 * PER OPERATOR, ALL THE WAY DOWN: the bot is the operator's (TenantBotRegistry opens its sealed
 * token), the admin group is the operator's (`tenants.admin_chat_id`), and the staff who get the
 * admin menu in their private chats are that operator's active admins only. The single-bot version
 * read every operator's staff with no tenant filter, which through one bot would have enumerated
 * staff across operators.
 *
 * IDEMPOTENT by construction: every Bot API call below is an absolute overwrite of the previous
 * value, never an append. Run it after any deploy that changes the command surface, and again
 * whenever an admin is added — the per-admin scoped menus only exist for rows present at run time.
 */
import { Logger } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import type { BotCommand } from 'grammy/types';

import { PrismaService } from '../../prisma/prisma.service';
import { runWithTenant } from '../../tenant/tenant.storage';
import { BotService } from '../services/bot.service';
import {
  type TenantTarget,
  type TenantTargetOptions,
  resolveTenantTargets,
} from './tenant-targets';

/**
 * The player-facing menu, in the order a confused person needs them. MIRRORS the @OnCommand surface
 * of src/modules/player/telegram/player.handlers.ts: a listed command that never answers reads as a
 * broken bot, so nothing may appear here without a handler there.
 */
export const PLAYER_COMMANDS: readonly BotCommand[] = Object.freeze([
  { command: 'start', description: '🚀 بدء واستخدام البوت' },
  { command: 'help', description: 'ℹ️ القائمة والمساعدة' },
  { command: 'deposit', description: '💰 شحن الرصيد' },
  { command: 'methods', description: '💳 طرق الدفع' },
  { command: 'deposits', description: '🧾 إيداعاتي' },
  { command: 'balance', description: '💵 رصيدي' },
  { command: 'profile', description: '👤 حسابي وبيانات الدخول' },
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
export const ADMIN_EXTRA_COMMANDS: readonly BotCommand[] = Object.freeze([
  { command: 'queue', description: '📥 الطابور' },
  { command: 'report', description: '📊 تقرير النشاط' },
  { command: 'float', description: '🏦 رصيد الكاشيرة' },
  { command: 'breaks', description: '⚠️ مشاكل التسوية' },
  { command: 'register', description: '🆕 إنشاء حساب لاعب' },
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
  /** A failed fatal call fails that operator; a non-fatal one is only a warning. */
  readonly fatal: boolean;
  readonly detail: string;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

@Command({
  name: 'bot:setup',
  description:
    'Push an operator’s bot menus, descriptions and menu button (--tenant <slug> | --all-active).',
})
export class SetupBotCommand extends CommandRunner {
  private readonly logger = new Logger(SetupBotCommand.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bot: BotService,
  ) {
    super();
  }

  @Option({ flags: '--tenant <slug>', description: 'The operator to act on, by slug.' })
  parseTenant(value: string): string {
    return value;
  }

  @Option({ flags: '--all-active', description: 'Act on every ACTIVE operator.' })
  parseAllActive(): boolean {
    return true;
  }

  async run(_params: string[], options: TenantTargetOptions = {}): Promise<void> {
    const targets = await resolveTenantTargets(this.prisma, options);
    if (targets.length === 0) {
      this.logger.log('No ACTIVE operator exists; there is no bot to set up.');
      return;
    }

    const failed: string[] = [];
    for (const target of targets) {
      const firstFatal = await this.setUp(target);
      if (firstFatal !== null) {
        failed.push(target.slug);
        this.logger.error(`${target.slug}: bot:setup failed: ${firstFatal}`);
      }
    }

    if (failed.length > 0) {
      // Thrown AFTER every operator's summary so each result is still visible; main.cli.ts turns
      // this into a non-zero exit.
      throw new Error(
        `bot:setup failed for ${failed.length} of ${targets.length} operator(s): ${failed.join(', ')}`,
      );
    }
  }

  /** One operator's full setup. Returns the first fatal failure, or null when it all landed. */
  private async setUp(target: TenantTarget): Promise<string | null> {
    const outcomes: CallOutcome[] = [];
    const prefix = `${target.slug}:`;

    let api: Awaited<ReturnType<BotService['forTenant']>>['api'];
    try {
      api = (await this.bot.forTenant(target.id)).api;
    } catch (error: unknown) {
      // No bot, nothing else can run. TenantBotUnavailableError names the tenant, never the token.
      return describeError(error);
    }

    const attempt = async (
      call: string,
      fatal: boolean,
      invoke: () => Promise<unknown>,
      hintOnFailure?: string,
    ): Promise<void> => {
      try {
        await invoke();
        outcomes.push({ call, ok: true, fatal, detail: 'ok' });
        this.logger.log(`${prefix} ok    ${call}`);
      } catch (error: unknown) {
        const reason = describeError(error);
        const detail = hintOnFailure === undefined ? reason : `${reason} (${hintOnFailure})`;
        outcomes.push({ call, ok: false, fatal, detail });
        if (fatal) {
          this.logger.error(`${prefix} FAIL  ${call}: ${detail}`);
        } else {
          this.logger.warn(`${prefix} warn  ${call}: ${detail}`);
        }
      }
    };

    const adminCommands: BotCommand[] = [...PLAYER_COMMANDS, ...ADMIN_EXTRA_COMMANDS];

    // 1 — the DEFAULT scope: what every player sees. The one call that must succeed.
    await attempt('setMyCommands scope=default (player menu)', true, () =>
      api.setMyCommands([...PLAYER_COMMANDS], { scope: { type: 'default' } }),
    );

    // 2 — this operator's admin group gets the admin menu. 0 is "no admin group set yet".
    if (target.adminChatId === 0n) {
      this.logger.warn(
        `${prefix} no admin chat is set for this operator; admin group menu skipped`,
      );
    } else {
      const adminChatId = target.adminChatId.toString();
      await attempt(`setMyCommands scope=chat:${adminChatId} (admin chat)`, false, () =>
        api.setMyCommands(adminCommands, { scope: { type: 'chat', chat_id: adminChatId } }),
      );
    }

    // 3 — the same admin menu in each of THIS operator's active admins' private chats, so /queue
    // autocompletes when they talk to the bot directly. The tenant is named in the filter AND the
    // query runs in the operator's context, so no other operator's staff can appear. Console-only
    // admins (no Telegram id) have no private chat with the bot and are skipped.
    const admins = await runWithTenant(target.id, () =>
      this.prisma.adminUser.findMany({
        where: { tenantId: target.id, isActive: true, telegramUserId: { not: null } },
        select: { telegramUserId: true, displayName: true },
        orderBy: { displayName: 'asc' },
      }),
    );
    for (const admin of admins) {
      if (admin.telegramUserId === null) continue;
      const chatId = admin.telegramUserId.toString();
      await attempt(
        `setMyCommands scope=chat:${chatId} (admin “${admin.displayName}”)`,
        false,
        () => api.setMyCommands(adminCommands, { scope: { type: 'chat', chat_id: chatId } }),
        // Telegram answers 400 "chat not found" for a user who never pressed Start on this bot.
        // That is the admin's to fix, not a reason to abort the other menus.
        `has ${admin.displayName} started this bot? A chat-scoped menu needs an existing chat`,
      );
    }

    // 4 — the texts on the bot's profile / empty-chat screen.
    await attempt('setMyDescription', true, () => api.setMyDescription(BOT_DESCRIPTION));
    await attempt('setMyShortDescription', true, () =>
      api.setMyShortDescription(BOT_SHORT_DESCRIPTION),
    );

    // 5 — the ≡ menu button next to the input field opens the command list.
    await attempt('setChatMenuButton default=commands', true, () =>
      api.setChatMenuButton({ menu_button: { type: 'commands' } }),
    );

    const ok = outcomes.filter((outcome) => outcome.ok).length;
    this.logger.log(
      `${prefix} ${outcomes.length} calls (${admins.length} admin private chats): ` +
        `${ok} ok, ${outcomes.length - ok} failed`,
    );

    const fatal = outcomes.find((outcome) => !outcome.ok && outcome.fatal);
    return fatal === undefined ? null : `${fatal.call} — ${fatal.detail}`;
  }
}
