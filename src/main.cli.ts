/**
 * Operational CLI entrypoint.
 *
 *   npm run webhook:set                 point Telegram at this deployment
 *   npm run webhook:set -- --info       show the current registration, change nothing
 *   npm run webhook:set -- --drop-pending
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
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
