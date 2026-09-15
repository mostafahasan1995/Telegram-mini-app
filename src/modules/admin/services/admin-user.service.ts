/**
 * Staff directory CRUD (API-CONTRACT.md "Admin directory").
 *
 * A staff account is a display name, a role, a username and a password. The password is hashed with
 * PasswordHasherService before any transaction opens (a replayed transaction must not pay for a second
 * scrypt derivation), and nothing about it but `hasPassword` ever leaves this service — not in the
 * view, not in an audit row.
 *
 * Four guards here are not bureaucracy, they are the difference between a bad afternoon and a locked
 * system:
 *
 *  1. NOBODY EDITS OR DEACTIVATES THEIR OWN RECORD. The console says so in as many words ("Nobody
 *     edits or deactivates their own administrator record. Ask another super admin to do it.") and its
 *     mock refuses every self PATCH, so this does too. Demoting or deactivating yourself is the fastest
 *     way to remove the only person who could undo it, and a stolen session that could reset its own
 *     password would outlive the token it was stolen with.
 *  2. THE LAST ACTIVE SUPER_ADMIN CANNOT BE REMOVED. Checked inside the write transaction, because
 *     two concurrent deactivations would each see "there is still one other" and both succeed —
 *     leaving a system with no administrator and no way in.
 *  3. PLATFORM_ADMIN IS GRANTED ONLY FROM THE PLATFORM (admin-role-grant.ts). And a PLATFORM_ADMIN
 *     row is changed only by whoever could have granted it: a password reset or a demotion of platform
 *     staff is exactly as powerful as creating one.
 *  4. EVERY WRITE LANDS IN THE EFFECTIVE OPERATOR. A PLATFORM_ADMIN using X-Tenant-Id ("Add me as an
 *     admin here") writes that operator's staff, never a tenant-zero login.
 *  5. EVERY READ BY ID IS BOUND TO THE EFFECTIVE OPERATOR. `id` is the table's whole primary key,
 *     so a bare lookup reaches every operator. Before this was bound, one operator's SUPER_ADMIN
 *     could reset another operator's SUPER_ADMIN password and sign in as them. Another operator's
 *     row is not found, and so is a row outside the X-Tenant-Id a PLATFORM_ADMIN is working in.
 *
 * WHY every mutation invalidates the identity cache: AdminIdentityService caches each admin for 60
 * seconds, by id (the console) and by Telegram id (the bot), including negative results. Without an
 * explicit invalidation of BOTH, a revoked admin keeps their powers for up to a minute after being
 * switched off — which is exactly the minute that matters when someone is being offboarded in a
 * hurry.
 */
import { Injectable } from '@nestjs/common';
import { Prisma, type AdminRole, type AdminUser } from '@prisma/client';

import { PrismaService } from '@core/prisma/prisma.service';
import { AuditService } from '@core/audit/audit.service';
import { AdminIdentityService } from '@core/auth/services/admin-identity.service';
import { PasswordHasherService } from '@core/auth/services/password-hasher.service';
import { isUniqueConstraintError } from '@core/prisma/prisma-errors';
import type { Tx } from '@core/prisma/tx.type';
import { requireEffectiveTenantId } from '@core/tenant';
import type { AuthenticatedAdmin } from '@common/decorators/auth.types';
import { adminActor } from '@common/types/actor.type';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@common/exceptions/app.exception';
import { paginate, type PaginatedResult } from '@common/dtos/paginated.dto';

import { AdminErrorCodes } from '../admin.constants';
import { mayGrantRole } from '../admin-role-grant';
import { normalizeAdminUsername } from '../admin-username';
import { AdminUserRepository } from '../repositories/admin-user.repository';
import type {
  AdminUserView,
  CreateAdminUserDto,
  ListAdminUsersQueryDto,
  UpdateAdminUserDto,
} from '../dtos/admin-user.dto';

// Re-exported so existing importers keep one path; the rule itself lives in admin-username.ts,
// where the platform-admin seed can reach it without loading this service's dependencies.
export { normalizeAdminUsername };

