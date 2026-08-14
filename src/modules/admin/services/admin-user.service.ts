/**
 * Staff directory CRUD.
 *
 * Two guards here are not bureaucracy, they are the difference between a bad afternoon and a locked
 * system:
 *
 *  1. NOBODY MAY DEACTIVATE OR DEMOTE THEMSELVES. Not because it is dangerous in itself, but
 *     because it is the fastest way to remove the only person who could undo it.
 *  2. THE LAST ACTIVE SUPER_ADMIN CANNOT BE REMOVED. Checked inside the write transaction, because
 *     two concurrent deactivations would each see "there is still one other" and both succeed —
 *     leaving a system with no administrator and no way in.
 *
 * WHY every mutation invalidates the identity cache: AdminIdentityService caches by Telegram id for
 * 60 seconds, including negative results. Without an explicit invalidation, a revoked admin keeps
 * their powers for up to a minute after being switched off — which is exactly the minute that
 * matters when someone is being offboarded in a hurry.
 */
import { Injectable } from '@nestjs/common';
import { Prisma, type AdminUser } from '@prisma/client';

import { PrismaService } from '@core/prisma/prisma.service';
import { AuditService } from '@core/audit/audit.service';
import { AdminIdentityService } from '@core/auth/services/admin-identity.service';
import { isUniqueConstraintError } from '@core/prisma/prisma-errors';
import type { Tx } from '@core/prisma/tx.type';
import { adminActor } from '@common/types/actor.type';
import { BusinessRuleError, ConflictError, NotFoundError } from '@common/exceptions/app.exception';
import { paginate, type PaginatedResult } from '@common/dtos/paginated.dto';

import { AdminErrorCodes } from '../admin.constants';
import { AdminUserRepository } from '../repositories/admin-user.repository';
import type {
  AdminUserView,
  CreateAdminUserDto,
  ListAdminUsersQueryDto,
  UpdateAdminUserDto,
} from '../dtos/admin-user.dto';

export function toAdminUserView(admin: AdminUser): AdminUserView {
  return {
    id: admin.id,
    telegramUserId: admin.telegramUserId.toString(),
    username: admin.username,
    displayName: admin.displayName,
    role: admin.role,
    isActive: admin.isActive,
    lastLoginAt: admin.lastLoginAt?.toISOString() ?? null,
    createdAt: admin.createdAt.toISOString(),
  };
}

