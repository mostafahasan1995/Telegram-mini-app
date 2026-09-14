/**
 * POST /v1/admin/auth/credentials — the console's only sign-in (API-CONTRACT.md §2a).
 *
 * ══ THE ORDER IS THE SECURITY PROPERTY ═══════════════════════════════════════════════════════
 * Nothing about which operators exist is said until a password is proven. Every refusal before that
 * point — unknown login, wrong password, a deactivated account, an account with no password, an
 * operator that is CLOSED — is the SAME 401 with the same sentence. Only after a stored hash has
 * matched does the answer become specific (409 "which operator?", 403 "that operator is
 * suspended"), because by then everything said is about an operator the caller has proved they run.
 *
 * ══ WHY A MISS COSTS THE SAME AS A WRONG PASSWORD ════════════════════════════════════════════
 * `PasswordHasherService.verify(password, null)` runs a full derivation. An unknown username answered
 * in 1 ms next to a known one answered in 80 ms is a username oracle whatever the body says. The
 * residual, accepted on purpose: a login held by staff in SEVERAL operators costs one derivation per
 * operator, so a timing observer can tell "exists in 2+ operators" from "exists in 0 or 1". Hiding
 * that would mean padding every sign-in to the largest possible count, which turns the route into a
 * CPU amplifier; the throttle rule is what bounds guessing, not the clock.
 *
 * ══ WHY A DEACTIVATED ACCOUNT IS A PLAIN 401 AND NOT ADMIN_INACTIVE ══════════════════════════
 * `isActive: false` is how staff are offboarded, and everywhere else in this codebase it reads
 * exactly like "not an admin" (AdminIdentityService). Telling a former employee "your password is
 * still right, you are just switched off" confirms a credential to whoever holds it, and it is not
 * something the person typing can fix.
 *
 * ══ WHERE THE SECOND CREDENTIAL GOES ═════════════════════════════════════════════════════════
 * §2a puts two credentials behind these two fields: the caller's own console password, then the
 * operator's Ichancy agent account (§2b). Only the first exists here. A console-password miss is
 * therefore, today, a miss on both. The agent branch belongs at the single point marked in
 * `signIn`, and `resolveOperator` is deliberately credential-agnostic so that branch can reuse the
 * ambiguity and suspension rules under its own AGENT_ codes rather than restating them.
 *
 * ══ WHY FAILURES ARE LOG LINES, NOT AUDIT ROWS ═══════════════════════════════════════════════
 * An audit row has to be filed under an operator, and a refusal before the password is proven has
 * none to file it under. Writing a row only for the refusals that DO have one would put a database
 * round trip back into the timing difference the dummy derivation exists to remove. So, like the
 * player sign-in, the audit trail records the sign-in that happened (`admin.login`, same
 * transaction as the `last_login_at` stamp), and refusals are structured warnings that never carry
 * the password or the typed username.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma, TenantStatus, type AdminRole } from '@prisma/client';

import {
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
} from '@common/exceptions/app.exception';
import { adminActor } from '@common/types/actor.type';
import { AuditService } from '@core/audit/audit.service';
import { PasswordHasherService } from '@core/auth/services/password-hasher.service';
import { SessionService } from '@core/auth/services/session.service';
import { PrismaService } from '@core/prisma/prisma.service';
import { acrossTenants } from '@core/prisma/tenant-scope.extension';
import { runWithTenant } from '@core/tenant/tenant.storage';

import { AdminErrorCodes } from '../admin.constants';
import type { AdminCredentialsDto, AdminSessionView } from '../dtos/admin-auth.dto';
import { normalizeAdminUsername } from '../admin-username';

/** The operator a proven credential opens. */
export interface OperatorRef {
  tenantId: string;
  slug: string;
  displayName: string;
  status: TenantStatus;
}

/** What `details.operators` carries on 409 and 403. Names only — never ids, never settings. */
export interface OperatorChoice {
  slug: string;
  displayName: string;
}

export type OperatorResolution<T extends { operator: OperatorRef }> =
  | { kind: 'chosen'; match: T }
  | { kind: 'ambiguous'; operators: OperatorChoice[] }
  | { kind: 'not-active'; operators: OperatorChoice[] };

const toChoice = ({ operator }: { operator: OperatorRef }): OperatorChoice => ({
  slug: operator.slug,
  displayName: operator.displayName,
});

