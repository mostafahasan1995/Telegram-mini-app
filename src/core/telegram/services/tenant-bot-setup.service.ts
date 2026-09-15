/**
 * Pushes an OPERATOR's command menus and profile texts through that operator's own bot. One
 * implementation for the three callers that need it: `POST /v1/admin/tenants/:id/bot-setup`, tenant
 * creation's provisioning step, and the `bot:setup` CLI.
 *
 * PER OPERATOR, ALL THE WAY DOWN: the bot is the operator's (TenantBotRegistry opens its sealed
 * token), the admin chat is the operator's (`tenants.admin_chat_id`), and the staff who get the admin
 * menu in their private chats are that operator's active admins only. A single-bot version once read
 * every operator's staff with no tenant filter, which through one bot would have enumerated staff
 * across operators.
 *
 * THE SCOPES, and why each:
 *  - `default` and `all_private_chats` get the PLAYER menu. These two are what the dashboard's mock
 *    reports for a new operator (`menuScopes: ['default', 'all_private_chats']`), and they are the
 *    only calls every player depends on, so a failure of either fails the push.
 *  - the admin chat gets the admin menu: as `chat_administrators` when it is a group (a negative id),
 *    the scope the mock lists, or as `chat` when it is somebody's private chat, which is what a new
 *    operator's admin chat is (the creating platform admin's own Telegram id). Telegram refuses
 *    `chat_administrators` for a private chat.
 *  - each active admin with a Telegram id gets the admin menu in their private chat, so /queue
 *    autocompletes when they talk to the bot directly.
 *  The admin menu is never pushed to `default`: the admin handlers answer non-admins with silence
 *  precisely so the staff surface cannot be enumerated, and a global menu listing /queue would undo it.
 *
 * WHAT IS ONLY A WARNING: a chat-scoped menu for a chat that never started the bot (Telegram answers
 * 400 "chat not found"), the profile descriptions, and the menu button. None of them stops a player
 * from using the bot, so none of them reports the menus as not pushed.
 *
 * IDEMPOTENT by construction: every Bot API call below overwrites the previous value, never appends.
 *
 * NOTHING HERE THROWS FOR A TELEGRAM FAILURE. An operator whose bot cannot be built, or a call
 * Telegram refuses, comes back in the result. grammY keeps the token out of its error messages, and
 * so does every message built here. Infrastructure errors (the database is down) still throw.
 */
import { Injectable, Logger } from '@nestjs/common';
import { type BotCommand, type BotCommandScope } from 'grammy/types';

import { PrismaService } from '../../prisma/prisma.service';
import { runWithTenant } from '../../tenant/tenant.storage';
import { isTenantBotUnavailableError } from '../tenant-bot.errors';
import { TenantBotRegistry } from './tenant-bot-registry.service';

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
 * src/modules/admin/telegram/admin.handlers.ts.
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

export interface BotMenuPushResult {
  /** How many distinct commands landed across every menu that was accepted. */
  commandsSet: number;
  /** The Telegram scope types that were accepted, each once, in the order they were pushed. */
  scopes: string[];
  /**
   * Why the push failed, or null when every player-facing menu landed. A sentence for an admin,
   * naming the call and Telegram's answer, never a token.
   */
  fatalError: string | null;
  /** Calls that failed without failing the push, one sentence each. */
  warnings: string[];
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

@Injectable()
export class TenantBotSetupService {
  private readonly logger = new Logger(TenantBotSetupService.name);

  constructor(
    private readonly bots: TenantBotRegistry,
    private readonly prisma: PrismaService,
  ) {}

