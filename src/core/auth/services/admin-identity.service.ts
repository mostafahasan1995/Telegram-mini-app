/**
 * WHY resolve the admin on EVERY request instead of trusting the token's role claim: a role is a
 * snapshot at issue time. Demote a FINANCE_ADMIN to VIEWER, or deactivate someone who just left,
 * and a token issued a minute earlier would keep approving deposits for its whole lifetime. Here
 * the ceiling on stale authority is the cache TTL — 60 seconds — not the token TTL.
 *
 * WHY the cache exists at all, and why it caches MISSES too: this same lookup runs for every
 * Telegram update the bot receives, and the overwhelming majority of those are from people who are
 * not admins. Without negative caching, "is this random user staff?" is an uncached database query
 * per inbound message — a free amplification channel for anyone who can message the bot.
 *
 * `telegramUserId` is serialized as a STRING in the cached record: the value round-trips through
 * JSON, and a 64-bit Telegram id does not survive that as a number.
 */
import { Injectable } from '@nestjs/common';
import { type AdminRole } from '@prisma/client';
import { ForbiddenError } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';
import { type AuthenticatedAdmin } from '@common/decorators/auth.types';
import { CacheService } from '../../cache/cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ADMIN_IDENTITY_TTL_SECONDS, adminIdentityKey } from '../auth.constants';

/** JSON-safe mirror of AuthenticatedAdmin. Never widen this without checking the bigint handling. */
interface CachedAdmin {
  adminUserId: string;
  telegramUserId: string;
  role: AdminRole;
  displayName: string;
}

@Injectable()
export class AdminIdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Returns the active admin behind a Telegram id, or null.
   * An INACTIVE admin resolves to null on purpose: `isActive: false` is how staff are offboarded,
   * and it must read exactly like "not an admin" everywhere, with no second check to forget.
   */
  async resolve(telegramUserId: bigint): Promise<AuthenticatedAdmin | null> {
    const cached = await this.cache.getOrSet<CachedAdmin | null>(
      adminIdentityKey(telegramUserId),
      ADMIN_IDENTITY_TTL_SECONDS,
      async () => {
        const admin = await this.prisma.adminUser.findUnique({
          where: { telegramUserId },
          select: { id: true, telegramUserId: true, role: true, displayName: true, isActive: true },
        });

        if (!admin || !admin.isActive) return null;

        return {
          adminUserId: admin.id,
          telegramUserId: admin.telegramUserId.toString(),
          role: admin.role,
          displayName: admin.displayName,
        };
      },
      { cacheNull: true },
    );

    if (!cached) return null;

    return {
      adminUserId: cached.adminUserId,
      telegramUserId: BigInt(cached.telegramUserId),
      role: cached.role,
      displayName: cached.displayName,
    };
  }

  /** Same, but raises the 403 the guards and bot handlers would otherwise all have to write. */
  async resolveOrThrow(telegramUserId: bigint): Promise<AuthenticatedAdmin> {
    const admin = await this.resolve(telegramUserId);
    if (!admin) {
      throw new ForbiddenError(
        CommonErrorCodes.ADMIN_INACTIVE,
        'This account does not have administrator access.',
      );
    }
    return admin;
  }

  async isAdmin(telegramUserId: bigint): Promise<boolean> {
    return (await this.resolve(telegramUserId)) !== null;
  }

  /**
   * Drop the cached entry. MUST be called by whatever changes an AdminUser's role or isActive flag,
   * otherwise a revoked admin keeps their powers for up to a minute.
   */
  async invalidate(telegramUserId: bigint): Promise<void> {
    await this.cache.del(adminIdentityKey(telegramUserId));
  }
}
