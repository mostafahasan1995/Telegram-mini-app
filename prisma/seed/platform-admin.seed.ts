/**
 * The first-run bootstrap: ONE platform admin in tenant zero, signed into with a username and a
 * password. Everything after it (operators, their bot tokens, their staff) is done from the
 * dashboard, so this is the only account a deployment ever creates from the command line.
 *
 *   SEED_PLATFORM_ADMIN_USERNAME        required. Trimmed, lower-cased, 3–64 of [A-Za-z0-9._@+-]
 *   SEED_PLATFORM_ADMIN_PASSWORD        required. 8–72 characters, never trimmed, never printed
 *   SEED_ADMIN_DISPLAY_NAME             optional. "Owner" when the row is created
 *   SEED_ADMIN_TELEGRAM_ID              optional. Digits only; lets this admin also work the bot
 *   SEED_PLATFORM_ADMIN_RESET_PASSWORD  optional. `1` replaces an existing password
 *
 * It reads no TELEGRAM_* variable and no JWT_SECRET: it seals nothing and talks to nobody but the
 * database. That is what lets it run in the tools image before any operator exists.
 *
 * WHY TENANT ZERO: `prisma/sql/006_tenant_isolation.sql` refuses a PLATFORM_ADMIN anywhere else,
 * and the X-Tenant-Id override honours only a PLATFORM_ADMIN whose home is tenant zero. No
 * approval limit is written: platform staff are exempt from approval limits (RolesGuard and the
 * approval-limit evaluator both say so), so a limit row would be a number nobody reads.
 *
 * IDEMPOTENCY, decided by `planPlatformAdmin` so every rule is unit-tested without a database:
 *   - keyed on (tenant zero, username);
 *   - a re-run re-arms the row (isActive back to true): the deliberate way back in for an owner who
 *     was deactivated;
 *   - THE PASSWORD IS NOT TOUCHED ON A RE-RUN unless SEED_PLATFORM_ADMIN_RESET_PASSWORD=1 (or the
 *     row has no password at all, so there is nothing to preserve). The password variable is
 *     required on every run, so its mere presence cannot mean "change it"; the admin may have
 *     changed it in the console since, and a redeploy must not silently revert that;
 *   - SEED_ADMIN_DISPLAY_NAME and SEED_ADMIN_TELEGRAM_ID are optional, so when one IS set it is the
 *     operator asking for that value, and it is applied;
 *   - a username held in tenant zero by any OTHER role is refused, never promoted: turning a
 *     support login into the platform owner is not a decision a script should make by name alone;
 *   - a Telegram-id-only PLATFORM_ADMIN (username NULL, written by the seed before console sign-in
 *     existed) is ADOPTED when SEED_ADMIN_TELEGRAM_ID names it, rather than colliding with it on
 *     the (tenant_id, telegram_user_id) unique index.
 *
 * NO CACHE INVALIDATION: the script has no Redis. A running api caches admin identities for up to 60
 * seconds, so an owner re-armed here can sign in at once (sign-in reads the database) but may be
 * answered ADMIN_INACTIVE on guarded routes until that entry expires.
 *
 * AUDIT: created and updated are recorded in tenant zero's log in the same transaction as the
 * write, under the same action names the staff directory uses (`admin.user.created` /
 * `admin.user.updated`), with a SYSTEM actor because no signed-in person did it. "unchanged" writes
 * nothing. No snapshot ever carries the password or the hash, only whether one is set.
 */
import { ActorType, AdminRole, type Prisma, type PrismaClient } from '@prisma/client';
import { uuidv7 } from 'uuidv7';

// Leaf files, not barrels: '@core/tenant' and '@core/auth' also export Nest modules, which would
// load a slice of the DI graph into a script that only wants a uuid, a length rule and a hasher.
import { AUDIT_CONTEXT_KEY } from '@core/audit/audit.types';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordLengthIsAcceptable,
} from '@core/auth/services/password-hasher.service';
import { isUniqueConstraintError, mapPrismaError } from '@core/prisma/prisma-errors';
import { TENANT_ZERO_ID } from '@core/tenant/tenant.constants';
import {
  ADMIN_USERNAME_MAX_LENGTH,
  ADMIN_USERNAME_MIN_LENGTH,
  isValidAdminUsername,
  normalizeAdminUsername,
} from '@modules/admin/admin-username';

export const PLATFORM_ADMIN_ENV = {
  username: 'SEED_PLATFORM_ADMIN_USERNAME',
  password: 'SEED_PLATFORM_ADMIN_PASSWORD',
  displayName: 'SEED_ADMIN_DISPLAY_NAME',
  telegramUserId: 'SEED_ADMIN_TELEGRAM_ID',
  resetPassword: 'SEED_PLATFORM_ADMIN_RESET_PASSWORD',
} as const;

