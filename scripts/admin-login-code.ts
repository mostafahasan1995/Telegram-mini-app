/**
 * Mint an admin login code from the command line, for MANUAL TESTING.
 *
 * The normal path is `/login` in a direct chat with the bot, which requires the worker to be
 * running and the tester to have a Telegram account that is already active staff. When you are
 * testing the console itself, that is three moving parts to debug at once. This script writes the
 * same Redis entry the bot would, so the console can be exercised with only the API running.
 *
 * It is deliberately NOT wired into the app: nothing imports it, and it must never be reachable
 * over HTTP. It is a developer tool that assumes whoever can run it already has the database
 * password and a shell on the machine.
 *
 * Usage:
 *   npm run admin:code -- stev1995          # by @username
 *   npm run admin:code -- 912911246         # by Telegram id
 *   npm run admin:code                      # lists active admins and exits
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { createHash, randomInt } from 'node:crypto';
import { Redis } from 'ioredis';

import 'dotenv/config';

/** MUST stay identical to AdminLoginCodeService — a drift here mints codes nothing can redeem. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const TTL_SECONDS = 300;

/**
 * Which audience the code is for. Staff codes are redeemed at POST /v1/admin/auth/bot-code; the
 * player scope belongs to /login in the bot and POST /v1/auth/bot-code. Scoping the key is what
 * stops one being usable on the other's route.
 */
const SCOPE = 'admin';

const hashCode = (normalized: string): string =>
  createHash('sha256').update(normalized, 'utf8').digest('hex');

async function main(): Promise<void> {
  const target = process.argv[2];
  // Prisma 7 requires an explicit driver adapter; the app does the same in prisma.service.ts.
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

  try {
    if (target === undefined) {
      const admins = await prisma.adminUser.findMany({
        where: { isActive: true },
        select: { telegramUserId: true, username: true, displayName: true, role: true },
        orderBy: { createdAt: 'asc' },
      });
      console.log(`\nActive admins (${admins.length}):\n`);
      for (const a of admins) {
        console.log(
          `  ${a.telegramUserId.toString().padEnd(14)} ` +
            `${(a.username === null ? '-' : `@${a.username}`).padEnd(20)} ` +
            `${a.role.padEnd(14)} ${a.displayName}`,
        );
      }
      console.log('\nRe-run with a username or Telegram id to mint a code.\n');
      return;
    }

    // A bare run of digits is a Telegram id; anything else is a username (with or without the @).
    const asId = /^\d+$/.test(target);
    const admin = await prisma.adminUser.findFirst({
      where: asId
        ? { telegramUserId: BigInt(target) }
        : { username: target.replace(/^@/, '') },
      select: {
        id: true,
        telegramUserId: true,
        username: true,
        displayName: true,
        role: true,
        isActive: true,
      },
    });

    if (admin === null) {
      console.error(`\nNo AdminUser matches "${target}". Run with no argument to list them.\n`);
      process.exitCode = 1;
      return;
    }

    if (!admin.isActive) {
      // Minting would succeed and redemption would then 403, which is a confusing way to find out.
      console.error(`\n"${target}" exists but isActive = false. Redemption would return 403.\n`);
      process.exitCode = 1;
      return;
    }

    const plain = Array.from(
      { length: CODE_LENGTH },
      () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
    ).join('');

    const subject = admin.telegramUserId.toString();
    // Key layout MUST match @core/auth/services/login-code.service.ts, which is scoped now that
    // players share the mechanism: `login-code:<scope>:<hash>`. Minting under the old unscoped
    // prefix produced codes the API could never find.
    const ownerKey = `login-code:${SCOPE}:owner:${subject}`;

    const previous = await redis.get(ownerKey);
    if (previous !== null) await redis.del(`login-code:${SCOPE}:${previous}`);

    const hash = hashCode(plain);
    await redis.set(`login-code:${SCOPE}:${hash}`, subject, 'EX', TTL_SECONDS);
    await redis.set(ownerKey, hash, 'EX', TTL_SECONDS);

    const grouped = `${plain.slice(0, 4)}-${plain.slice(4)}`;
    console.log(
      `\n  Admin : ${admin.displayName} (${admin.role})` +
        `\n  TG id : ${subject}` +
        `\n\n  CODE  : ${grouped}\n\n` +
        `  Valid ${TTL_SECONDS / 60} minutes, single use. Type it into the console sign-in screen.\n`,
    );
  } finally {
    await prisma.$disconnect();
    redis.disconnect();
  }
}

void main();
