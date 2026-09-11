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
 * WHICH TENANT THESE ADMINS LIVE IN — and why there are TWO rows for one human:
 *
 * Home tenant is identity, so "the person bootstrapping this deployment" genuinely has two of
 * them, and one row cannot be both:
 *
 *   SUPER_ADMIN    in the BOOTSTRAP OPERATOR. This is the row that runs the business — it reviews
 *                  the deposit queue and approves money. Its approval limit is tenant-scoped, and
 *                  `AdminApprovalLimitService.evaluate()` fails closed, so a limit filed in any
 *                  other tenant authorises nothing and the owner would be unable to approve with
 *                  no error saying why. The limit must sit in the same tenant as the deposits.
 *
 *   PLATFORM_ADMIN in TENANT ZERO. This is the row that runs the platform — the only one whose
 *                  X-Tenant-Id header is honoured, and therefore the only way to reach
 *                  /v1/admin/tenants at all. `prisma/sql/006_tenant_isolation.sql` refuses to
 *                  write a PLATFORM_ADMIN anywhere else, so tenant zero is not a preference here.
 *                  It gets NO approval limit: the platform does not approve an operator's money.
 *
 * Seeding only the first would leave nobody able to create a second operator; seeding only the
 * second would leave nobody able to approve a deposit. Both, or the deployment is stuck.
 *
 * Idempotency: the AdminUser is keyed on `(tenantId, telegramUserId)` — unique per tenant now, so
 * the same human can hold a login in two operators without either one shadowing the other. The
 * limit is versioned rather than mutated — `@@unique([adminUserId, currencyCode, effectiveFrom])`
 * with `effectiveFrom` defaulting to now() means a blind upsert would append a new row on every
 * run — so an OPEN limit (effectiveTo IS NULL) is treated as "already seeded" and left exactly as
 * the operator left it.
 */
import { AdminRole, type PrismaClient } from '@prisma/client';

import { TENANT_BOOTSTRAP_ID, TENANT_ZERO_ID } from '@core/tenant/tenant.constants';

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
  /** The tenant-zero PLATFORM_ADMIN counterpart — see the header on why there are two rows. */
  platformAdminUserId?: string;
  platformAdminCreated?: boolean;
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

  // The operator's owner. See the header: this row approves money, so it lives where the deposits
  // and its own approval limit do.
  const identity = { tenantId: TENANT_BOOTSTRAP_ID, telegramUserId };

  const existing = await prisma.adminUser.findUnique({
    where: { tenantId_telegramUserId: identity },
    select: { id: true },
  });

  const admin = await prisma.adminUser.upsert({
    where: { tenantId_telegramUserId: identity },
    create: {
      tenantId: TENANT_BOOTSTRAP_ID,
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
    where: {
      tenantId: TENANT_BOOTSTRAP_ID,
      adminUserId: admin.id,
      currencyCode,
      effectiveTo: null,
    },
    select: { id: true },
  });

  let limitCreated = false;
  if (openLimit === null) {
    await prisma.adminApprovalLimit.create({
      data: {
        // The admin's own tenant, never an ambient one: a limit filed against a different operator
        // than the admin it belongs to would silently authorise nothing, and fail-closed means the
        // owner would simply be unable to approve with no error saying why.
        tenantId: TENANT_BOOTSTRAP_ID,
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

  // ---- the platform counterpart -------------------------------------------------------------
  // A separate row, in tenant zero, for the same human. Without it nobody can reach
  // /v1/admin/tenants and the deployment can never create its second operator.
  //
  // No approval limit is written for it, and that is deliberate rather than an omission: the
  // platform does not approve an operator's deposits, and evaluate() failing closed is the
  // correct answer if it ever tries.
  const platformIdentity = { tenantId: TENANT_ZERO_ID, telegramUserId };

  const existingPlatform = await prisma.adminUser.findUnique({
    where: { tenantId_telegramUserId: platformIdentity },
    select: { id: true },
  });

  const platformAdmin = await prisma.adminUser.upsert({
    where: { tenantId_telegramUserId: platformIdentity },
    create: {
      tenantId: TENANT_ZERO_ID,
      telegramUserId,
      // `username` is @@unique per tenant, and the operator row above already holds it. Leaving
      // this null keeps the two rows distinguishable by tenant alone, which is what they are.
      username: null,
      displayName: `${displayName} (platform)`,
      role: AdminRole.PLATFORM_ADMIN,
      isActive: true,
    },
    update: {
      // Same re-arming escape hatch as the operator row above.
      role: AdminRole.PLATFORM_ADMIN,
      isActive: true,
    },
    select: { id: true },
  });

  return {
    skipped: false,
    adminUserId: admin.id,
    telegramUserId,
    created: existing === null,
    limitCreated,
    platformAdminUserId: platformAdmin.id,
    platformAdminCreated: existingPlatform === null,
  };
}
