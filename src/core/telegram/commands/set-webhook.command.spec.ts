import { BOT_SETUP_RETIRED_MESSAGE, SetupBotCommand } from './setup-bot.command';
import { SetWebhookCommand, WEBHOOK_SET_RETIRED_MESSAGE } from './set-webhook.command';

/**
 * Both commands drove the global bot, which no longer exists. What is left to pin is that they refuse
 * with an explanation instead of silently registering a URL the webhook route would answer 403 to.
 */
describe('retired global-bot commands', () => {
  it('webhook:set refuses and says where webhooks are registered now', async () => {
    await expect(new SetWebhookCommand().run()).rejects.toThrow(WEBHOOK_SET_RETIRED_MESSAGE);
  });

  it('bot:setup refuses and says where bot menus are set up now', async () => {
    await expect(new SetupBotCommand().run()).rejects.toThrow(BOT_SETUP_RETIRED_MESSAGE);
  });
});
