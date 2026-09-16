/**
 * Operational CLI entrypoint.
 *
 *   npm run webhook:set -- --tenant <slug>          point one operator's bot at this deployment
 *   npm run webhook:set -- --all-active             the same for every ACTIVE operator
 *   npm run webhook:set -- --tenant <slug> --info   show the current registration, change nothing
 *   npm run bot:setup -- --tenant <slug>            push that operator's bot menus
 *
 * There is no deployment-wide bot: every Telegram command names its operator(s), and acts through
 * each operator's own bot token, path token and secret, all read from the tenant row.
 *
 * WHY setWebhook is a command and not a boot step: it is an account-wide mutation. Running it on
 * startup means a rolling deploy repoints the webhook once per replica, and a straggler from the
 * previous release can point production back at an old URL.
 */
import '@common/helpers/bigint-json';

import { CommandFactory } from 'nest-commander';

import { CliModule } from './cli.module';

async function run(): Promise<void> {
  const app = await CommandFactory.createWithoutRunning(CliModule, {
    // The CLI's output IS the command's log lines; pino's request-scoped formatting adds nothing.
    logger: ['error', 'warn', 'log'],
    // WHY THIS HANDLER IS NOT OPTIONAL: when none is given, nest-commander catches a command's
    // rejection itself, writes it to stderr and RESOLVES — so a webhook:set that failed for an
    // operator exited 0, and tunnel-sync and deploy scripts, which only look at the exit status,
    // reported a registration that never happened as done. The failure is recorded here and turned
    // into the exit status below, after the app has been closed.
    serviceErrorHandler: (error: Error): void => {
      console.error(error.message);
      process.exitCode = 1;
    },
  });

  try {
    await CommandFactory.runApplication(app);
  } finally {
    // Redis and the pg pool keep the event loop alive. Closing is what lets the command exit
    // instead of hanging after printing its result.
    await app.close();
  }
}

run()
  // exitCode, not a hard 0: the service error handler above sets it when the command failed.
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
