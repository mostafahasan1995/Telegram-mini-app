/**
 * Points an OPERATOR's own bot at that operator's own webhook URL.
 *
 *   npm run webhook:set -- --tenant <slug>            one operator (any status)
 *   npm run webhook:set -- --all-active               every ACTIVE operator, e.g. after API_BASE_URL moved
 *   npm run webhook:set -- --tenant <slug> --info     show Telegram's registration, change nothing
 *   npm run webhook:set -- --all-active --drop-pending
 *
 * WHAT IS REGISTERED: `<API_BASE_URL>/telegram/webhook/<the operator's webhook_path_token>`, with the
 * operator's own webhook secret as Telegram's `secret_token`, through the operator's own bot. Nothing
 * deployment-wide takes part: no env token, no env path, no env secret. Those are exactly what the
 * webhook route checks an update against, so registering anything else would point a bot at a URL
 * that answers 403 to every delivery.
 *
 * WHAT IT DOES NOT DO: create a path token or a secret. An operator whose row has neither was never
 * given a webhook, and generating credentials is the dashboard's job (it seals them, audits it and
 * evicts the route cache); this command refuses with that instruction instead.
 *
 * WHY a CLI command rather than calling setWebhook at boot: setWebhook is an account-wide mutation.
 * If every replica ran it on startup, a rolling deploy would repoint webhooks several times, and a
 * stale replica could point production at a URL from an older release.
 *
 * WHY every URL this command logs has its path token masked: operators run it as
 * `compose run --rm tools`, and that container's stdout can land in Loki next to everything else. To
 * still answer "is Telegram pointed at THIS deployment?", the info block compares Telegram's URL
 * with ours on the unmasked values and prints the verdict.
 *
 * One operator failing (a revoked token, no path token yet) is reported and the rest carry on; the
 * command exits non-zero at the end, naming every operator that failed.
 */
import { Logger } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';

import { redactWebhookPathToken } from '@common/helpers/request-url-redaction.util';

import { AppConfigService } from '../../config/config.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  TenantSecretService,
  isTenantSecretError,
} from '../../tenant/services/tenant-secret.service';
import { BotService } from '../services/bot.service';
import { TELEGRAM_ALLOWED_UPDATES, telegramWebhookUrl } from '../telegram.constants';
import {
  type TenantTarget,
  type TenantTargetOptions,
  resolveTenantTargets,
} from './tenant-targets';

interface SetWebhookOptions extends TenantTargetOptions {
  dropPending?: boolean;
  info?: boolean;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

@Command({
  name: 'webhook:set',
  description:
    'Register operators’ Telegram webhooks through their own bots (--tenant <slug> | --all-active).',
})
export class SetWebhookCommand extends CommandRunner {
  private readonly logger = new Logger(SetWebhookCommand.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly secrets: TenantSecretService,
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
    const targets = await resolveTenantTargets(this.prisma, options);
    if (targets.length === 0) {
      this.logger.log('No ACTIVE operator exists; there is no webhook to register.');
      return;
    }

    const failed: string[] = [];
    for (const target of targets) {
      try {
        if (options.info === true) {
          await this.printInfo(target);
        } else {
          await this.register(target, options.dropPending === true);
        }
      } catch (error: unknown) {
        failed.push(target.slug);
        // Messages from the registry and the secret service name the tenant, never a credential.
        this.logger.error(`${target.slug}: ${describeError(error)}`);
      }
    }

    if (failed.length > 0) {
      throw new Error(
        `webhook:set failed for ${failed.length} of ${targets.length} operator(s): ${failed.join(', ')}`,
      );
    }
  }

  private async register(target: TenantTarget, dropPending: boolean): Promise<void> {
    const url = this.webhookUrlOf(target);
    if (url === null) {
      throw new Error(
        'has no webhook path token yet. Generate the webhook from the dashboard ' +
          '(POST /v1/admin/tenants/:id/webhook); this command only re-registers an existing one.',
      );
    }
    // Telegram silently refuses to deliver to a non-https URL; catching it here beats debugging a
    // webhook that "works" but never fires.
    if (!url.startsWith('https://')) {
      throw new Error(
        `refusing to set a non-https webhook URL (${redactWebhookPathToken(url)}). ` +
          'Telegram only delivers over TLS; set API_BASE_URL to the public https origin.',
      );
    }

    const secret = this.openSecret(target);
    const ok = await this.bot.setWebhook(
      target.id,
      url,
      secret,
      TELEGRAM_ALLOWED_UPDATES,
      dropPending,
    );
    if (!ok) throw new Error('Telegram rejected setWebhook');

    this.logger.log(`${target.slug}: webhook set to ${redactWebhookPathToken(url)}`);
    this.logger.log(
      `${target.slug}: subscribed update types: ${TELEGRAM_ALLOWED_UPDATES.join(', ')}`,
    );
    if (target.status !== 'ACTIVE') {
      // Not an error: registering before activation is the intended order. But nobody should read
      // "webhook set" as "the bot answers" while the webhook still drops this operator's updates.
      this.logger.warn(
        `${target.slug}: operator is ${target.status}; its updates are acknowledged and dropped ` +
          'until it is activated',
      );
    }
    await this.printInfo(target);
  }

  private async printInfo(target: TenantTarget): Promise<void> {
    const info = await this.bot.getWebhookInfo(target.id);
    const expected = this.webhookUrlOf(target);
    const prefix = `${target.slug}:`;
    this.logger.log(
      `${prefix} url                    : ${redactWebhookPathToken(info.url || '(none)')}`,
    );
    // Compared on the unmasked values, so a stale token (an old deployment, a rotated path token)
    // shows up as "no" even though both masked URLs print identically above.
    this.logger.log(
      `${prefix} matches_this_deployment: ${expected !== null && info.url === expected ? 'yes' : 'no'}`,
    );
    this.logger.log(`${prefix} pending_update_count   : ${info.pending_update_count}`);
    this.logger.log(
      `${prefix} allowed_updates        : ${(info.allowed_updates ?? []).join(', ') || '(all)'}`,
    );
    if (info.last_error_message !== undefined) {
      // The single most useful line when updates are not arriving. Masked too: it is Telegram's free
      // text, and nothing guarantees it never quotes the URL it failed to reach.
      this.logger.warn(
        `${prefix} last_error_message     : ${redactWebhookPathToken(info.last_error_message)}`,
      );
    }
  }

  private webhookUrlOf(target: TenantTarget): string | null {
    return target.webhookPathToken === null
      ? null
      : telegramWebhookUrl(this.config.app.baseUrl, target.webhookPathToken);
  }

  private openSecret(target: TenantTarget): string {
    try {
      return this.secrets.openWebhookSecret(target);
    } catch (error: unknown) {
      if (!isTenantSecretError(error)) throw error;
      // Without the secret Telegram would deliver updates the webhook route refuses with 403.
      throw new Error(
        `its webhook secret cannot be used (${error.code}). Regenerate the webhook from the dashboard.`,
      );
    }
  }
}
