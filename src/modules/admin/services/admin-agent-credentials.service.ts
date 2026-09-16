/**
 * The operator's Ichancy agent account as a sign-in credential (API-CONTRACT.md §2b), shared by
 * `POST /v1/admin/auth/ichancy` and the second credential behind `POST /v1/admin/auth/credentials`.
 *
 * ══ WHY THE SEALED PASSWORD AND NOT A LIVE SIGN-IN ═══════════════════════════════════════════
 * The contract is explicit: the question is "do you hold the credential this deployment registers
 * players with", the row was already proved by a real Ichancy sign-in when the operator was activated,
 * and putting Cloudflare on the login path would turn an upstream outage into a lockout. Nothing in
 * this file calls Ichancy, and so nothing here can knock the operator's live session out either
 * (Ichancy issues one token pair per agent, and a sign-in kills the previous one).
 *
 * ══ HOW "IN CONSTANT TIME" IS MET ════════════════════════════════════════════════════════════
 * Both passwords are HMAC'd under a per-process random key and the fixed-length digests are compared
 * with `timingSafeEqual`, so the comparison takes the same time however many leading characters match
 * and whatever length either password is. A lookup that finds no operator still opens a sealed decoy
 * and does one comparison against it, so an unknown login costs the same crypto work as a known one
 * with the wrong password. The residual, accepted as it is for console passwords: each candidate
 * operator costs one AES-GCM open (microseconds, far below the database round trip every attempt
 * pays), so a timing observer could at best tell "this login is configured on several operators" from
 * "on one or none". The throttle rule bounds guessing, not the clock.
 *
 * ══ WHY THE LOGIN IS MATCHED CASE-INSENSITIVELY HERE, WHEN SESSIONS ARE NOT ═══════════════════
 * `ichancy-agent.ts` refuses to case-fold an agent login in a SESSION key, because a false match there
 * would let one operator draw on tokens another account obtained. A sign-in is a different question:
 * it only admits someone who ALSO typed the exact stored password, and the console's mock of this
 * route folds case on both sides. Folding here can therefore never admit a caller without the
 * password, and not folding would refuse an owner for typing `Agent1` where the form stored `agent1`.
 *
 * ══ THE AGENT PRINCIPAL ══════════════════════════════════════════════════════════════════════
 * The session becomes the operator's active SUPER_ADMIN whose username equals the agent login, else
 * its OLDEST active SUPER_ADMIN (its first owner) — never a PLATFORM_ADMIN, never another role. An
 * operator created from the dashboard has no staff at all (POST /v1/admin/tenants writes none), so
 * its first successful agent sign-in creates the principal: SUPER_ADMIN, username = the agent login,
 * Telegram id 0 (see AGENT_PRINCIPAL_TELEGRAM_USER_ID), audited as `admin.user.agentPrincipalCreated`
 * by SYSTEM. Two first sign-ins racing each other are settled by `@@unique([tenantId, username])`:
 * the loser's insert fails and it signs into the winner's row.
 *
 * An operator that HAS staff but no active SUPER_ADMIN is refused with AGENT_OPERATOR_HAS_NO_OWNER,
 * not given a fresh principal. That is how a deactivated or demoted principal stays switched off: if
 * a new one were minted whenever none was active, deactivating it would undo itself on the next
 * sign-in.
 *
 * NOTHING HERE LOGS a username, a password, a digest or an opened secret.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { AdminRole, TenantStatus, type AdminUser } from '@prisma/client';

import { ForbiddenError } from '@common/exceptions/app.exception';
import { SYSTEM_ACTOR } from '@common/types/actor.type';
import { AuditService } from '@core/audit/audit.service';
import { AdminIdentityService } from '@core/auth/services/admin-identity.service';
import { isUniqueConstraintError } from '@core/prisma/prisma-errors';
import { PrismaService } from '@core/prisma/prisma.service';
import {
  TenantSecretErrorCodes,
  TenantSecretService,
  isTenantSecretError,
  isTenantSecretSentinel,
} from '@core/tenant/services/tenant-secret.service';
import { TENANT_ZERO_ID } from '@core/tenant/tenant.constants';
import { runWithTenant } from '@core/tenant/tenant.storage';

import { AGENT_PRINCIPAL_TELEGRAM_USER_ID, AdminErrorCodes } from '../admin.constants';
import { normalizeAdminUsername } from '../admin-username';
import { AdminUserRepository } from '../repositories/admin-user.repository';
import type { OperatorRef } from './admin-credentials.service';

/** One operator whose sealed agent password matched what was typed. */
export interface ProvenAgent {
  operator: OperatorRef;
  /** The agent login as stored on the operator's row (trimmed). Never logged. */
  agentLogin: string;
}

