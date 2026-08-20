/**
 * `npm run player:register` — open Ichancy accounts, under our agent, from a terminal.
 *
 *   npm run player:register -- --telegram-id 123456789
 *   npm run player:register -- --player-id 9f3c1e58-....
 *   npm run player:register -- --all-pending            # everyone who has no account yet
 *   npm run player:register -- --all-pending --limit 50 --dry-run
 *
 * WHY A COMMAND AND NOT ONLY THE HTTP ROUTE: the backfill. `--all-pending` is for the population
 * that accumulated before /start started registering — a loop no admin should be clicking through,
 * and one that must be re-runnable after it stops halfway.
 *
 * WHY IT CALLS ensureLinked AND NOTHING ELSE: that method is the single implementation of a
 * registration this system has, and it is idempotent three ways over (credentials derived from the
 * player id, "Duplicate login" treated as success, a compare-and-set persist behind a distributed
 * lock). Re-running this command after a crash converges; it does not duplicate.
 *
 * ══ WHICH APP_ROLE TO RUN THIS AS ═════════════════════════════════════════════════════════════
 * The npm script sets APP_ROLE=api, which is the SAFE default: an api process never signs in to
 * Ichancy, it reuses the token pair the worker holds in Redis. Ichancy allows exactly one live pair
 * per agent, so running this as APP_ROLE=worker while the real worker is up would kill the worker's
 * session mid-credit. If no worker has ever run, this command says so and tells you what to do.
 */
import { Logger } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';

import { PrismaService } from '@core/prisma/prisma.service';
import { isAppException } from '@common/exceptions/app.exception';

import { PlayerLinkService } from '../services/player-link.service';

interface RegisterPlayerOptions {
  playerId?: string;
  telegramId?: string;
  allPending?: boolean;
  limit?: number;
  dryRun?: boolean;
}

/** Default ceiling on a backfill run. High enough to be useful, low enough to be interruptible. */
const DEFAULT_BACKFILL_LIMIT = 100;

const describeError = (error: unknown): string =>
  isAppException(error)
    ? `${error.errorCode}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);

@Command({
  name: 'player:register',
  description: 'Create the Ichancy account (under our agent) for one player, or backfill many.',
})
export class RegisterPlayerCommand extends CommandRunner {
  private readonly logger = new Logger('player:register');

  constructor(
    private readonly prisma: PrismaService,
    private readonly links: PlayerLinkService,
  ) {
    super();
  }

  @Option({ flags: '--player-id <uuid>', description: 'Our players.id' })
  parsePlayerId(value: string): string {
    return value.trim();
  }

  @Option({ flags: '--telegram-id <id>', description: 'The player’s Telegram user id' })
  parseTelegramId(value: string): string {
    return value.trim();
  }

  @Option({
    flags: '--all-pending',
    description: 'Register every player who has no Ichancy account yet',
  })
  parseAllPending(): boolean {
    return true;
  }

  @Option({
    flags: '--limit <n>',
    description: `Cap for --all-pending (default ${DEFAULT_BACKFILL_LIMIT})`,
  })
  parseLimit(value: string): number {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error('--limit must be a positive integer');
    }
    return parsed;
  }

  @Option({ flags: '--dry-run', description: 'List who would be registered, contact nobody' })
  parseDryRun(): boolean {
    return true;
  }

  async run(_args: string[], options: RegisterPlayerOptions = {}): Promise<void> {
    const targets = await this.resolveTargets(options);
    if (targets.length === 0) {
      this.logger.log('Nothing to do: no player matched.');
      return;
    }

    if (options.dryRun === true) {
      this.logger.log(`DRY RUN — ${String(targets.length)} player(s) would be registered:`);
      for (const target of targets) this.logger.log(`  ${target.id}  tg:${target.telegramUserId}`);
      return;
    }

    let created = 0;
    let existed = 0;
    let failed = 0;

    for (const target of targets) {
      try {
        const link = await this.links.ensureLinked(target.id, 'cli:player:register');
        // Clear the cron's backoff bookkeeping so a player rescued by hand does not keep showing a
        // stale "attempt 12, CLOUDFLARE_CHALLENGE" to the next operator who looks. The attempt
        // COUNT is kept: "this one took nine tries" is forensics worth having after an outage.
        await this.prisma.player.updateMany({
          where: { id: target.id, ichancyPlayerId: { not: null } },
          data: { ichancyLinkNextAttemptAt: null, ichancyLinkLastError: null },
        });
        if (link.created) {
          created += 1;
          this.logger.log(
            `created  ${target.id}  login=${link.ichancyLogin}  ichancy=${link.ichancyPlayerId}`,
          );
        } else {
          existed += 1;
          this.logger.log(
            `existed  ${target.id}  login=${link.ichancyLogin}  ichancy=${link.ichancyPlayerId}`,
          );
        }
      } catch (error: unknown) {
        // One player's failure must not abandon the rest of a backfill: the whole point of the run
        // is to shrink the pending set, and a re-run picks up whatever is left.
        failed += 1;
        this.logger.error(
          `FAILED   ${target.id}  tg:${target.telegramUserId}  ${describeError(error)}`,
        );
      }
    }

    this.logger.log(
      `── done: ${String(created)} created, ${String(existed)} already existed, ${String(failed)} failed`,
    );
    if (failed > 0) {
      // Non-zero exit so a scripted backfill cannot report success while leaving people unregistered.
      throw new Error(`${String(failed)} player(s) could not be registered`);
    }
  }

  /** Exactly one selector must be given; ambiguity here would register the wrong person. */
  private async resolveTargets(
    options: RegisterPlayerOptions,
  ): Promise<{ id: string; telegramUserId: bigint }[]> {
    const selectors = [options.playerId, options.telegramId, options.allPending].filter(
      (value) => value !== undefined,
    );
    if (selectors.length !== 1) {
      throw new Error('Give exactly one of --player-id, --telegram-id or --all-pending');
    }

    const select = { id: true, telegramUserId: true } as const;

    if (options.playerId !== undefined) {
      const player = await this.prisma.player.findUnique({
        where: { id: options.playerId },
        select,
      });
      if (player === null) throw new Error(`No player with id ${options.playerId}`);
      return [player];
    }

    if (options.telegramId !== undefined) {
      let telegramUserId: bigint;
      try {
        telegramUserId = BigInt(options.telegramId);
      } catch {
        throw new Error(`--telegram-id must be a whole number, got "${options.telegramId}"`);
      }
      const player = await this.prisma.player.findUnique({ where: { telegramUserId }, select });
      if (player === null) {
        throw new Error(
          `No player with Telegram id ${options.telegramId}. They have to press /start once ` +
            'before an account can be opened for them — the row is their identity here.',
        );
      }
      return [player];
    }

    // Oldest first: the people who have been waiting longest are registered first, and the ordering
    // is total so an interrupted run resumes predictably rather than reshuffling.
    //
    // `status: 'PENDING_ICHANCY'` is load-bearing. linkIchancyAccount force-sets `status: 'ACTIVE'`
    // with a WHERE of only `{ id, ichancyPlayerId: null }`, so a bare `ichancyPlayerId: null`
    // selector would mint a casino account for a SUSPENDED / SELF_EXCLUDED / CLOSED player and
    // silently reactivate them — and there is no deletePlayer to undo it with. Naming one player
    // explicitly (--player-id / --telegram-id) is still allowed to override that, because that is a
    // human making a deliberate choice about a specific person.
    return this.prisma.player.findMany({
      where: { status: 'PENDING_ICHANCY', ichancyPlayerId: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: options.limit ?? DEFAULT_BACKFILL_LIMIT,
      select,
    });
  }
}
