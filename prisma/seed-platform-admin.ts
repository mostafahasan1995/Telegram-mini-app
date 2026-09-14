/**
 * First-run bootstrap:  npm run seed:platform-admin
 *
 * Creates (or re-arms) the one PLATFORM_ADMIN that signs into the dashboard with a username and a
 * password. See prisma/seed/platform-admin.seed.ts for every rule; this file is only the process
 * around it.
 *
 * PRODUCTION-SAFE BY DESIGN, unlike `npm run seed`: it writes one account and nothing else — no
 * placeholder payment destinations, no fixtures — so it has no production guard to bypass and the
 * npm script forces no NODE_ENV. It runs in the tools image as it is:
 *
 *   docker compose run --rm -e SEED_PLATFORM_ADMIN_USERNAME=owner -e SEED_PLATFORM_ADMIN_PASSWORD \
 *     tools npm run seed:platform-admin
 *
 * (a bare `-e NAME` forwards the caller's value, so the password never appears in the command).
 *
 * OUTPUT: one line on success — the username and created / updated / unchanged. Never the password,
 * never the hash, not even the database URL. Exit 2 for input the operator has to fix (or a refused
 * situation), 1 for anything else.
 */
import { existsSync } from 'node:fs';

// WHY only outside production: ts-node never reads prisma.config.ts, so a developer's .env would be
// absent. In production the environment is the container's, and a stray .env must not override it
// (the same rule src/core/config/config.module.ts applies). loadEnvFile never overrides a variable
// that is already set.
if (!process.env.SKIP_DOTENV && process.env.NODE_ENV !== 'production' && existsSync('.env')) {
  process.loadEnvFile('.env');
}

import { PasswordHasherService } from '@core/auth/services/password-hasher.service';

import { createSeedClient } from './seed/client';
import {
  PLATFORM_ADMIN_ENV,
  PlatformAdminSeedError,
  describeSeedFailure,
  readPlatformAdminInput,
  seedPlatformAdmin,
} from './seed/platform-admin.seed';

const PREFIX = '[seed:platform-admin]';
const EXIT_FAILED = 1;
const EXIT_BAD_INPUT = 2;

async function main(): Promise<number> {
  // Validated before any connection is opened: a typo should cost nothing but the message.
  const input = readPlatformAdminInput(process.env);

  const { prisma, close } = createSeedClient();
  try {
    // The production cost, so the sign-in route never has to re-hash on first use.
    const result = await seedPlatformAdmin(prisma, input, new PasswordHasherService());
    process.stdout.write(`${PREFIX} ${result.username}: ${result.outcome}\n`);
    return 0;
  } finally {
    await close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof PlatformAdminSeedError) {
      console.error(`${PREFIX} ${error.message}`);
      process.exitCode = EXIT_BAD_INPUT;
      return;
    }
    const password = process.env[PLATFORM_ADMIN_ENV.password] ?? '';
    console.error(`${PREFIX} failed: ${describeSeedFailure(error, [password])}`);
    process.exitCode = EXIT_FAILED;
  });
