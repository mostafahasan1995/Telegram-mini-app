/**
 * WHY a CLI command rather than calling setWebhook at boot: setWebhook is a global, account-wide
 * mutation. If every replica ran it on startup, a rolling deploy would repoint the webhook several
 * times, and a stale replica could point production at a URL from an older release. Registering the
 * webhook is a deliberate, once-per-environment deployment step.
 *
 *   npm run webhook:set -- --drop-pending
 */
import { Logger } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { AppConfigService } from '../../config/config.service';
import { BotService } from '../services/bot.service';
import { TELEGRAM_ALLOWED_UPDATES } from '../telegram.constants';

interface SetWebhookOptions {
  dropPending?: boolean;
  info?: boolean;
}

@Command({
  name: 'webhook:set',
  description: 'Point the Telegram bot at this deployment’s webhook URL.',
})
export class SetWebhookCommand extends CommandRunner {
  private readonly logger = new Logger(SetWebhookCommand.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly bot: BotService,
  ) {
    super();
  }

  @Option({
    flags: '--drop-pending',
    description: 'Discard updates queued at Telegram before this call (use after a long outage).',
  })
  parseDropPending(): boolean {
    return true;
  }

  @Option({
    flags: '--info',
    description: 'Only print the current webhook registration; change nothing.',
  })
  parseInfo(): boolean {
    return true;
  }

  async run(_params: string[], options: SetWebhookOptions = {}): Promise<void> {
    if (options.info === true) {
      await this.printInfo();
      return;
    }

    const { webhookUrl, webhookSecret } = this.config.telegram;

    // Telegram silently refuses to deliver to a non-https URL; catching it here beats debugging a
    // webhook that "works" but never fires.
    if (!webhookUrl.startsWith('https://')) {
      throw new Error(
        `Refusing to set a non-https webhook URL (${webhookUrl}). Telegram only delivers over TLS.`,
      );
    }

    const ok = await this.bot.setWebhook(
      webhookUrl,
      webhookSecret,
      TELEGRAM_ALLOWED_UPDATES,
      options.dropPending === true,
    );

    if (!ok) throw new Error('Telegram rejected setWebhook');

    this.logger.log(`Webhook set to ${webhookUrl}`);
    this.logger.log(`Subscribed update types: ${TELEGRAM_ALLOWED_UPDATES.join(', ')}`);
    await this.printInfo();
  }

  private async printInfo(): Promise<void> {
    const info = await this.bot.getWebhookInfo();
    this.logger.log(`url                    : ${info.url || '(none)'}`);
    this.logger.log(`pending_update_count   : ${info.pending_update_count}`);
    this.logger.log(`has_custom_certificate : ${String(info.has_custom_certificate)}`);
    this.logger.log(
      `allowed_updates        : ${(info.allowed_updates ?? []).join(', ') || '(all)'}`,
    );
    if (info.last_error_message !== undefined) {
      // The single most useful line when updates are not arriving.
      this.logger.warn(`last_error_message     : ${info.last_error_message}`);
    }
  }
}
