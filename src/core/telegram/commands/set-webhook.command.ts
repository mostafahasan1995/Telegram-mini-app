/**
 * RETIRED. `webhook:set` pointed the ONE global bot (TELEGRAM_BOT_TOKEN) at the ONE global webhook
 * URL (TELEGRAM_WEBHOOK_PATH_TOKEN, TELEGRAM_WEBHOOK_SECRET).
 *
 * Neither exists in a multi-operator deployment. Every operator has its own bot token, webhook path
 * token and secret on its tenant row, and the webhook route only accepts those. Registering the
 * global URL would point a bot at a path that answers 403 to every delivery. So the command refuses,
 * loudly, instead of doing something that looks like it worked. Webhooks are registered per operator
 * from the dashboard.
 *
 * It stays registered, not deleted, so `npm run webhook:set` in an old runbook explains itself
 * rather than failing with "unknown command".
 */
import { Command, CommandRunner } from 'nest-commander';

export const WEBHOOK_SET_RETIRED_MESSAGE =
  'webhook:set is retired: there is no global Telegram bot any more. Each operator’s webhook is ' +
  'registered for that operator’s own bot from the dashboard.';

@Command({
  name: 'webhook:set',
  description: 'Retired: webhooks are registered per operator from the dashboard.',
})
export class SetWebhookCommand extends CommandRunner {
  run(): Promise<void> {
    return Promise.reject(new Error(WEBHOOK_SET_RETIRED_MESSAGE));
  }
}