/**
 * Decides which operator a set of PROVEN matches opens. Call it only with a non-empty list — an
 * empty one is a miss, which the caller answers before any of this is said.
 *
 * Ambiguity is counted over ACTIVE operators only, mirroring the console's mock of the real route:
 * a person who is staff at one live operator and one suspended one has exactly one place to go, and
 * asking them to pick the suspended one only to refuse it would be a question with a wrong answer.
 * When nothing is active, the refusal names every proven operator, so the person knows which one to
 * chase.
 *
 * Tenant zero gets no exemption: it is created ACTIVE, and refusing to suspend the platform belongs
 * to whatever writes tenant status, not to a special case here that would outlive that rule.
 */
export function resolveOperator<T extends { operator: OperatorRef }>(
  proven: readonly T[],
): OperatorResolution<T> {
  const active = proven.filter((match) => match.operator.status === TenantStatus.ACTIVE);

  const [only, ...rest] = active;
  if (only !== undefined && rest.length === 0) return { kind: 'chosen', match: only };
  if (only !== undefined) return { kind: 'ambiguous', operators: active.map(toChoice) };
  return { kind: 'not-active', operators: proven.map(toChoice) };
}

/** One admin row whose stored hash matched the typed password. */
interface ProvenAdmin {
  adminUserId: string;
  telegramUserId: bigint | null;
  role: AdminRole;
  displayName: string;
  operator: OperatorRef;
  /** The stored hash was made at an older cost; the sign-in re-stores it at the current one. */
  needsRehash: boolean;
}

/** Tenant slugs are lower-case by construction; an empty or blank value means "not chosen". */
function normalizeOperatorSlug(raw: string | undefined): string | undefined {
  const slug = raw?.trim().toLowerCase();
  return slug === undefined || slug.length === 0 ? undefined : slug;
}

/** The one sentence for every refusal before a password is proven. Mirrored by the console mock. */
function credentialsInvalid(): UnauthorizedError {
  return new UnauthorizedError(
    AdminErrorCodes.ADMIN_CREDENTIALS_INVALID,
    'Those credentials are not valid for any administrator on this platform.',
  );
}

