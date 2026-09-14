/**
 * WHY resolve the admin on EVERY request instead of trusting the token's role claim: a role is a
 * snapshot at issue time. Demote a FINANCE_ADMIN to VIEWER, or deactivate someone who just left,
 * and a token issued a minute earlier would keep approving deposits for its whole lifetime. Here
 * the ceiling on stale authority is the cache TTL — 60 seconds — not the token TTL.
 *
 * TWO DOORS, KEPT APART ON PURPOSE:
 *
 *  - `resolveById(tenantId, adminUserId)` is the HTTP door. An access token names its admin as
 *    (tid, sub = AdminUser.id). A console admin may have no Telegram account at all, so a Telegram
 *    id cannot be what identifies an HTTP caller — and letting it would mean a bot-side identifier
 *    decides console authority.
 *  - `resolveByTelegram(tenantId, telegramUserId)` is the bot door. An update carries nothing but
 *    `ctx.from.id`. A console-only row (telegram_user_id NULL) can never be found through it: the
 *    compound unique input is typed non-null, and NULL = x is never true in Postgres.
 *
 * WHY the cache exists at all, and why it caches MISSES too: the Telegram lookup runs for every
 * update the bot receives, and the overwhelming majority of those are from people who are not
 * admins. Without negative caching, "is this random user staff?" is an uncached database query per
 * inbound message — a free amplification channel for anyone who can message the bot.
 *
 * `telegramUserId` is serialized as a STRING (or null) in the cached record: the value round-trips
 * through JSON, and a 64-bit Telegram id does not survive that as a number.
 */
import { Injectable } from '@nestjs/common';
import { type AdminRole } from '@prisma/client';
import { ForbiddenError } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';
import {
  type AuthenticatedAdmin,
  type TelegramAuthenticatedAdmin,
} from '@common/decorators/auth.types';
import { CacheService } from '../../cache/cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ADMIN_IDENTITY_TTL_SECONDS,
  adminIdentityByIdKey,
  adminIdentityByTelegramKey,
} from '../auth.constants';

/** JSON-safe mirror of AuthenticatedAdmin. Never widen this without checking the bigint handling. */
interface CachedAdmin {
  adminUserId: string;
  telegramUserId: string | null;
  tenantId: string;
  role: AdminRole;
  displayName: string;
}

const IDENTITY_SELECT = {
  id: true,
  telegramUserId: true,
  tenantId: true,
  role: true,
  displayName: true,
  isActive: true,
} as const;

interface IdentityRow {
  id: string;
  telegramUserId: bigint | null;
  tenantId: string;
  role: AdminRole;
  displayName: string;
  isActive: boolean;
}

/**
 * `admin_users.id` is a UUID column. A string that is not one would make Postgres reject the query
 * (22P02) and surface as a 500; it cannot name an admin, so it is simply a miss.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Which cache entries an invalidation must drop. Pass the Telegram id when the row has one. */
export interface AdminIdentityRef {
  tenantId: string;
  adminUserId: string;
  telegramUserId: bigint | null;
}

function toCached(row: IdentityRow | null): CachedAdmin | null {
  // An INACTIVE admin resolves to null on purpose: `isActive: false` is how staff are offboarded,
  // and it must read exactly like "not an admin" everywhere, with no second check to forget.
  if (row === null || !row.isActive) return null;
  return {
    adminUserId: row.id,
    telegramUserId: row.telegramUserId === null ? null : row.telegramUserId.toString(),
    tenantId: row.tenantId,
    role: row.role,
    displayName: row.displayName,
  };
}

function fromCached(cached: CachedAdmin): AuthenticatedAdmin {
  return {
    adminUserId: cached.adminUserId,
    telegramUserId: cached.telegramUserId === null ? null : BigInt(cached.telegramUserId),
    tenantId: cached.tenantId,
    role: cached.role,
    displayName: cached.displayName,
  };
}

