/**
 * The first administrator, from the environment — because there is no bootstrap path into the admin
 * panel otherwise: `POST /v1/admin/admins` requires SUPER_ADMIN, and until this runs there is no
 * SUPER_ADMIN to authenticate as.
 *
 *   SEED_ADMIN_TELEGRAM_ID    required to seed anything (the numeric Telegram user id, from @userinfobot)
 *   SEED_ADMIN_DISPLAY_NAME   optional, defaults to "Owner"
 *   SEED_ADMIN_USERNAME       optional Telegram @username, without the @
 *   SEED_ADMIN_SINGLE_LIMIT_MINOR / SEED_ADMIN_DAILY_LIMIT_MINOR   optional approval ceilings
 *
 * WHY an approval limit is seeded alongside the user, and why it is not optional:
 * `AdminApprovalLimitService.evaluate()` FAILS CLOSED — an admin with no limit row is DENIED, not
 * unlimited. That is the correct default (an empty limits table must never mean infinite
 * authority), but it means seeding only the AdminUser produces an owner who can log in, see the
 * review queue, and approve nothing. The two rows belong together.
 *
 * WHY `secondApprovalAboveMinor` is left null: null means "use DUAL_APPROVAL_THRESHOLD_MINOR from
 * the environment". Pinning a per-admin override in a seed would quietly outrank the deployment's
 * own four-eyes threshold, which is the one number an operator expects to control from .env.
 *
 * Idempotency: the AdminUser is keyed on `telegramUserId` (unique). The limit is versioned rather
 * than mutated — `@@unique([adminUserId, currencyCode, effectiveFrom])` with `effectiveFrom`
 * defaulting to now() means a blind upsert would append a new row on every run — so an OPEN limit
 * (effectiveTo IS NULL) is treated as "already seeded" and left exactly as the operator left it.
 */
import { AdminRole, type PrismaClient } from '@prisma/client';

/** 5,000,000.00 NSP per deposit. */
const DEFAULT_SINGLE_LIMIT_MINOR = 500_000_000n;
/** 50,000,000.00 NSP per UTC day. */
const DEFAULT_DAILY_LIMIT_MINOR = 5_000_000_000n;

export interface SeededAdmin {
  skipped: boolean;
  reason?: string;
  adminUserId?: string;
  telegramUserId?: bigint;
  created?: boolean;
  limitCreated?: boolean;
}

function readBigint(raw: string | undefined, fallback: bigint, label: string): bigint {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${label} must be a non-negative integer in MINOR units, got "${raw}"`);
  }
  return BigInt(raw.trim());
}

export async function seedAdmin(
  prisma: PrismaClient,
  currencyCode: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SeededAdmin> {
  const rawTelegramId = env.SEED_ADMIN_TELEGRAM_ID?.trim();

  if (rawTelegramId === undefined || rawTelegramId.length === 0) {
    // Not an error: a CI database or a fresh clone has no owner to name yet. Everything else in
    // the seed is still useful, so this is reported and skipped rather than thrown.
    return { skipped: true, reason: 'SEED_ADMIN_TELEGRAM_ID is not set' };
  }

  if (!/^-?\d+$/.test(rawTelegramId)) {
    throw new Error(
      `SEED_ADMIN_TELEGRAM_ID must be an integer Telegram id, got "${rawTelegramId}"`,
    );
  }

  const telegramUserId = BigInt(rawTelegramId);
  const displayName = env.SEED_ADMIN_DISPLAY_NAME?.trim() || 'Owner';
  const username = env.SEED_ADMIN_USERNAME?.trim().replace(/^@/, '') || null;

  const existing = await prisma.adminUser.findUnique({
    where: { telegramUserId },
    select: { id: true },
  });

  const admin = await prisma.adminUser.upsert({
    where: { telegramUserId },
    create: {
      telegramUserId,
      username,
      displayName,
      role: AdminRole.SUPER_ADMIN,
      isActive: true,
    },
    update: {
      // Re-running the seed re-arms the owner: the deliberate escape hatch for "the only
      // SUPER_ADMIN deactivated themselves". Everything else about the row is left alone.
      displayName,
      role: AdminRole.SUPER_ADMIN,
      isActive: true,
    },
    select: { id: true },
  });

  const openLimit = await prisma.adminApprovalLimit.findFirst({
    where: { adminUserId: admin.id, currencyCode, effectiveTo: null },
    select: { id: true },
  });

  let limitCreated = false;
  if (openLimit === null) {
    await prisma.adminApprovalLimit.create({
      data: {
        adminUserId: admin.id,
        currencyCode,
        maxSingleApprovalMinor: readBigint(
          env.SEED_ADMIN_SINGLE_LIMIT_MINOR,
          DEFAULT_SINGLE_LIMIT_MINOR,
          'SEED_ADMIN_SINGLE_LIMIT_MINOR',
        ),
        maxDailyApprovalMinor: readBigint(
          env.SEED_ADMIN_DAILY_LIMIT_MINOR,
          DEFAULT_DAILY_LIMIT_MINOR,
          'SEED_ADMIN_DAILY_LIMIT_MINOR',
        ),
        // null => fall back to DUAL_APPROVAL_THRESHOLD_MINOR. See the header.
        secondApprovalAboveMinor: null,
      },
    });
    limitCreated = true;
  }

  return {
    skipped: false,
    adminUserId: admin.id,
    telegramUserId,
    created: existing === null,
    limitCreated,
  };
}