export const DEFAULT_PLATFORM_ADMIN_DISPLAY_NAME = 'Owner';
/** Same ceiling as the staff directory's displayName. */
const DISPLAY_NAME_MAX_LENGTH = 120;
/** 1–19 digits: the widest a signed 64-bit id can be, with no sign and no separators. */
const TELEGRAM_ID_PATTERN = /^\d{1,19}$/;
const INT64_MAX = 9_223_372_036_854_775_807n;

/** Recorded in every audit row this seed writes, so the log says where the change came from. */
export const PLATFORM_ADMIN_SEED_SOURCE = 'seed:platform-admin';

/**
 * Bad input or a refused situation: the operator can fix it by changing what they passed. The
 * message is safe to print — it never contains the password.
 */
export class PlatformAdminSeedError extends Error {
  override readonly name = 'PlatformAdminSeedError';
}

export interface PlatformAdminInput {
  /** Normalised (trimmed, lower-cased) and validated. */
  username: string;
  /** Exactly as given. */
  password: string;
  /** null when SEED_ADMIN_DISPLAY_NAME was not set (or blank). */
  displayName: string | null;
  /** null when SEED_ADMIN_TELEGRAM_ID was not set (or blank). */
  telegramUserId: bigint | null;
  resetPassword: boolean;
}

/**
 * Reads and validates the environment. Every problem is reported at once, so an operator fixes
 * their command in one go rather than one variable per attempt.
 */
export function readPlatformAdminInput(env: NodeJS.ProcessEnv): PlatformAdminInput {
  const problems: string[] = [];

  const rawUsername = env[PLATFORM_ADMIN_ENV.username];
  const username = rawUsername === undefined ? '' : normalizeAdminUsername(rawUsername);
  if (username.length === 0) {
    problems.push(`${PLATFORM_ADMIN_ENV.username} is required.`);
  } else if (!isValidAdminUsername(username)) {
    problems.push(
      `${PLATFORM_ADMIN_ENV.username} must be ${ADMIN_USERNAME_MIN_LENGTH} to ` +
        `${ADMIN_USERNAME_MAX_LENGTH} characters: letters, digits, and . _ @ + - only.`,
    );
  }

  // Never trimmed: a space is a legitimate password character. Never echoed in a message.
  const password = env[PLATFORM_ADMIN_ENV.password] ?? '';
  if (password.length === 0) {
    problems.push(`${PLATFORM_ADMIN_ENV.password} is required.`);
  } else if (!passwordLengthIsAcceptable(password)) {
    problems.push(
      `${PLATFORM_ADMIN_ENV.password} must be ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`,
    );
  }

  const rawDisplayName = env[PLATFORM_ADMIN_ENV.displayName]?.trim() ?? '';
  let displayName: string | null = null;
  if (rawDisplayName.length > 0) {
    if (Array.from(rawDisplayName).length > DISPLAY_NAME_MAX_LENGTH) {
      problems.push(
        `${PLATFORM_ADMIN_ENV.displayName} must be at most ${DISPLAY_NAME_MAX_LENGTH} characters.`,
      );
    } else {
      displayName = rawDisplayName;
    }
  }

  const rawTelegramId = env[PLATFORM_ADMIN_ENV.telegramUserId]?.trim() ?? '';
  let telegramUserId: bigint | null = null;
  if (rawTelegramId.length > 0) {
    const parsed = TELEGRAM_ID_PATTERN.test(rawTelegramId) ? BigInt(rawTelegramId) : null;
    // 0 is refused as well: Telegram never issues it, and elsewhere it reads as "not configured".
    if (parsed === null || parsed === 0n || parsed > INT64_MAX) {
      problems.push(
        `${PLATFORM_ADMIN_ENV.telegramUserId} must be a positive Telegram user id, digits only.`,
      );
    } else {
      telegramUserId = parsed;
    }
  }

  const rawReset = env[PLATFORM_ADMIN_ENV.resetPassword]?.trim().toLowerCase() ?? '';
  let resetPassword = false;
  if (rawReset === '1' || rawReset === 'true') {
    resetPassword = true;
  } else if (rawReset !== '' && rawReset !== '0' && rawReset !== 'false') {
    // A typo here must not quietly mean "keep the old password" when the operator meant to reset.
    problems.push(`${PLATFORM_ADMIN_ENV.resetPassword} must be 1 or 0.`);
  }

  if (problems.length > 0) {
    throw new PlatformAdminSeedError(problems.join(' '));
  }

  return { username, password, displayName, telegramUserId, resetPassword };
}