@Injectable()
export class AdminUserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admins: AdminUserRepository,
    private readonly identities: AdminIdentityService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListAdminUsersQueryDto): Promise<PaginatedResult<AdminUserView>> {
    const where: Prisma.AdminUserWhereInput = {
      ...(query.role !== undefined ? { role: query.role } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    };

    const [rows, total] = await Promise.all([
      this.admins.list(where, query.limit, query.offset),
      this.admins.count(where),
    ]);

    return paginate(rows.map(toAdminUserView), total, query.limit, query.offset);
  }

  async get(id: string): Promise<AdminUserView> {
    return toAdminUserView(await this.getOrThrow(id));
  }

  async create(actorAdminId: string, dto: CreateAdminUserDto): Promise<AdminUserView> {
    const telegramUserId = BigInt(dto.telegramUserId);

    const created = await this.prisma
      .runInTransaction(async (tx) => {
        const admin = await this.admins.create(
          {
            telegramUserId,
            displayName: dto.displayName,
            role: dto.role,
            username: dto.username ?? null,
          },
          tx,
        );

        await this.audit.write(tx, {
          action: 'admin.user.created',
          actor: adminActor(actorAdminId),
          subjectType: 'AdminUser',
          subjectId: admin.id,
          after: {
            telegramUserId: admin.telegramUserId.toString(),
            displayName: admin.displayName,
            role: admin.role,
            isActive: admin.isActive,
          },
        });

        return admin;
      })
      .catch((error: unknown) => {
        // The unique columns are telegram_user_id and username. Either way the operator's mistake
        // is the same shape: "this person is already in the directory".
        if (isUniqueConstraintError(error)) {
          throw new ConflictError(
            AdminErrorCodes.ADMIN_ALREADY_EXISTS,
            'An administrator with that Telegram id or username already exists.',
          );
        }
        throw error;
      });

    // A newly created admin may have been cached as a NEGATIVE lookup moments ago.
    await this.identities.invalidate(telegramUserId);
    return toAdminUserView(created);
  }

  async update(actorAdminId: string, id: string, dto: UpdateAdminUserDto): Promise<AdminUserView> {
    const existing = await this.getOrThrow(id);

    const changesAuthority =
      (dto.role !== undefined && dto.role !== existing.role) ||
      (dto.isActive !== undefined && dto.isActive !== existing.isActive);

    if (changesAuthority && actorAdminId === id) {
      throw new BusinessRuleError(
        AdminErrorCodes.ADMIN_SELF_MODIFICATION,
        'You cannot change your own role or deactivate yourself. Ask another administrator.',
      );
    }

    const updated = await this.prisma
      .runInTransaction(async (tx) => {
        // Re-read inside the transaction: the guard below must see committed state, not a snapshot
        // taken before another operator's concurrent change.
        const current = await this.admins.findById(id, tx);
        if (current === null) {
          throw new NotFoundError(AdminErrorCodes.ADMIN_NOT_FOUND, 'Administrator not found.');
        }

        const losesSuperAdmin =
          current.role === 'SUPER_ADMIN' &&
          current.isActive &&
          ((dto.role !== undefined && dto.role !== 'SUPER_ADMIN') || dto.isActive === false);

        if (losesSuperAdmin) {
          await this.assertAnotherSuperAdminRemains(tx, id);
        }

        const admin = await this.admins.update(
          id,
          {
            ...(dto.displayName !== undefined ? { displayName: dto.displayName } : {}),
            ...(dto.role !== undefined ? { role: dto.role } : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
            ...(dto.username !== undefined ? { username: dto.username } : {}),
          },
          tx,
        );

        await this.audit.write(tx, {
          action: 'admin.user.updated',
          actor: adminActor(actorAdminId),
          subjectType: 'AdminUser',
          subjectId: id,
          before: {
            displayName: current.displayName,
            role: current.role,
            isActive: current.isActive,
            username: current.username,
          },
          after: {
            displayName: admin.displayName,
            role: admin.role,
            isActive: admin.isActive,
            username: admin.username,
          },
        });

        return admin;
      })
      .catch((error: unknown) => {
        if (isUniqueConstraintError(error)) {
          throw new ConflictError(
            AdminErrorCodes.ADMIN_ALREADY_EXISTS,
            'That username is already taken by another administrator.',
          );
        }
        throw error;
      });

    await this.identities.invalidate(updated.telegramUserId);
    return toAdminUserView(updated);
  }

  /**
   * Offboarding. Soft, because `admin_users` is referenced by every deposit they ever decided
   * (onDelete: Restrict) — a hard delete would either fail or orphan the audit trail.
   */
  async deactivate(actorAdminId: string, id: string): Promise<AdminUserView> {
    return this.update(actorAdminId, id, { isActive: false });
  }

  private async assertAnotherSuperAdminRemains(tx: Tx, excludingId: string): Promise<void> {
    const remaining = await this.admins.countActiveSuperAdmins(excludingId, tx);
    if (remaining === 0) {
      throw new BusinessRuleError(
        AdminErrorCodes.ADMIN_LAST_SUPER_ADMIN,
        'This is the last active super administrator. Promote another one first.',
      );
    }
  }

  private async getOrThrow(id: string, tx?: Tx): Promise<AdminUser> {
    const admin = await this.admins.findById(id, tx);
    if (admin === null) {
      throw new NotFoundError(AdminErrorCodes.ADMIN_NOT_FOUND, 'Administrator not found.');
    }
    return admin;
  }
}