/** The admin row an agent sign-in opens, in the shape a session is issued from. */
export interface AgentPrincipal {
  adminUserId: string;
  telegramUserId: bigint | null;
  role: AdminRole;
  displayName: string;
  operator: OperatorRef;
}

/** `admin_users.display_name` is bounded by the staff DTO at 120; the principal keeps to it. */
const DISPLAY_NAME_MAX_LENGTH = 120;

@Injectable()
export class AdminAgentCredentialsService {
  private readonly logger = new Logger(AdminAgentCredentialsService.name);
  /**
   * Keys the comparison digests. Random per process and never stored: the digests exist only for the
   * length of one comparison, so nothing needs to recompute them later.
   */
  private readonly compareKey = randomBytes(32);
  /** What a lookup with no candidate is compared against, so a miss does the same work as a match. */
  private readonly decoy = randomBytes(32);
  /** A sealed password nobody holds, opened when no operator matches. See `openDecoy`. */
  private decoyEnvelope: { id: string; ichancyPasswordEnc: string } | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: TenantSecretService,
    private readonly admins: AdminUserRepository,
    private readonly identities: AdminIdentityService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Every non-CLOSED operator whose agent login and sealed password match, or none. Tenant zero is
   * never a candidate: the platform has no agent, and its session would be a PLATFORM_ADMIN.
   *
   * `operatorSlug` is already normalised by the caller; undefined means "not chosen yet".
   */
  async prove(
    rawUsername: string,
    password: string,
    operatorSlug: string | undefined,
  ): Promise<ProvenAgent[]> {
    const login = rawUsername.trim();
    const folded = login.toLowerCase();
    const typed = this.digest(password);

    // A sentinel (`unused`, `REPLACE-ME…`) only occupies the column on an unconfigured row; it names
    // no account anyone holds, so it is not looked up at all.
    const rows =
      folded.length === 0 || isTenantSecretSentinel(folded)
        ? []
        : await this.prisma.tenant.findMany({
            where: {
              id: { not: TENANT_ZERO_ID },
              // A CLOSED operator is not somewhere anyone signs in, and saying it exists would be
              // saying something before the password is proven.
              status: { not: TenantStatus.CLOSED },
              ichancyUsername: { equals: login, mode: 'insensitive' },
              ...(operatorSlug === undefined ? {} : { slug: operatorSlug }),
            },
            select: {
              id: true,
              slug: true,
              displayName: true,
              status: true,
              ichancyUsername: true,
              ichancyPasswordEnc: true,
            },
            // Stable, so the operator picker lists the same choices in the same order every time.
            orderBy: { slug: 'asc' },
          });

    const proven: ProvenAgent[] = [];
    let compared = 0;
    for (const row of rows) {
      // Re-checked exactly: a case-insensitive database match is a pattern match on some engines,
      // and a `_` in a login must not stand for any character.
      if (row.ichancyUsername.trim().toLowerCase() !== folded) continue;

      const stored = this.openStoredPassword(row);
      compared += 1;
      const expected = stored === null ? this.decoy : this.digest(stored);
      if (timingSafeEqual(typed, expected) && stored !== null) {
        proven.push({
          operator: {
            tenantId: row.id,
            slug: row.slug,
            displayName: row.displayName,
            status: row.status,
          },
          agentLogin: row.ichancyUsername.trim(),
        });
      }
    }

    // Same work as one real candidate, against nothing: an AES-GCM open of a sealed decoy and one
    // comparison. Without the open, an unknown login would answer measurably faster than a known
    // one with the wrong password. See the file header.
    if (compared === 0) {
      this.openDecoy();
      timingSafeEqual(typed, this.decoy);
    }

    return proven;
  }

  /**
   * Opens a password sealed under this process's own key, and discards it. Sealed on first use rather
   * than in the constructor, so building the service never touches the tenant secret key.
   */
  private openDecoy(): void {
    this.decoyEnvelope ??= {
      id: TENANT_ZERO_ID,
      ichancyPasswordEnc: this.secrets.sealIchancyPassword(randomBytes(24).toString('base64url')),
    };
    this.openStoredPassword(this.decoyEnvelope);
  }

