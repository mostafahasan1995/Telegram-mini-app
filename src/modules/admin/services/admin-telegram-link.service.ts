/**
 * The staff directory's half of linking a staff account to Telegram (owner decision 4, 2026-09-15):
 * who may ask for a code, who may remove a link, and the contract errors. The mechanics (the code, its
 * digest and expiry, the bot command) are StaffTelegramLinkService's in @core/telegram.
 *
 * ══ WHO MAY ASK FOR A CODE ═══════════════════════════════════════════════════════════════════════
 * The staff member for their own account, and platform staff for any staff account of the operator
 * they are working in. Nobody else, a SUPER_ADMIN included: whoever is shown a code can send it from
 * THEIR Telegram account, which would make their taps count as the other person's. A platform admin
 * may, because a SUSPENDED operator's staff cannot sign in to the console yet, and setting an operator
 * up is the platform's job.
 *
 * ══ WHO MAY REMOVE A LINK ════════════════════════════════════════════════════════════════════════
 * The staff member, a SUPER_ADMIN of the operator (who manages its staff), and platform staff. Removing
 * a link only takes authority away. A PLATFORM_ADMIN row's link is removed only by someone who could
 * grant that role, the same rule as every other change to platform staff (admin-role-grant.ts).
 *
 * ══ WHY telegramUserId STAYS REFUSED ON THE DIRECTORY'S WRITES ═══════════════════════════════════
 * The contract refuses the field on create and update, and it stays refused: a Telegram id typed into
 * a form proves nothing about who holds that account. This link is the only way the column is set, and
 * it is set from an update Telegram sent.
 *
 * Every read and write is bound to the EFFECTIVE operator, like the rest of the directory: another
 * operator's staff id is ADMIN_NOT_FOUND.
 */
import { Injectable } from '@nestjs/common';

import type { AuthenticatedAdmin } from '@common/decorators/auth.types';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@common/exceptions/app.exception';
import { adminActor } from '@common/types/actor.type';
import { holdsAnyRole, isPlatformStaff } from '@core/auth/admin-authority';
import { STAFF_LINK_CODE_TTL_MINUTES } from '@core/telegram/staff-link/staff-link.constants';
import { StaffTelegramLinkService } from '@core/telegram/staff-link/staff-telegram-link.service';
import { requireEffectiveTenantId } from '@core/tenant';

import { ADMIN_MANAGER_ROLES, AdminErrorCodes } from '../admin.constants';
import { mayGrantRole } from '../admin-role-grant';
import type { StaffTelegramLinkCodeView } from '../dtos/admin-telegram-link.dto';
import type { AdminUserView } from '../dtos/admin-user.dto';
import { AdminUserRepository } from '../repositories/admin-user.repository';

import { toAdminUserView } from './admin-user.service';

/** The `details.reason` of ADMIN_TELEGRAM_LINK_NOT_ALLOWED. */
export type StaffTelegramLinkNotAllowedReason =
  | 'PLATFORM'
  | 'OPERATOR_CLOSED'
  | 'AGENT_PRINCIPAL'
  | 'INACTIVE';

const NOT_ALLOWED_MESSAGES: Readonly<Record<StaffTelegramLinkNotAllowedReason, string>> = {
  PLATFORM:
    'The platform itself has no bot, so its accounts cannot be linked to Telegram. Link a staff account of an operator instead.',
  OPERATOR_CLOSED: 'This operator is closed, so its bot no longer takes a link code.',
  AGENT_PRINCIPAL:
    "This is the operator's agent account, which cannot be linked to Telegram. Create a staff account for the person and link that.",
  INACTIVE: 'This staff account is deactivated. Reactivate it before linking it to Telegram.',
};

const notAllowed = (reason: StaffTelegramLinkNotAllowedReason): BusinessRuleError =>
  new BusinessRuleError(
    AdminErrorCodes.ADMIN_TELEGRAM_LINK_NOT_ALLOWED,
    NOT_ALLOWED_MESSAGES[reason],
    { reason },
  );

const adminNotFound = (): NotFoundError =>
  new NotFoundError(AdminErrorCodes.ADMIN_NOT_FOUND, 'Administrator not found.');

@Injectable()
export class AdminTelegramLinkService {
  constructor(
    private readonly links: StaffTelegramLinkService,
    private readonly admins: AdminUserRepository,
  ) {}

  /** POST /v1/admin/admins/:id/telegram-link-code. */
  async issueCode(actor: AuthenticatedAdmin, adminUserId: string): Promise<StaffTelegramLinkCodeView> {
    // Decided before anything is read: the answer does not depend on the row, so it reveals nothing.
    if (actor.adminUserId !== adminUserId && !isPlatformStaff(actor)) {
      throw new ForbiddenError(
        AdminErrorCodes.ADMIN_TELEGRAM_LINK_FORBIDDEN,
        'Only the staff member themselves, or a platform admin, can get a Telegram link code for an account.',
      );
    }

    const outcome = await this.links.issue({
      tenantId: requireEffectiveTenantId(),
      adminUserId,
      actor: adminActor(actor.adminUserId),
    });
    switch (outcome.kind) {
      case 'issued':
        return {
          adminUserId,
          code: outcome.code,
          command: `/link ${outcome.code}`,
          expiresAt: outcome.expiresAt.toISOString(),
          ttlSeconds: STAFF_LINK_CODE_TTL_MINUTES * 60,
          botUsername: outcome.botUsername,
          botUrl:
            outcome.botUsername === null
              ? null
              : `https://t.me/${encodeURIComponent(outcome.botUsername)}`,
        };
      case 'not-found':
        throw adminNotFound();
      case 'platform':
        throw notAllowed('PLATFORM');
      case 'closed':
        throw notAllowed('OPERATOR_CLOSED');
      case 'reserved-id':
        throw notAllowed('AGENT_PRINCIPAL');
      case 'inactive':
        throw notAllowed('INACTIVE');
      case 'already-linked':
        throw new ConflictError(
          AdminErrorCodes.ADMIN_TELEGRAM_ALREADY_LINKED,
          'This staff account is already linked to a Telegram account. Remove that link first.',
        );
    }
  }

  /** DELETE /v1/admin/admins/:id/telegram-link. Idempotent: an unlinked account comes back unchanged. */
  async unlink(actor: AuthenticatedAdmin, adminUserId: string): Promise<AdminUserView> {
    const tenantId = requireEffectiveTenantId();

    if (actor.adminUserId !== adminUserId) {
      if (!holdsAnyRole(actor, ADMIN_MANAGER_ROLES)) {
        throw new ForbiddenError(
          AdminErrorCodes.ADMIN_TELEGRAM_LINK_FORBIDDEN,
          "Only the staff member, a super admin of this operator or a platform admin can remove an account's Telegram link.",
        );
      }
      const target = await this.admins.findByIdInTenant(tenantId, adminUserId);
      if (target === null) throw adminNotFound();
      if (target.role === 'PLATFORM_ADMIN' && !mayGrantRole(actor, 'PLATFORM_ADMIN', tenantId)) {
        throw new ForbiddenError(
          AdminErrorCodes.ADMIN_TELEGRAM_LINK_FORBIDDEN,
          'Only platform staff working in the platform itself can change a platform admin.',
        );
      }
    }

    const outcome = await this.links.unlink({
      tenantId,
      adminUserId,
      actor: adminActor(actor.adminUserId),
    });
    switch (outcome.kind) {
      case 'unlinked':
        return toAdminUserView(outcome.admin);
      case 'not-found':
        throw adminNotFound();
      case 'reserved-id':
        throw notAllowed('AGENT_PRINCIPAL');
    }
  }
}