/** The columns the plan reads. The hash is only ever tested for presence. */
export interface ExistingAdminRow {
  id: string;
  username: string | null;
  role: AdminRole;
  isActive: boolean;
  displayName: string;
  telegramUserId: bigint | null;
  passwordHash: string | null;
}

export type PlatformAdminOutcome = 'created' | 'updated' | 'unchanged';

export interface PlatformAdminChanges {
  /** Set only when adopting a Telegram-id-only row that has no username yet. */
  username?: string;
  isActive?: true;
  displayName?: string;
  telegramUserId?: bigint;
}

export type PlatformAdminPlan =
  | { outcome: 'created'; displayName: string; telegramUserId: bigint | null }
  | {
      outcome: 'updated';
      existing: ExistingAdminRow;
      changes: PlatformAdminChanges;
      /** Whether a new hash is written. */
      setPassword: boolean;
    }
  | { outcome: 'unchanged'; existing: ExistingAdminRow };

/** The two rows in tenant zero the input can refer to. */
export interface PlatformAdminLookup {
  byUsername: ExistingAdminRow | null;
  /** Always null when no Telegram id was given. */
  byTelegramUserId: ExistingAdminRow | null;
}

/**
 * Decides what one run does. Pure: no clock, no database, no hashing. Throws
 * PlatformAdminSeedError for every situation it refuses.
 */
export function planPlatformAdmin(
  input: PlatformAdminInput,
  lookup: PlatformAdminLookup,
): PlatformAdminPlan {
  const { byUsername, byTelegramUserId } = lookup;

  if (byUsername !== null) {
    if (byUsername.role !== AdminRole.PLATFORM_ADMIN) {
      throw new PlatformAdminSeedError(
        `Username "${input.username}" already belongs to a ${byUsername.role} in tenant zero. ` +
          'Refusing to turn it into the platform admin; choose another username.',
      );
    }
    if (byTelegramUserId !== null && byTelegramUserId.id !== byUsername.id) {
      throw new PlatformAdminSeedError(
        `${PLATFORM_ADMIN_ENV.telegramUserId} already belongs to another admin in tenant zero.`,
      );
    }
    return planUpdate(input, byUsername, {});
  }

  if (byTelegramUserId !== null) {
    const adoptable =
      byTelegramUserId.username === null && byTelegramUserId.role === AdminRole.PLATFORM_ADMIN;
    if (!adoptable) {
      throw new PlatformAdminSeedError(
        `${PLATFORM_ADMIN_ENV.telegramUserId} already belongs to another admin in tenant zero.`,
      );
    }
    // A platform admin from the Telegram-id-only seed: give it this login instead of creating a
    // second row for the same person, which the unique index would refuse anyway.
    return planUpdate(input, byTelegramUserId, { username: input.username });
  }

  return {
    outcome: 'created',
    displayName: input.displayName ?? DEFAULT_PLATFORM_ADMIN_DISPLAY_NAME,
    telegramUserId: input.telegramUserId,
  };
}

function planUpdate(
  input: PlatformAdminInput,
  existing: ExistingAdminRow,
  base: PlatformAdminChanges,
): PlatformAdminPlan {
  const changes: PlatformAdminChanges = { ...base };
  if (!existing.isActive) changes.isActive = true;
  if (input.displayName !== null && input.displayName !== existing.displayName) {
    changes.displayName = input.displayName;
  }
  if (input.telegramUserId !== null && input.telegramUserId !== existing.telegramUserId) {
    changes.telegramUserId = input.telegramUserId;
  }
  // See the header: presence of the (required) password variable is not a request to change it.
  const setPassword = input.resetPassword || existing.passwordHash === null;

  if (Object.keys(changes).length === 0 && !setPassword) {
    return { outcome: 'unchanged', existing };
  }
  return { outcome: 'updated', existing, changes, setPassword };
}

/** Anything with a `hash`. The script passes the app's PasswordHasherService at its real cost. */
export interface PasswordHashing {
  hash(password: string): Promise<string>;
}

export interface SeededPlatformAdmin {
  adminUserId: string;
  username: string;
  outcome: PlatformAdminOutcome;
}

const ADMIN_COLUMNS = {
  id: true,
  username: true,
  role: true,
  isActive: true,
  displayName: true,
  telegramUserId: true,
  passwordHash: true,
} as const satisfies Prisma.AdminUserSelect;

type AuditSnapshot = Record<string, string | boolean | null>;

function snapshot(row: Omit<ExistingAdminRow, 'id'>): AuditSnapshot {
  return {
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    isActive: row.isActive,
    telegramUserId: row.telegramUserId === null ? null : row.telegramUserId.toString(),
    // Whether a password is set — never the hash, not even its format.
    hasPassword: row.passwordHash !== null,
  };
}

