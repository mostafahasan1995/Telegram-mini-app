import { Logger } from '@nestjs/common';
import type { AppConfigService } from '../../config/config.service';
import type { BotService } from '../services/bot.service';
import { SetWebhookCommand } from './set-webhook.command';

const TOKEN = 'wh_0123456789abcdef0123456789abcdef';
const OUR_URL = `https://api.example.test/telegram/webhook/${TOKEN}`;

interface Harness {
  command: SetWebhookCommand;
  bot: { setWebhook: jest.Mock; getWebhookInfo: jest.Mock };
  lines: () => string[];
}

function build(webhookUrl: string, telegramUrl: string): Harness {
  const config = {
    telegram: { webhookUrl, webhookSecret: 'secret-header-value' },
  } as unknown as AppConfigService;
  const bot = {
    setWebhook: jest.fn().mockResolvedValue(true),
    getWebhookInfo: jest.fn().mockResolvedValue({
      url: telegramUrl,
      pending_update_count: 0,
      has_custom_certificate: false,
      allowed_updates: ['message'],
      last_error_message: `Wrong response from ${telegramUrl}`,
    }),
  };
  const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const command = new SetWebhookCommand(config, bot as unknown as BotService);
  const lines = (): string[] =>
    [...log.mock.calls, ...warn.mock.calls].map((call) => String(call[0]));
  return { command, bot, lines };
}

describe('SetWebhookCommand', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('never logs the path token when setting the webhook, but still sends it to Telegram', async () => {
    const { command, bot, lines } = build(OUR_URL, OUR_URL);

    await command.run([], {});

    expect(bot.setWebhook).toHaveBeenCalledWith(
      OUR_URL,
      'secret-header-value',
      expect.anything(),
      false,
    );
    expect(lines().length).toBeGreaterThan(0);
    for (const line of lines()) expect(line).not.toContain(TOKEN);
    expect(lines()).toContain(
      'Webhook set to https://api.example.test/telegram/webhook/[REDACTED]',
    );
    expect(lines()).toContain('matches_this_deployment: yes');
  });

  it('--info reports a mismatch when Telegram points at another token, without printing either', async () => {
    const otherToken = 'wh_stale_ffffffffffffffffffffffffffff';
    const { command, bot, lines } = build(
      OUR_URL,
      `https://api.example.test/telegram/webhook/${otherToken}`,
    );

    await command.run([], { info: true });

    expect(bot.setWebhook).not.toHaveBeenCalled();
    for (const line of lines()) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain(otherToken);
    }
    expect(lines()).toContain('matches_this_deployment: no');
  });

  it('masks the token in the non-https refusal', async () => {
    const { command } = build(`http://api.example.test/telegram/webhook/${TOKEN}`, '');

    const failure = command.run([], {});

    await expect(failure).rejects.toThrow('/telegram/webhook/[REDACTED]');
    await expect(failure).rejects.not.toThrow(TOKEN);
  });
});
