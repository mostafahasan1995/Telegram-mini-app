/**
 * Pushes an OPERATOR's command menus, descriptions and menu button through that operator's own bot.
 *
 *   npm run bot:setup -- --tenant <slug>
 *   npm run bot:setup -- --all-active
 *
 * WHY a CLI command as well as `POST /v1/admin/tenants/:id/bot-setup`: after a deploy that changes
 * the command surface, every serving operator needs the new menus, and nobody should have to click
 * through each one in the dashboard. Both run TenantBotSetupService, so the CLI and the console can
 * never push different menus.
 *
 * WHY never at boot: setMyCommands, setMyDescription and setChatMenuButton are account-wide
 * mutations. If every replica pushed them on startup, a rolling deploy would rewrite a bot's public
 * UI once per replica, and a stale replica could push menus from an older release.
 *
 * One operator failing is reported and the rest carry on; the command exits non-zero at the end,
 * naming every operator that failed.
 */
import { Logger } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';

import { PrismaService } from '../../prisma/prisma.service';
import { TenantBotSetupService } from '../services/tenant-bot-setup.service';
import {
  type TenantTarget,
  type TenantTargetOptions,
  resolveTenantTargets,
} from './tenant-targets';

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
    private readonly setup: TenantBotSetupService,
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

  /** One operator's setup. Returns the failure that stops its players' menus, or null. */
  private async setUp(target: TenantTarget): Promise<string | null> {
    try {
      const result = await this.setup.pushMenus(target.id);
      this.logger.log(
        `${target.slug}: ${result.commandsSet} commands on scopes ` +
          `${result.scopes.join(', ') || '(none)'}; ${result.warnings.length} warning(s)`,
      );
      return result.fatalError;
    } catch (error: unknown) {
      return describeError(error);
    }
  }
}