/** Generous: a slow VPS spends a noticeable fraction of a second in one scrypt derivation. */
const TRANSACTION_TIMEOUT_MS = 30_000;

export async function seedPlatformAdmin(
  prisma: PrismaClient,
  input: PlatformAdminInput,
  hasher: PasswordHashing,
): Promise<SeededPlatformAdmin> {
  const tenantZero = await prisma.tenant.findUnique({
    where: { id: TENANT_ZERO_ID },
    select: { id: true },
  });
  if (tenantZero === null) {
    throw new PlatformAdminSeedError(
      'Tenant zero does not exist. Run the migrations (npm run prisma:deploy) before seeding.',
    );
  }

  try {
    return await prisma.$transaction(
      async (tx) => {
        // Read and decided INSIDE the transaction, so the plan is made against the rows it writes.
        const [byUsername, byTelegramUserId] = await Promise.all([
          tx.adminUser.findUnique({
            where: { tenantId_username: { tenantId: TENANT_ZERO_ID, username: input.username } },
            select: ADMIN_COLUMNS,
          }),
          input.telegramUserId === null
            ? Promise.resolve(null)
            : tx.adminUser.findUnique({
                where: {
                  tenantId_telegramUserId: {
                    tenantId: TENANT_ZERO_ID,
                    telegramUserId: input.telegramUserId,
                  },
                },
                select: ADMIN_COLUMNS,
              }),
        ]);

        const plan = planPlatformAdmin(input, { byUsername, byTelegramUserId });

        if (plan.outcome === 'unchanged') {
          return { adminUserId: plan.existing.id, username: input.username, outcome: plan.outcome };
        }

        if (plan.outcome === 'created') {
          const created = await tx.adminUser.create({
            data: {
              tenantId: TENANT_ZERO_ID,
              username: input.username,
              displayName: plan.displayName,
              telegramUserId: plan.telegramUserId,
              role: AdminRole.PLATFORM_ADMIN,
              isActive: true,
              passwordHash: await hasher.hash(input.password),
            },
            select: ADMIN_COLUMNS,
          });
          await writeAudit(tx, 'admin.user.created', created.id, null, created, true);
          return { adminUserId: created.id, username: input.username, outcome: plan.outcome };
        }

        const updated = await tx.adminUser.update({
          where: { id: plan.existing.id },
          data: {
            ...plan.changes,
            // Re-asserted, not changed: the plan already refused every other role.
            role: AdminRole.PLATFORM_ADMIN,
            ...(plan.setPassword ? { passwordHash: await hasher.hash(input.password) } : {}),
          },
          select: ADMIN_COLUMNS,
        });
        await writeAudit(
          tx,
          'admin.user.updated',
          updated.id,
          plan.existing,
          updated,
          plan.setPassword,
        );
        return { adminUserId: updated.id, username: input.username, outcome: plan.outcome };
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  } catch (error: unknown) {
    // Two runs at once can both decide "created"; the second loses on the unique index.
    if (isUniqueConstraintError(mapPrismaError(error))) {
      throw new PlatformAdminSeedError(
        'Another admin row with this username or Telegram id was written while this ran. ' +
          'Run the command again.',
      );
    }
    throw error;
  }
}

/**
 * Written directly rather than through AuditService: that service reads the tenant from the
 * ambient request context and lives behind the '@core/tenant' barrel, and this script has neither.
 * The row has the same shape it would produce — uuidv7 id, effective tenant, `$meta` for context.
 */
async function writeAudit(
  tx: Prisma.TransactionClient,
  action: 'admin.user.created' | 'admin.user.updated',
  adminUserId: string,
  before: ExistingAdminRow | null,
  after: ExistingAdminRow,
  passwordSet: boolean,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      id: uuidv7(),
      tenantId: TENANT_ZERO_ID,
      actorType: ActorType.SYSTEM,
      actorId: null,
      action,
      entityType: 'AdminUser',
      entityId: adminUserId,
      ...(before === null ? {} : { before: snapshot(before) }),
      after: {
        ...snapshot(after),
        [AUDIT_CONTEXT_KEY]: { source: PLATFORM_ADMIN_SEED_SOURCE, passwordSet },
      },
    },
    select: { id: true },
  });
}

/**
 * The one line printed when something unexpected fails. A driver or validation error can quote the
 * values it was handed, so the password and anything shaped like a stored hash are cut out before
 * the message reaches a terminal or a CI log.
 */
export function describeSeedFailure(error: unknown, secrets: readonly string[]): string {
  const raw =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : `non-error thrown: ${String(error)}`;
  let message = raw.replace(/\$scrypt\$[^\s"'`]*/g, '[redacted hash]');
  for (const secret of secrets) {
    if (secret.length > 0) message = message.split(secret).join('[redacted]');
  }
  return message;
}