  /**
   * The admin row a proven agent credential signs in as, creating the operator's agent principal on
   * its first sign-in. Throws AGENT_OPERATOR_HAS_NO_OWNER when the operator has staff but no active
   * SUPER_ADMIN.
   *
   * Runs in the OPERATOR's tenant context: the route is @Public, so nothing else put one around it,
   * and both the scoped reads and the audit row belong to that operator.
   */
  resolvePrincipal(agent: ProvenAgent): Promise<AgentPrincipal> {
    const { operator } = agent;
    return runWithTenant(operator.tenantId, async () => {
      const username = normalizeAdminUsername(agent.agentLogin);

      const owner = await this.findOwner(operator.tenantId, username);
      if (owner !== null) return toPrincipal(owner, operator);

      const staff = await this.admins.countInTenant(operator.tenantId);
      if (staff > 0) {
        this.logger.warn(
          `Agent sign-in refused: ${AdminErrorCodes.AGENT_OPERATOR_HAS_NO_OWNER} (${operator.slug})`,
        );
        throw hasNoOwner(operator);
      }

      const created = await this.createPrincipal(operator, username);
      if (created !== null) return toPrincipal(created, operator);

      // Lost the race to a concurrent first sign-in: sign into the row it created.
      const winner = await this.findOwner(operator.tenantId, username);
      if (winner !== null) return toPrincipal(winner, operator);
      throw hasNoOwner(operator);
    });
  }

  /** The SUPER_ADMIN named like the agent login, else the oldest active one. */
  private async findOwner(tenantId: string, username: string): Promise<AdminUser | null> {
    return (
      (await this.admins.findActiveSuperAdmin(tenantId, username)) ??
      (await this.admins.findActiveSuperAdmin(tenantId, null))
    );
  }

  /** Null when a concurrent sign-in created it first (a unique violation). */
  private async createPrincipal(operator: OperatorRef, username: string): Promise<AdminUser | null> {
    const displayName = operator.displayName.slice(0, DISPLAY_NAME_MAX_LENGTH);

    let principal: AdminUser;
    try {
      principal = await this.prisma.runInTransaction(async (tx) => {
        const row = await this.admins.create(
          {
            tenant: { connect: { id: operator.tenantId } },
            username,
            telegramUserId: AGENT_PRINCIPAL_TELEGRAM_USER_ID,
            displayName,
            role: AdminRole.SUPER_ADMIN,
            isActive: true,
            // No console password: this row is opened by the agent credential. Staff who need their
            // own password (and their own name in the audit trail) are added in the directory.
            passwordHash: null,
          },
          tx,
        );

        await this.audit.write(tx, {
          action: 'admin.user.agentPrincipalCreated',
          actor: SYSTEM_ACTOR,
          subjectType: 'AdminUser',
          subjectId: row.id,
          after: {
            username: row.username,
            telegramUserId: AGENT_PRINCIPAL_TELEGRAM_USER_ID.toString(),
            displayName: row.displayName,
            role: row.role,
            isActive: row.isActive,
          },
          metadata: { reason: 'first sign-in with the operator Ichancy agent account' },
        });

        return row;
      });
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) return null;
      throw error;
    }

    // A Telegram lookup for id 0 may have been cached as a miss; the row now exists.
    await this.identities.invalidate({
      tenantId: principal.tenantId,
      adminUserId: principal.id,
      telegramUserId: principal.telegramUserId,
    });
    return principal;
  }

  /**
   * The row's password, or null when it cannot be one: unset, a sentinel, or unreadable. Only an
   * unreadable one is worth a log line — it means tampering or a changed JWT_SECRET — and the line
   * names the operator and the code, never the value.
   */
  private openStoredPassword(row: { id: string; ichancyPasswordEnc: string }): string | null {
    try {
      return this.secrets.openIchancyPassword(row);
    } catch (error: unknown) {
      if (!isTenantSecretError(error)) throw error;
      if (error.code === TenantSecretErrorCodes.TENANT_SECRET_UNREADABLE) {
        this.logger.warn(`Agent sign-in: operator ${row.id} holds an Ichancy password that does not open`);
      }
      return null;
    }
  }

  private digest(value: string): Buffer {
    return createHmac('sha256', this.compareKey).update(value, 'utf8').digest();
  }
}

function toPrincipal(row: AdminUser, operator: OperatorRef): AgentPrincipal {
  return {
    adminUserId: row.id,
    telegramUserId: row.telegramUserId,
    role: row.role,
    displayName: row.displayName,
    operator,
  };
}

export function hasNoOwner(operator: OperatorRef): ForbiddenError {
  return new ForbiddenError(
    AdminErrorCodes.AGENT_OPERATOR_HAS_NO_OWNER,
    'Those credentials are right, but this operator has no active owner account. A platform admin can re-enable it.',
    { operators: [{ slug: operator.slug, displayName: operator.displayName }] },
  );
}