@Injectable()
export class AdminIdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /**
   * The HTTP door: the active admin with this id IN THIS TENANT, or null.
   *
   * `tenantId` is the caller's HOME tenant and comes from the signed `tid` claim — never from a
   * header. The row must actually live there: a token whose `sub` belongs to another operator
   * resolves to nothing, so authority is always measured where the row is.
   */
  async resolveById(tenantId: string, adminUserId: string): Promise<AuthenticatedAdmin | null> {
    if (!UUID_PATTERN.test(adminUserId)) return null;

    const cached = await this.cache.getOrSet<CachedAdmin | null>(
      adminIdentityByIdKey(tenantId, adminUserId),
      ADMIN_IDENTITY_TTL_SECONDS,
      async () => {
        // findUnique by primary key is not rewritten by the tenant-scope extension, so the tenant
        // is compared here explicitly rather than trusted to an ambient filter.
        const row = await this.prisma.adminUser.findUnique({
          where: { id: adminUserId },
          select: IDENTITY_SELECT,
        });
        return toCached(row !== null && row.tenantId === tenantId ? row : null);
      },
      { cacheNull: true },
    );

    return cached === null ? null : fromCached(cached);
  }

  /** Same, but raises the 403 the guard would otherwise have to write. */
  async resolveByIdOrThrow(tenantId: string, adminUserId: string): Promise<AuthenticatedAdmin> {
    const admin = await this.resolveById(tenantId, adminUserId);
    if (!admin) throw inactive();
    return admin;
  }

  /**
   * The bot door: the active admin behind a Telegram id IN A GIVEN TENANT, or null. Never use this
   * to authenticate an HTTP request — see the header.
   */
  async resolveByTelegram(
    tenantId: string,
    telegramUserId: bigint,
  ): Promise<TelegramAuthenticatedAdmin | null> {
    const cached = await this.cache.getOrSet<CachedAdmin | null>(
      adminIdentityByTelegramKey(tenantId, telegramUserId),
      ADMIN_IDENTITY_TTL_SECONDS,
      async () => {
        const row = await this.prisma.adminUser.findUnique({
          where: { tenantId_telegramUserId: { tenantId, telegramUserId } },
          select: IDENTITY_SELECT,
        });
        return toCached(row);
      },
      { cacheNull: true },
    );

    if (cached === null) return null;
    // The row was matched ON this Telegram id, so it is the id — no need to trust the cached copy.
    return { ...fromCached(cached), telegramUserId };
  }

  /** Same, but raises the 403 the bot handlers would otherwise all have to write. */
  async resolveByTelegramOrThrow(
    tenantId: string,
    telegramUserId: bigint,
  ): Promise<TelegramAuthenticatedAdmin> {
    const admin = await this.resolveByTelegram(tenantId, telegramUserId);
    if (!admin) throw inactive();
    return admin;
  }

  async isAdminByTelegram(tenantId: string, telegramUserId: bigint): Promise<boolean> {
    return (await this.resolveByTelegram(tenantId, telegramUserId)) !== null;
  }

  /**
   * Drop the cached entries. MUST be called by whatever changes an AdminUser's role, isActive flag
   * or Telegram id, otherwise a revoked admin keeps their powers for up to a minute.
   *
   * Both doors are evicted: forgetting the id key leaves the console trusting the old role, and
   * forgetting the Telegram key leaves the bot doing so. When a Telegram id CHANGES, call this with
   * the old id as well as the new one.
   */
  async invalidate(ref: AdminIdentityRef): Promise<void> {
    const keys = [adminIdentityByIdKey(ref.tenantId, ref.adminUserId)];
    if (ref.telegramUserId !== null) {
      keys.push(adminIdentityByTelegramKey(ref.tenantId, ref.telegramUserId));
    }
    await this.cache.del(...keys);
  }
}

function inactive(): ForbiddenError {
  return new ForbiddenError(
    CommonErrorCodes.ADMIN_INACTIVE,
    'This account does not have administrator access.',
  );
}
