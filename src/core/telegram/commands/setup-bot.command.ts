/**
 * RETIRED. `bot:setup` pushed command menus, descriptions and the menu button through the ONE global
 * bot (TELEGRAM_BOT_TOKEN), and scoped the admin menu to TELEGRAM_ADMIN_CHAT_ID and to every active
 * admin of EVERY operator.
 *
 * There is no global bot any more: each operator's token is sealed on its own tenant row. Pushing
 * one operator's staff list into another operator's bot would also enumerate staff across operators.
 * So the command refuses instead of guessing which bot it means. A bot's menus are set up per
 * operator from the dashboard.
 *
 * It stays registered, not deleted, so `npm run bot:setup` in an old runbook explains itself rather
 * than failing with "unknown command".
 */
import { Command, CommandRunner } from 'nest-commander';

export const BOT_SETUP_RETIRED_MESSAGE =
  'bot:setup is retired: there is no global Telegram bot any more. Each operator’s bot menus are ' +
  'set up for that operator’s own bot from the dashboard.';

@Command({
  name: 'bot:setup',
  description: 'Retired: bot menus are set up per operator from the dashboard.',
})
export class SetupBotCommand extends CommandRunner {
  run(): Promise<void> {
    return Promise.reject(new Error(BOT_SETUP_RETIRED_MESSAGE));
  }
}