  async pushMenus(tenantId: string): Promise<BotMenuPushResult> {
    const commands = new Set<string>();
    const scopes: string[] = [];
    const warnings: string[] = [];
    let fatalError: string | null = null;

    let api: Awaited<ReturnType<TenantBotRegistry['get']>>['api'];
    try {
      api = (await this.bots.get(tenantId)).api;
    } catch (error: unknown) {
      if (!isTenantBotUnavailableError(error)) throw error;
      // No bot, nothing else can run. The message names the tenant, never the token.
      return { commandsSet: 0, scopes: [], fatalError: error.message, warnings: [] };
    }

    const attempt = async (
      call: string,
      fatal: boolean,
      invoke: () => Promise<unknown>,
      hint?: string,
    ): Promise<boolean> => {
      try {
        await invoke();
        return true;
      } catch (error: unknown) {
        const detail = `${call} failed: ${describeError(error)}${hint === undefined ? '' : ` (${hint})`}`;
        if (fatal) {
          fatalError ??= detail;
          this.logger.error(`Tenant ${tenantId}: ${detail}`);
        } else {
          warnings.push(detail);
          this.logger.warn(`Tenant ${tenantId}: ${detail}`);
        }
        return false;
      }
    };

    const pushMenu = async (
      menu: readonly BotCommand[],
      scope: BotCommandScope,
      fatal: boolean,
      hint?: string,
    ): Promise<void> => {
      const landed = await attempt(
        `setMyCommands for scope ${scope.type}`,
        fatal,
        () => api.setMyCommands([...menu], { scope }),
        hint,
      );
      if (!landed) return;
      for (const command of menu) commands.add(command.command);
      if (!scopes.includes(scope.type)) scopes.push(scope.type);
    };

    const adminMenu: BotCommand[] = [...PLAYER_COMMANDS, ...ADMIN_EXTRA_COMMANDS];

    // 1 — what every player sees, in every chat and in private chats. The calls that must succeed.
    await pushMenu(PLAYER_COMMANDS, { type: 'default' }, true);
    await pushMenu(PLAYER_COMMANDS, { type: 'all_private_chats' }, true);

    // 2 — this operator's admin chat. 0 is "no admin chat set yet".
    const row = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { adminChatId: true },
    });
    const adminChatId = row?.adminChatId ?? 0n;
    const pushedChats = new Set<string>();
    if (adminChatId < 0n) {
      await pushMenu(
        adminMenu,
        { type: 'chat_administrators', chat_id: adminChatId.toString() },
        false,
        'is the bot a member of the admin group?',
      );
    } else if (adminChatId > 0n) {
      pushedChats.add(adminChatId.toString());
      await pushMenu(
        adminMenu,
        { type: 'chat', chat_id: adminChatId.toString() },
        false,
        'a private admin chat has to have started this bot first',
      );
    }

    // 3 — each of THIS operator's active admins in their private chat. The tenant is named in the
    // filter AND the query runs in the operator's context, so no other operator's staff can appear.
    // Console-only admins (no Telegram id) have no private chat with the bot and are skipped.
    const admins = await runWithTenant(tenantId, () =>
      this.prisma.adminUser.findMany({
        where: { tenantId, isActive: true, telegramUserId: { not: null } },
        select: { telegramUserId: true },
        orderBy: { displayName: 'asc' },
      }),
    );
    for (const admin of admins) {
      if (admin.telegramUserId === null) continue;
      const chatId = admin.telegramUserId.toString();
      if (pushedChats.has(chatId)) continue;
      pushedChats.add(chatId);
      await pushMenu(
        adminMenu,
        { type: 'chat', chat_id: chatId },
        false,
        'a chat-scoped menu needs the admin to have started this bot',
      );
    }

    // 4 — the profile texts and the ≡ menu button. Cosmetic: never a reason to say menus failed.
    await attempt('setMyDescription', false, () => api.setMyDescription(BOT_DESCRIPTION));
    await attempt('setMyShortDescription', false, () =>
      api.setMyShortDescription(BOT_SHORT_DESCRIPTION),
    );
    await attempt('setChatMenuButton', false, () =>
      api.setChatMenuButton({ menu_button: { type: 'commands' } }),
    );

    return { commandsSet: commands.size, scopes, fatalError, warnings };
  }
}