export function toAdminUserView(admin: AdminUser): AdminUserView {
  return {
    id: admin.id,
    telegramUserId: admin.telegramUserId === null ? null : admin.telegramUserId.toString(),
    telegramLinked: admin.telegramUserId !== null && admin.telegramUserId > 0n,
    username: admin.username,
    // Whether a console password is set — never the hash, not even its format.
    hasPassword: admin.passwordHash !== null,
    displayName: admin.displayName,
    role: admin.role,
    isActive: admin.isActive,
    lastLoginAt: admin.lastLoginAt?.toISOString() ?? null,
    createdAt: admin.createdAt.toISOString(),
  };
}

/** Blank means unchanged (the contract's PATCH rule); anything else was validated by the DTO. */
const passwordToSet = (password: string | undefined): string | null =>
  password === undefined || password === '' ? null : password;

@Injectable()
export class AdminUserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admins: AdminUserRepository,
    private readonly identities: AdminIdentityService,
    private readonly audit: AuditService,
    private readonly hasher: PasswordHasherService,
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
    return toAdminUserView(await this.getOrThrow(requireEffectiveTenantId(), id));
  }

  async create(actor: AuthenticatedAdmin, dto: CreateAdminUserDto): Promise<AdminUserView> {
    // EFFECTIVE, not home: a PLATFORM_ADMIN adding staff while working inside operator X is adding
    // X's staff, not another platform login. Getting this backwards would quietly mint tenant-zero
    // logins — accounts with platform reach — from an ordinary operator screen.
    const tenantId = requireEffectiveTenantId();
    this.assertMayGrant(actor, dto.role, tenantId);

    const passwordHash = await this.hasher.hash(dto.password);
    const username = normalizeAdminUsername(dto.username);

    const created = await this.prisma
      .runInTransaction(async (tx) => {
        const admin = await this.admins.create(
          {
            tenant: { connect: { id: tenantId } },
            // Always null: a staff account is not a Telegram account (contract, 2026-09-05).
            telegramUserId: null,
            displayName: dto.displayName,
            role: dto.role,
            username,
            passwordHash,
          },
          tx,
        );

        await this.audit.write(tx, {
          action: 'admin.user.created',
          actor: adminActor(actor.adminUserId),
          subjectType: 'AdminUser',
          subjectId: admin.id,
          after: {
            username: admin.username,
            displayName: admin.displayName,
            role: admin.role,
            isActive: admin.isActive,
            hasPassword: admin.passwordHash !== null,
          },
        });

        return admin;
      })
      .catch((error: unknown) => {
        // The unique keys are (tenant_id, username) and (tenant_id, telegram_user_id), both
        // per-operator; only the username can collide for a row written with a null Telegram id.
        if (isUniqueConstraintError(error)) {
          throw new ConflictError(
            AdminErrorCodes.ADMIN_ALREADY_EXISTS,
            'That username is already taken by another administrator in this operator.',
          );
        }
        throw error;
      });

    // The tenant comes off the row that was just written — the one AdminIdentityService resolves
    // them in.
    await this.identities.invalidate({
      tenantId: created.tenantId,
      adminUserId: created.id,
      telegramUserId: created.telegramUserId,
    });
    return toAdminUserView(created);
  }

  async update(
    actor: AuthenticatedAdmin,
    id: string,
    dto: UpdateAdminUserDto,
  ): Promise<AdminUserView> {
    // Guard 1, before anything is read: the answer does not depend on the row.
    if (actor.adminUserId === id) {
      throw new BusinessRuleError(
        AdminErrorCodes.ADMIN_SELF_MODIFICATION,
        'You cannot change your own administrator record. Ask another administrator.',
      );
    }

    // Guard 5: every read and write below is bound to this operator. Another operator's admin
    // answers ADMIN_NOT_FOUND, the same as a missing one, so an id reveals nothing either.
    const tenantId = requireEffectiveTenantId();
    const existing = await this.getOrThrow(tenantId, id);

    // Guard 3. Changing platform staff in any way needs the authority that could have granted it.
    if (existing.role === 'PLATFORM_ADMIN') this.assertMayGrant(actor, 'PLATFORM_ADMIN', tenantId);
    if (dto.role !== undefined && dto.role !== existing.role) {
      this.assertMayGrant(actor, dto.role, tenantId);
    }

    const newPassword = passwordToSet(dto.password);
    const passwordHash = newPassword === null ? null : await this.hasher.hash(newPassword);

    const updated = await this.prisma
      .runInTransaction(async (tx) => {
        // Re-read inside the transaction: the guard below must see committed state, not a snapshot
        // taken before another operator's concurrent change.
        const current = await this.getOrThrow(tenantId, id, tx);

        const losesSuperAdmin =
          current.role === 'SUPER_ADMIN' &&
          current.isActive &&
          ((dto.role !== undefined && dto.role !== 'SUPER_ADMIN') || dto.isActive === false);

        if (losesSuperAdmin) {
          await this.assertAnotherSuperAdminRemains(tx, tenantId, id);
        }

        const admin = await this.admins.updateInTenant(
          tenantId,
          id,
          {
            ...(dto.displayName !== undefined ? { displayName: dto.displayName } : {}),
            ...(dto.role !== undefined ? { role: dto.role } : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
            ...(dto.username !== undefined
              ? { username: normalizeAdminUsername(dto.username) }
              : {}),
            ...(passwordHash !== null ? { passwordHash } : {}),
          },
          tx,
        );

        await this.audit.write(tx, {
          action: 'admin.user.updated',
          actor: adminActor(actor.adminUserId),
          subjectType: 'AdminUser',
          subjectId: id,
          before: {
            displayName: current.displayName,
            role: current.role,
            isActive: current.isActive,
            username: current.username,
            hasPassword: current.passwordHash !== null,
          },
          after: {
            displayName: admin.displayName,
            role: admin.role,
            isActive: admin.isActive,
            username: admin.username,
            hasPassword: admin.passwordHash !== null,
            // That it changed, never what to: the hash is not evidence anyone needs to read.
            passwordChanged: passwordHash !== null,
          },
        });

        return admin;
      })
      .catch((error: unknown) => {
        if (isUniqueConstraintError(error)) {
          throw new ConflictError(
            AdminErrorCodes.ADMIN_ALREADY_EXISTS,
            'That username is already taken by another administrator in this operator.',
          );
        }
        throw error;
      });

    // The row's own tenant, not the ambient one: a platform admin editing operator X's staff must
    // evict X's cache entries, otherwise the demotion they just made stays invisible for 60 seconds
    // in the only tenant where it matters. Both doors — the console by id, the bot by Telegram id.
    await this.identities.invalidate({
      tenantId: updated.tenantId,
      adminUserId: updated.id,
      telegramUserId: updated.telegramUserId,
    });
    return toAdminUserView(updated);
  }

  /**
   * Offboarding. Soft, because `admin_users` is referenced by every deposit they ever decided
   * (onDelete: Restrict) — a hard delete would either fail or orphan the audit trail.
   */
  async deactivate(actor: AuthenticatedAdmin, id: string): Promise<AdminUserView> {
    return this.update(actor, id, { isActive: false });
  }

  private assertMayGrant(actor: AuthenticatedAdmin, role: AdminRole, tenantId: string): void {
    if (mayGrantRole(actor, role, tenantId)) return;
    throw new ForbiddenError(
      AdminErrorCodes.ADMIN_ROLE_NOT_GRANTABLE,
      'Only platform staff working in the platform itself can grant or change PLATFORM_ADMIN.',
      { role },
    );
  }

  private async assertAnotherSuperAdminRemains(
    tx: Tx,
    tenantId: string,
    excludingId: string,
  ): Promise<void> {
    const remaining = await this.admins.countActiveSuperAdmins(tenantId, excludingId, tx);
    if (remaining === 0) {
      throw new BusinessRuleError(
        AdminErrorCodes.ADMIN_LAST_SUPER_ADMIN,
        'This is the last active super administrator. Promote another one first.',
      );
    }
  }

  private async getOrThrow(tenantId: string, id: string, tx?: Tx): Promise<AdminUser> {
    const admin = await this.admins.findByIdInTenant(tenantId, id, tx);
    if (admin === null) {
      throw new NotFoundError(AdminErrorCodes.ADMIN_NOT_FOUND, 'Administrator not found.');
    }
    return admin;
  }
}