@Injectable()
export class AdminCredentialsService {
  private readonly logger = new Logger(AdminCredentialsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: PasswordHasherService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  async signIn(dto: AdminCredentialsDto): Promise<AdminSessionView> {
    const username = normalizeAdminUsername(dto.username);
    const operatorSlug = normalizeOperatorSlug(dto.operatorSlug);

    const proven = await this.proveConsolePassword(username, dto.password, operatorSlug);

    if (proven.length === 0) {
      // THE SEAM (§2a): the operator's Ichancy agent account is the second credential tried here.
      // Until it exists, a console-password miss is a miss on both and must read exactly like one.
      this.logger.warn(`Console sign-in refused: ${AdminErrorCodes.ADMIN_CREDENTIALS_INVALID}`);
      throw credentialsInvalid();
    }

    const resolution = resolveOperator(proven);

    if (resolution.kind === 'ambiguous') {
      // A question, not a failure: the console keeps the credential and re-sends with a slug.
      throw new ConflictError(
        AdminErrorCodes.ADMIN_OPERATOR_AMBIGUOUS,
        'Those credentials open more than one operator. Choose which one to sign into.',
        { operators: resolution.operators },
      );
    }

    if (resolution.kind === 'not-active') {
      this.logger.warn(
        `Console sign-in refused: ${AdminErrorCodes.ADMIN_OPERATOR_NOT_ACTIVE} ` +
          `(${resolution.operators.map((operator) => operator.slug).join(', ')})`,
      );
      throw new ForbiddenError(
        AdminErrorCodes.ADMIN_OPERATOR_NOT_ACTIVE,
        'That operator is suspended. A platform admin has to activate it before anyone can sign in.',
        { operators: resolution.operators },
      );
    }

    return this.openSession(resolution.match, dto.password);
  }

  /**
   * Every admin row this username and password open, or none.
   *
   * The lookup spans operators on purpose — a sign-in has no tenant yet — which is why it is spelled
   * `acrossTenants`. It matches the lower-cased login exactly: usernames are lower-cased on write
   * and were normalised by the console-identity migration, so equality IS the case-insensitive
   * match, and a legacy pair differing only by case (left mixed-case by that migration) stays
   * unreachable until renamed rather than making one login open two rows in one operator.
   */
  private async proveConsolePassword(
    username: string,
    password: string,
    operatorSlug: string | undefined,
  ): Promise<ProvenAdmin[]> {
    const candidates =
      username.length === 0
        ? []
        : await this.prisma.adminUser.findMany({
            where: acrossTenants<Prisma.AdminUserWhereInput>({
              username,
              isActive: true,
              passwordHash: { not: null },
              tenant: {
                // A CLOSED operator is not somewhere anyone can sign in, and saying it exists would
                // be saying something before the password is proven.
                status: { not: TenantStatus.CLOSED },
                ...(operatorSlug === undefined ? {} : { slug: operatorSlug }),
              },
            }),
            select: {
              id: true,
              tenantId: true,
              telegramUserId: true,
              role: true,
              displayName: true,
              passwordHash: true,
              tenant: { select: { slug: true, displayName: true, status: true } },
            },
            // Stable, so the operator picker lists the same choices in the same order every time.
            orderBy: [{ tenant: { slug: 'asc' } }],
          });

    if (candidates.length === 0) {
      // Same work as a real verification, against nothing. See the file header.
      await this.hasher.verify(password, null);
      return [];
    }

    const proven: ProvenAdmin[] = [];
    // Sequential, not Promise.all: each derivation holds ~32 MiB at the default cost, and a sign-in
    // must not multiply that by the number of operators a login happens to exist in.
    for (const candidate of candidates) {
      const verification = await this.hasher.verify(password, candidate.passwordHash);
      if (!verification.ok) continue;
      proven.push({
        adminUserId: candidate.id,
        telegramUserId: candidate.telegramUserId,
        role: candidate.role,
        displayName: candidate.displayName,
        operator: {
          tenantId: candidate.tenantId,
          slug: candidate.tenant.slug,
          displayName: candidate.tenant.displayName,
          status: candidate.tenant.status,
        },
        needsRehash: verification.needsRehash,
      });
    }
    return proven;
  }

  private async openSession(match: ProvenAdmin, password: string): Promise<AdminSessionView> {
    // Hashed BEFORE the transaction: runInTransaction may replay its callback on a serialization
    // conflict, and a replay should not pay for a second scrypt derivation.
    const rehashed = match.needsRehash ? await this.hasher.hash(password) : null;
    const signedInAt = new Date();

    // This route is @Public, so no bearer token put a tenant context around it. The stamp and the
    // audit row belong to the operator the ACCOUNT lives in — including tenant zero for platform
    // staff — so that operator is entered explicitly, the same move a worker makes.
    const stamped = await runWithTenant(match.operator.tenantId, () =>
      this.prisma.runInTransaction(async (tx) => {
        // updateMany re-asserting `isActive` makes the stamp a compare-and-swap: an account
        // deactivated between the password check and here gets no token, rather than a token the
        // guard refuses on its first request.
        const updated = await tx.adminUser.updateMany({
          where: { id: match.adminUserId, tenantId: match.operator.tenantId, isActive: true },
          data: {
            lastLoginAt: signedInAt,
            ...(rehashed === null ? {} : { passwordHash: rehashed }),
          },
        });
        if (updated.count !== 1) return false;

        await this.audit.write(tx, {
          action: 'admin.login',
          actor: adminActor(match.adminUserId),
          subjectType: 'AdminUser',
          subjectId: match.adminUserId,
          after: {
            method: 'password',
            lastLoginAt: signedInAt.toISOString(),
            passwordRehashed: rehashed !== null,
          },
        });
        return true;
      }),
    );

    if (!stamped) {
      this.logger.warn(`Console sign-in refused: admin ${match.adminUserId} deactivated mid-sign-in`);
      throw credentialsInvalid();
    }

    // The row just read is the authority for the token; the token's role claim is never trusted by
    // the guard anyway (it re-resolves by tid + sub on every request).
    const { accessToken, accessTokenExpiresAt } = await this.sessions.issueAdminAccessToken({
      adminUserId: match.adminUserId,
      telegramUserId: match.telegramUserId,
      tenantId: match.operator.tenantId,
      role: match.role,
      displayName: match.displayName,
    });

    return {
      accessToken,
      expiresAt: accessTokenExpiresAt.toISOString(),
      admin: {
        id: match.adminUserId,
        // String, not number: a 64-bit Telegram id does not survive JSON.parse as a number.
        telegramUserId: match.telegramUserId === null ? null : match.telegramUserId.toString(),
        role: match.role,
        displayName: match.displayName,
      },
      tenantId: match.operator.tenantId,
      tenantSlug: match.operator.slug,
    };
  }
}
