/**
 * An operator's Ichancy agent, from the platform side: activation, the credential edit, the import of
 * the agent's existing players, and the agent half of health.
 *
 * ══ ACTIVATION IS A REAL SIGN-IN, EVERY TIME ═════════════════════════════════════════════════════
 * The contract: "POST /v1/admin/tenants/:id/activate (verifies the Ichancy agent with a real
 * signin)". A new operator lands SUSPENDED because nothing on a form can prove its credentials; this
 * is where they are proven. The sign-in uses the operator's own stored username and password (never
 * a stored session, never another operator's, never env), and only a sign-in Ichancy ACCEPTS moves
 * the row to ACTIVE. There is no resume path: an operator suspended while serving proves its
 * credentials again like any other, because a password can change at Ichancy while an operator sits
 * suspended, and "it worked last week" is not a verification.
 *
 * The status change is conditional on the status AND on the exact credential columns the sign-in was
 * made with. A credential edit that commits while the sign-in is in flight makes it match no row, and
 * the admin is told to activate again, instead of activating details that were never proven.
 *
 * WHAT A REFUSAL LOOKS LIKE: the row stays SUSPENDED, a `tenant.activation.refused` row records the
 * code (never a credential), and the answer is split by what fixes it: 422 ICHANCY_SIGNIN_FAILED
 * (Ichancy said no), 503 TENANT_ICHANCY_UNAVAILABLE (no answer; try again), 422
 * TENANT_ICHANCY_UNCONFIGURED (the stored details cannot be used). The console shows the message
 * verbatim. See tenant-error-codes.ts for why the first is the dashboard's name but not its 502.
 *
 * UNDER ICHANCY_FAKE the fake adapter answers the sign-in. The activation is still recorded, with
 * `adapter: 'fake'` in its audit row, so a fake verification can never be mistaken for a real one.
 * What the console reads says the same: TenantView and the import summary carry `ichancyFake`, and
 * health does not ask the fake at all (see health).
 *
 * ══ THE CREDENTIAL EDIT VERIFIES BEFORE IT SAVES ═════════════════════════════════════════════════
 * PATCH /:id/ichancy (TENANT-OPERATIONS.md §6) writes only fields that change, refuses a new agent id
 * once the operator has players (422 TENANT_AGENT_HAS_PLAYERS { players }), signs in with the RESULTING
 * credentials before anything is written (a move to another host needs the password in the same
 * request: the stored one is never sent anywhere but the stored host), records every refusal as
 * `tenant.ichancy.update.refused` with the origin it named, seals a new password, and saves under a row lock that
 * re-checks nothing moved while the sign-in ran. The session of an agent the operator moved away from
 * is dropped once no other operator uses it; the verifying sign-in already replaced the pair of the
 * agent it moved to.
 *
 * ══ THE IMPORT NEVER THROWS ON ICHANCY ═══════════════════════════════════════════════════════════
 * POST /:id/import-players reads the agent's players a page at a time, until Ichancy's first short
 * page, and writes the ones this operator does not know yet (by Ichancy id or login) as
 * `source: ICHANCY_IMPORT` rows with no Telegram id. Idempotent: a second run finds them `existing`.
 * An Ichancy failure part-way is REPORTED in `error` with the counts so far, never thrown, because the
 * rows already written stay written. One run per operator at a time, cluster-wide (409
 * IMPORT_ALREADY_RUNNING), on a lease renewed after every page. A run that stops early (a failure, the
 * safety bound, a lost lease) leaves a cursor so the next run continues instead of re-reading the same
 * first pages; see IMPORT_CURSOR_TTL_SECONDS. It registers nothing at Ichancy: it only reads, so it
 * cannot mint an account.
 *
 * A SHARED LOGIN: the listing returns every player of the signed-in login. When another operator names
 * the same login under a DIFFERENT agent id, only records whose `parentId` is this operator's agent id
 * are imported; a record that does not say is left out and counted in `error`, because guessing would
 * hand one operator's players, logins and emails to another. Operators sharing a login AND an agent id
 * share one tree by construction, but one Ichancy account is still one player: a record another such
 * operator already holds is left out and named in `error`, never imported a second time.
 *
 * ══ EVERY ICHANCY CALL HERE RUNS INSIDE THE OPERATOR'S CONTEXT ══════════════════════════════════
 * The request's own context is tenant zero (or wherever X-Tenant-Id points). Each call to the port is
 * wrapped in runWithTenant(operator), so it is made with that operator's agent and its call-log row
 * lands in that operator's log.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PlayerSource, PlayerStatus, TenantStatus, type Prisma } from '@prisma/client';

import {
  BusinessRuleError,
  ConflictError,
  ServiceUnavailableError,
  ValidationError,
  isAppException,
  type AppException,
} from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';
import { adminActor } from '@common/types/actor.type';
import { AuditService } from '@core/audit/audit.service';
import { CacheService } from '@core/cache/cache.service';
import { LockService, type LockHandle } from '@core/cache/lock.service';
import { AppConfigService } from '@core/config/config.service';
import {
  ICHANCY_PORT,
  IchancySessionService,
  TRANSPORT_ORIGIN_UNSUPPORTED_CODE,
  ichancyAgentKey,
  ichancyAmbiguous,
  ichancyRejected,
  type AgentPlayerRecord,
  type IchancyAgentCandidate,
  type IchancyPort,
  type IchancyResult,
} from '@core/ichancy';
import { PrismaService } from '@core/prisma/prisma.service';
import { acrossTenants } from '@core/prisma/tenant-scope.extension';
import {
  TenantSecretService,
  isTenantSecretError,
  isTenantSecretSentinel,
} from '@core/tenant/services/tenant-secret.service';
import { TenantErrorCodes } from '@core/tenant/tenant-error-codes';
import { TENANT_ZERO_ID } from '@core/tenant/tenant.constants';
import { runWithTenant } from '@core/tenant/tenant.storage';

import type { UpdateTenantIchancyDto } from '../dtos/update-tenant-ichancy.dto';
import {
  ACTIVATION_FAILED_UNEXPECTEDLY_MESSAGE,
  HOST_MOVE_NEEDS_PASSWORD_FIELD,
  ICHANCY_HEALTH_CACHE_SECONDS,
  IMPORT_ALREADY_RUNNING_MESSAGE,
  IMPORT_CURSOR_TTL_SECONDS,
  ICHANCY_FAKE_MODE_MESSAGE,
  IMPORT_FAILED_UNEXPECTEDLY_MESSAGE,
  IMPORT_LOCK_TTL_MS,
  PLATFORM_HAS_NO_AGENT_MESSAGE,
  SIGNIN_VERIFICATION,
  TENANT_IMPORT_LIMITS,
  TenantAuditActions,
  ichancyHealthCacheKey,
  importHeldElsewhereMessage,
  importLeaseLostMessage,
  importPlayersCursorKey,
  importPlayersLockKey,
  importStoppedAtBoundMessage,
  importUnattributedMessage,
  type PlayerImportLimits,
} from '../tenant-admin.constants';
import { tenantNotFound } from '../utils/tenant-errors';
import {
  ichancyHealthNotChecked,
  type PlayerImportSummaryView,
  type TenantIchancyHealthView,
} from '../views/tenant-operations.view';
import type { TenantView } from '../views/tenant.view';

import { TenantAdminService } from './tenant-admin.service';

const TENANT_SUBJECT = 'Tenant';
const IMPORT_CORRELATION = 'tenant:import-players';
const HEALTH_CORRELATION = 'tenant:health';

/**
 * Session failures a real sign-in cures: there is no stored pair for this agent, or it was obtained
 * with other credentials, or its refresh token died. The api role never signs in on its own, so a
 * platform action that needs the agent proves the operator's credentials first and retries once.
 */
const CURED_BY_SIGN_IN: ReadonlySet<string> = new Set([
  'ICHANCY_SESSION_MISSING',
  'ICHANCY_SESSION_CREDENTIALS_CHANGED',
  'ICHANCY_SESSION_REAUTH_REQUIRED',
]);

/** Refusals that are about the stored details, not about Ichancy's verdict on them. */
const UNCONFIGURED_CODES: ReadonlySet<string> = new Set([
  'ICHANCY_AGENT_UNCONFIGURED',
  'ICHANCY_TENANT_NOT_FOUND',
  'ICHANCY_PLATFORM_HAS_NO_AGENT',
]);

/** The columns a sign-in is made from, plus what an activation and an edit decide on. */
const AGENT_ROW_SELECT = {
  id: true,
  status: true,
  currencyCode: true,
  ichancyBaseUrl: true,
  ichancyUsername: true,
  ichancyPasswordEnc: true,
  ichancyAgentId: true,
} as const;

interface AgentRow {
  id: string;
  status: TenantStatus;
  currencyCode: string;
  ichancyBaseUrl: string;
  ichancyUsername: string;
  ichancyPasswordEnc: string;
  ichancyAgentId: string;
}

type ActivationAttempt =
  | { readonly kind: 'activated' }
  | { readonly kind: 'already-active' }
  | { readonly kind: 'refused'; readonly error: AppException };

/** What provisioning reports for its activation and import steps. */
export interface ProvisioningStep {
  readonly ok: boolean;
  readonly error: string | null;
}

/** The part of a health answer that costs an Ichancy call, and is therefore cached. JSON-safe. */
interface IchancyCheck {
  ok: boolean;
  checkedAt: string;
  error: string | null;
  floatMinor: string | null;
  belowWatermark: boolean;
}

/** What one import run counted, and why it stopped early if it did. */
interface ImportCounts {
  scanned: number;
  created: number;
  existing: number;
  error: string | null;
}

/** The operator columns an import decides on. */
interface ImportTarget {
  id: string;
  currencyCode: string;
  ichancyBaseUrl: string;
  ichancyUsername: string;
  ichancyAgentId: string;
}

/** The operator row health passes in. */
export interface IchancyHealthTarget {
  id: string;
  ichancyBaseUrl: string;
  ichancyUsername: string;
  ichancyAgentId: string;
  agentFloatLowWatermarkMinor: bigint;
}

@Injectable()
export class TenantIchancyService {
  private readonly logger = new Logger(TenantIchancyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly secrets: TenantSecretService,
    private readonly cache: CacheService,
    private readonly locks: LockService,
    private readonly config: AppConfigService,
    private readonly session: IchancySessionService,
    private readonly tenants: TenantAdminService,
    @Inject(ICHANCY_PORT) private readonly ichancy: IchancyPort,
    @Inject(TENANT_IMPORT_LIMITS) private readonly importLimits: PlayerImportLimits,
  ) {}

  // ── activation ──────────────────────────────────────────────────────────────────────────────

  /** POST /:id/activate. See the file header. An ACTIVE operator is answered as it is. */
  async activate(actorAdminId: string, id: string): Promise<TenantView> {
    const attempt = await this.attemptActivation(actorAdminId, id);
    if (attempt.kind === 'refused') throw attempt.error;
    return this.tenants.get(id);
  }

  /** provision()'s activation step: a boolean and a sentence, never a throw. */
  async activateForProvisioning(actorAdminId: string, id: string): Promise<ProvisioningStep> {
    try {
      const attempt = await this.attemptActivation(actorAdminId, id);
      return attempt.kind === 'refused'
        ? { ok: false, error: attempt.error.message }
        : { ok: true, error: null };
    } catch (error: unknown) {
      this.logger.error(`Tenant ${id}: activation on create failed: ${describeError(error)}`);
      return { ok: false, error: ACTIVATION_FAILED_UNEXPECTEDLY_MESSAGE };
    }
  }

  private async attemptActivation(actorAdminId: string, id: string): Promise<ActivationAttempt> {
    const row = await this.prisma.tenant.findUnique({ where: { id }, select: AGENT_ROW_SELECT });
    if (row === null) throw tenantNotFound();
    if (row.status === TenantStatus.CLOSED) return { kind: 'refused', error: tenantClosed() };
    if (row.status === TenantStatus.ACTIVE) return { kind: 'already-active' };

    const tail = 'The operator stays suspended.';
    const candidate = this.candidateFromRow(row, null);
    if (candidate.kind === 'refused') {
      const refusal = ichancyUnconfigured(`${candidate.message} ${tail}`);
      await this.recordRefusal(actorAdminId, id, refusal.errorCode);
      return { kind: 'refused', error: refusal };
    }

    const signedIn = await runWithTenant(id, () => this.ichancy.signIn(candidate.value));
    if (signedIn.kind !== 'ok') {
      const refusal = signInRefusal(signedIn, tail);
      await this.recordRefusal(actorAdminId, id, refusal.errorCode);
      return { kind: 'refused', error: refusal };
    }

    const outcome = await this.prisma.runInTransaction(async (tx) => {
      const claimed = await tx.tenant.updateMany({
        where: {
          id,
          status: TenantStatus.SUSPENDED,
          ichancyBaseUrl: row.ichancyBaseUrl,
          ichancyUsername: row.ichancyUsername,
          ichancyPasswordEnc: row.ichancyPasswordEnc,
          ichancyAgentId: row.ichancyAgentId,
        },
        data: { status: TenantStatus.ACTIVE },
      });
      if (claimed.count === 0) {
        const current = await tx.tenant.findUnique({ where: { id }, select: { status: true } });
        if (current?.status === TenantStatus.ACTIVE) return 'already-active' as const;
        if (current?.status === TenantStatus.CLOSED) return 'closed' as const;
        return 'changed' as const;
      }

      await runWithTenant(id, () =>
        this.audit.write(tx, {
          action: TenantAuditActions.TENANT_ACTIVATED,
          actor: adminActor(actorAdminId),
          subjectType: TENANT_SUBJECT,
          subjectId: id,
          before: { status: TenantStatus.SUSPENDED },
          after: { status: TenantStatus.ACTIVE },
          metadata: {
            verification: SIGNIN_VERIFICATION,
            signIn: true,
            adapter: this.adapterName(),
            agentKey: signedIn.data.agentKey,
          },
        }),
      );
      return 'activated' as const;
    });

    if (outcome === 'already-active') return { kind: 'already-active' };
    if (outcome === 'closed') return { kind: 'refused', error: tenantClosed() };
    if (outcome === 'changed') {
      return {
        kind: 'refused',
        error: new ConflictError(
          CommonErrorCodes.WRITE_CONFLICT,
          "This operator's Ichancy details changed while they were being verified, so nothing was " +
            'activated. Activate it again to verify the new details.',
        ),
      };
    }

    // Every process must see ACTIVE now, and the bot and the mini-app key are rebuilt from the row.
    await this.tenants.evictOperator(id);
    await this.forgetHealth(id);
    return { kind: 'activated' };
  }

  private async recordRefusal(actorAdminId: string, id: string, code: string): Promise<void> {
    await this.recordBestEffort(actorAdminId, id, TenantAuditActions.TENANT_ACTIVATION_REFUSED, {
      code,
      adapter: this.adapterName(),
    });
  }

  /**
   * A refusal's audit row, in that operator's log. Best effort: the refusal is already the answer, and
   * losing its evidence must not change it. `metadata` never carries a credential.
   */
  private async recordBestEffort(
    actorAdminId: string,
    id: string,
    action: string,
    metadata: Record<string, string | readonly string[] | null>,
  ): Promise<void> {
    try {
      await this.prisma.runInTransaction((tx) =>
        runWithTenant(id, () =>
          this.audit.write(tx, {
            action,
            actor: adminActor(actorAdminId),
            subjectType: TENANT_SUBJECT,
            subjectId: id,
            metadata,
          }),
        ),
      );
    } catch (error: unknown) {
      this.logger.error(`Tenant ${id}: the refusal (${action}) was not recorded: ${describeError(error)}`);
    }
  }

  // ── the credential edit ──────────────────────────────────────────────────────────────────────

  /** PATCH /:id/ichancy. See the file header. */
  async updateIchancy(
    actorAdminId: string,
    id: string,
    dto: UpdateTenantIchancyDto,
  ): Promise<TenantView> {
    if (id === TENANT_ZERO_ID) throw platformLocked();

    const row = await this.prisma.tenant.findUnique({ where: { id }, select: AGENT_ROW_SELECT });
    if (row === null) throw tenantNotFound();
    if (row.status === TenantStatus.CLOSED) throw tenantClosed();

    const next = {
      baseUrl: dto.ichancyBaseUrl === undefined ? row.ichancyBaseUrl : stripTrailingSlashes(dto.ichancyBaseUrl),
      username: dto.ichancyUsername ?? row.ichancyUsername,
      agentId: dto.ichancyAgentId ?? row.ichancyAgentId,
    };
    const storedPassword = this.openStoredPassword(row);
    const changed = {
      baseUrl: next.baseUrl !== row.ichancyBaseUrl,
      username: next.username !== row.ichancyUsername,
      agentId: next.agentId !== row.ichancyAgentId,
      password: dto.ichancyPassword !== undefined && dto.ichancyPassword !== storedPassword,
    };
    // Nothing differs from what is stored: no sign-in, no write, no audit row.
    if (!changed.baseUrl && !changed.username && !changed.agentId && !changed.password) {
      return this.tenants.get(id);
    }

    // Every refusal from here on is recorded: it names where a sign-in was (or would have been) sent.
    const attempted = {
      fields: [
        ...(changed.baseUrl ? ['ichancyBaseUrl'] : []),
        ...(changed.username ? ['ichancyUsername'] : []),
        ...(dto.ichancyPassword !== undefined ? ['ichancyPassword'] : []),
        ...(changed.agentId ? ['ichancyAgentId'] : []),
      ],
      targetOrigin: changed.baseUrl ? originOf(next.baseUrl) : null,
    };
    const refuse = async (error: AppException): Promise<AppException> => {
      await this.recordBestEffort(actorAdminId, id, TenantAuditActions.TENANT_ICHANCY_UPDATE_REFUSED, {
        code: error.errorCode,
        fields: attempted.fields,
        targetOrigin: attempted.targetOrigin,
        adapter: this.adapterName(),
      });
      return error;
    };

    // THE STORED PASSWORD NEVER LEAVES FOR ANOTHER HOST. The sign-in below posts the password in
    // clear to `next.baseUrl`, and the base URL is caller-chosen: pairing it with the stored password
    // would let anyone holding a platform session read an operator's agent password (a real-money
    // float) off a host of their choosing, with the contract's "write-only in both directions" void.
    // Moving hosts therefore needs the password in the same request, from someone who knows it.
    const hostMoved = !sameOrigin(next.baseUrl, row.ichancyBaseUrl);
    if (hostMoved && dto.ichancyPassword === undefined) {
      throw await refuse(new ValidationError(undefined, { fields: [HOST_MOVE_NEEDS_PASSWORD_FIELD] }));
    }

    if (changed.agentId) {
      const players = await this.prisma.player.count({ where: { tenantId: id } });
      if (players > 0) throw await refuse(agentHasPlayers(players));
    }

    const tail = 'Nothing was saved.';
    // The stored password only ever pairs with the stored host (guarded above; `hostMoved` again here
    // so a later edit to the guard cannot quietly reintroduce the pairing).
    const password = dto.ichancyPassword ?? (hostMoved ? null : storedPassword);
    if (password === null) {
      throw await refuse(
        ichancyUnconfigured(
          `The stored Ichancy password of this operator cannot be used; send ichancyPassword with the change. ${tail}`,
        ),
      );
    }
    const sealedPassword = changed.password ? this.sealPassword(password) : row.ichancyPasswordEnc;

    const candidate: IchancyAgentCandidate = {
      tenantId: id,
      baseUrl: next.baseUrl,
      username: next.username,
      password,
      agentId: next.agentId,
      currency: row.currencyCode,
    };
    const verified = await runWithTenant(id, () => this.ichancy.signIn(candidate));
    if (verified.kind !== 'ok') throw await refuse(signInRefusal(verified, tail));

    await this.prisma.runInTransaction(async (tx) => {
      // The row lock the check-then-write needs: without it two edits verified in parallel would
      // both pass the comparison below and the second would silently undo the first.
      await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.tenant.findUnique({ where: { id }, select: AGENT_ROW_SELECT });
      if (locked === null) throw tenantNotFound();
      if (
        locked.ichancyBaseUrl !== row.ichancyBaseUrl ||
        locked.ichancyUsername !== row.ichancyUsername ||
        locked.ichancyPasswordEnc !== row.ichancyPasswordEnc ||
        locked.ichancyAgentId !== row.ichancyAgentId
      ) {
        throw new ConflictError(
          CommonErrorCodes.WRITE_CONFLICT,
          "This operator's Ichancy details were changed by someone else while these were being " +
            `verified. Reload them and try again. ${tail}`,
        );
      }
      if (changed.agentId) {
        const players = await tx.player.count({ where: { tenantId: id } });
        if (players > 0) throw agentHasPlayers(players);
      }

      await tx.tenant.update({
        where: { id },
        data: {
          ichancyBaseUrl: next.baseUrl,
          ichancyUsername: next.username,
          ichancyAgentId: next.agentId,
          ichancyPasswordEnc: sealedPassword,
        },
        select: { id: true },
      });

      const before: Record<string, string> = {};
      const after: Record<string, string> = {};
      if (changed.baseUrl) {
        before['ichancyBaseUrl'] = row.ichancyBaseUrl;
        after['ichancyBaseUrl'] = next.baseUrl;
      }
      if (changed.username) {
        before['ichancyUsername'] = row.ichancyUsername;
        after['ichancyUsername'] = next.username;
      }
      if (changed.agentId) {
        before['ichancyAgentId'] = row.ichancyAgentId;
        after['ichancyAgentId'] = next.agentId;
      }
      await runWithTenant(id, () =>
        this.audit.write(tx, {
          action: TenantAuditActions.TENANT_ICHANCY_UPDATED,
          actor: adminActor(actorAdminId),
          subjectType: TENANT_SUBJECT,
          subjectId: id,
          before,
          after,
          // Whether the password changed, never the password in any form.
          metadata: {
            passwordChanged: changed.password,
            verification: SIGNIN_VERIFICATION,
            adapter: this.adapterName(),
          },
        }),
      );
    });

    // The operator moved to another agent: drop the old agent's session unless another operator
    // still signs in with it. The verifying sign-in already stored the new agent's pair.
    const previousKey = ichancyAgentKey(row.ichancyBaseUrl, row.ichancyUsername);
    const nextKey = ichancyAgentKey(next.baseUrl, next.username);
    if (previousKey !== nextKey && (await this.operatorsOnAgent(previousKey, id)).length === 0) {
      await this.session.invalidate(previousKey);
    }
    await this.forgetHealth(id);
    await this.tenants.evictOperator(id);
    return this.tenants.get(id);
  }

  private sealPassword(password: string): string {
    try {
      return this.secrets.sealIchancyPassword(password);
    } catch (error: unknown) {
      if (!isTenantSecretError(error)) throw error;
      throw new ValidationError(undefined, {
        fields: ['ichancyPassword must be the real agent password, not a placeholder'],
      });
    }
  }

  /** The stored password, or null when it does not open (a placeholder, another root secret). */
  private openStoredPassword(row: AgentRow): string | null {
    try {
      return this.secrets.openIchancyPassword(row);
    } catch (error: unknown) {
      if (isTenantSecretError(error)) return null;
      throw error;
    }
  }

  /**
   * The sign-in candidate for the credentials on `row`, or why there is none. Built from the very
   * columns the activation's conditional update pins, so what is proven is what is activated.
   */
  private candidateFromRow(
    row: AgentRow,
    password: string | null,
  ):
    | { readonly kind: 'candidate'; readonly value: IchancyAgentCandidate }
    | { readonly kind: 'refused'; readonly message: string } {
    const missing = [
      ...(isInert(row.ichancyBaseUrl) ? ['base URL'] : []),
      ...(isInert(row.ichancyUsername) ? ['username'] : []),
      ...(isInert(row.ichancyAgentId) ? ['agent id'] : []),
    ];
    if (missing.length > 0) {
      return {
        kind: 'refused',
        message: `This operator's Ichancy ${missing.join(', ')} is not set; set it from the dashboard.`,
      };
    }
    const opened = password ?? this.openStoredPassword(row);
    if (opened === null) {
      return {
        kind: 'refused',
        message:
          "This operator's stored Ichancy password cannot be read; enter it again from the dashboard.",
      };
    }
    return {
      kind: 'candidate',
      value: {
        tenantId: row.id,
        baseUrl: row.ichancyBaseUrl,
        username: row.ichancyUsername,
        password: opened,
        agentId: row.ichancyAgentId,
        currency: row.currencyCode,
      },
    };
  }

  // ── the import ──────────────────────────────────────────────────────────────────────────────

  /** POST /:id/import-players. See the file header. */
  async importPlayers(actorAdminId: string, id: string): Promise<PlayerImportSummaryView> {
    if (id === TENANT_ZERO_ID) throw platformLocked();
    const row = await this.prisma.tenant.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        currencyCode: true,
        ichancyBaseUrl: true,
        ichancyUsername: true,
        ichancyAgentId: true,
      },
    });
    if (row === null) throw tenantNotFound();
    if (row.status === TenantStatus.CLOSED) throw tenantClosed();

    const handle = await this.locks.acquire(importPlayersLockKey(id), IMPORT_LOCK_TTL_MS);
    if (handle === null) {
      throw new ConflictError(TenantErrorCodes.IMPORT_ALREADY_RUNNING, IMPORT_ALREADY_RUNNING_MESSAGE);
    }

    const startedAt = new Date();
    try {
      const counts = await runWithTenant(id, () => this.runImport(row, handle));
      const finishedAt = new Date();
      await this.recordImport(actorAdminId, id, counts);
      return {
        ...counts,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        // The counts above came from the fake adapter's fixtures when this is true.
        ichancyFake: this.config.ichancy.fake,
      };
    } finally {
      await this.locks.release(handle).catch(() => false);
    }
  }

  /** provision()'s import step: the number created and a sentence, never a throw. */
  async importForProvisioning(
    actorAdminId: string,
    id: string,
  ): Promise<{ imported: number; error: string | null }> {
    try {
      const summary = await this.importPlayers(actorAdminId, id);
      return { imported: summary.created, error: summary.error };
    } catch (error: unknown) {
      if (isAppException(error)) return { imported: 0, error: error.message };
      this.logger.error(`Tenant ${id}: the import on create failed: ${describeError(error)}`);
      return { imported: 0, error: IMPORT_FAILED_UNEXPECTEDLY_MESSAGE };
    }
  }

  /**
   * MUST run inside the operator's tenant context: every page is read with its agent. Holds `handle`
   * and renews it after every page. See the file header for the cursor and for a shared login.
   */
  private async runImport(target: ImportTarget, handle: LockHandle): Promise<ImportCounts> {
    const { pageSize, maxPlayersPerRun } = this.importLimits;
    const id = target.id;
    const agentId = target.ichancyAgentId.trim();
    const sharingLogin = await this.operatorsSharingLogin(
      ichancyAgentKey(target.ichancyBaseUrl, target.ichancyUsername),
      id,
    );
    const sharedUnderAnotherAgentId = sharingLogin
      .filter((operator) => operator.agentId.trim() !== agentId)
      .map((operator) => operator.slug);
    // Operators on the same login AND agent id read the very same tree; a player one of them already
    // holds is not this operator's to import too. See importHeldElsewhereMessage.
    const sameTree = sharingLogin.filter((operator) => operator.agentId.trim() === agentId);

    const cursor = await this.readImportCursor(id);
    // One page early; see IMPORT_CURSOR_TTL_SECONDS.
    const resumeFrom = cursor === null ? 0 : Math.max(0, cursor - pageSize);

    let scanned = 0;
    let created = 0;
    let existing = 0;
    let unattributed = 0;
    let heldElsewhere = 0;
    const heldBy = new Set<string>();
    let stoppedBecause: string | null = null;

    for (let start = resumeFrom; ; start += pageSize) {
      if (start - resumeFrom >= maxPlayersPerRun) {
        await this.saveImportCursor(id, start);
        stoppedBecause = importStoppedAtBoundMessage(scanned);
        break;
      }

      const page = await this.withSignInFallback(() =>
        this.ichancy.listAgentPlayers({ start, limit: pageSize }, { correlationId: IMPORT_CORRELATION }),
      );
      if (page.kind !== 'ok') {
        // Reported, not thrown: the pages already written stay written, the summary says how far the
        // run got beside what stopped it, and the next run continues from the page that failed.
        if (start > resumeFrom) await this.saveImportCursor(id, start);
        stoppedBecause = describeFailure(page);
        break;
      }

      scanned += page.data.received;
      const attributed = attributeToAgent(page.data.records, agentId, sharedUnderAnotherAgentId.length > 0);
      unattributed += attributed.unattributed;
      const written = await this.writePage(id, target.currencyCode, attributed.mine, sameTree);
      created += written.created;
      existing += written.existing;
      heldElsewhere += written.heldElsewhere;
      for (const slug of written.heldBy) heldBy.add(slug);

      if (page.data.received < pageSize) {
        // The end of the listing: nothing is left to resume.
        await this.cache.del(importPlayersCursorKey(id));
        break;
      }
      if (!(await this.locks.extend(handle, IMPORT_LOCK_TTL_MS))) {
        // Another run may hold the lock by now; writing on beside it would race it for no gain.
        await this.saveImportCursor(id, start + pageSize);
        stoppedBecause = importLeaseLostMessage(scanned);
        break;
      }
    }

    const reasons = [
      stoppedBecause,
      unattributed > 0 ? importUnattributedMessage(unattributed, sharedUnderAnotherAgentId) : null,
      heldElsewhere > 0 ? importHeldElsewhereMessage(heldElsewhere, [...heldBy].sort()) : null,
    ].filter((reason): reason is string => reason !== null);
    return { scanned, created, existing, error: reasons.length > 0 ? reasons.join(' ') : null };
  }

  /** The offset a previous run stopped at, or null. A cursor that cannot be read means "from 0". */
  private async readImportCursor(id: string): Promise<number | null> {
    try {
      const cursor = await this.cache.get<number>(importPlayersCursorKey(id));
      return typeof cursor === 'number' && Number.isSafeInteger(cursor) && cursor > 0 ? cursor : null;
    } catch (error: unknown) {
      this.logger.warn(`Tenant ${id}: the import cursor could not be read: ${describeError(error)}`);
      return null;
    }
  }

  /** Best effort: losing the cursor only makes the next run start again from 0. */
  private async saveImportCursor(id: string, start: number): Promise<void> {
    try {
      await this.cache.set(importPlayersCursorKey(id), start, IMPORT_CURSOR_TTL_SECONDS);
    } catch (error: unknown) {
      this.logger.warn(`Tenant ${id}: the import cursor was not saved: ${describeError(error)}`);
    }
  }

  /**
   * One page, idempotently. A record whose Ichancy id or login (matched case-insensitively, as the
   * player lookup does) this operator already holds is `existing`. The rest are inserted with `skipDuplicates`, so an
   * import racing /start or another writer counts the loser as existing instead of failing, and an
   * email another player of this operator already holds is skipped rather than overwritten.
   *
   * A record that an operator in `sameTree` (same login, same agent id) already holds, by Ichancy id
   * or login, is neither: it is left out and counted in `heldElsewhere`, because a second ACTIVE row
   * for one Ichancy account would let two operators' books credit one wallet. Two such imports
   * running at the same moment can still both write one record (their locks are per operator); the
   * next run of either reports it.
   */
  private async writePage(
    id: string,
    currencyCode: string,
    records: readonly AgentPlayerRecord[],
    sameTree: readonly { id: string; slug: string }[],
  ): Promise<{ created: number; existing: number; heldElsewhere: number; heldBy: string[] }> {
    if (records.length === 0) return { created: 0, existing: 0, heldElsewhere: 0, heldBy: [] };

    const known = await this.prisma.player.findMany({
      where: {
        tenantId: id,
        OR: [
          { ichancyPlayerId: { in: records.map((record) => record.ichancyPlayerId) } },
          {
            ichancyLogin: {
              in: records.map((record) => record.login),
              mode: 'insensitive',
            },
          },
        ],
      },
      select: { ichancyPlayerId: true, ichancyLogin: true },
    });
    const knownIds = new Set(known.map((player) => player.ichancyPlayerId));
    const knownLogins = new Set(known.map((player) => player.ichancyLogin?.toLowerCase()));

    let existing = 0;
    const unknown: AgentPlayerRecord[] = [];
    for (const record of records) {
      const login = record.login.toLowerCase();
      if (knownIds.has(record.ichancyPlayerId) || knownLogins.has(login)) {
        existing += 1;
        continue;
      }
      // The same account twice in one page is still one account.
      knownIds.add(record.ichancyPlayerId);
      knownLogins.add(login);
      unknown.push(record);
    }

    const elsewhere = await this.heldBySameTree(unknown, sameTree);
    const fresh = unknown.filter(
      (record) =>
        !elsewhere.ids.has(record.ichancyPlayerId) && !elsewhere.logins.has(record.login.toLowerCase()),
    );
    const heldElsewhere = unknown.length - fresh.length;
    const heldBy = [...elsewhere.slugs];
    if (fresh.length === 0) return { created: 0, existing, heldElsewhere, heldBy };

    const now = new Date();
    const inserted = await this.prisma.player.createMany({
      data: fresh.map((record) => ({
        tenantId: id,
        telegramUserId: null,
        source: PlayerSource.ICHANCY_IMPORT,
        // The account exists and is linked: nothing is pending at Ichancy for it.
        status: PlayerStatus.ACTIVE,
        currencyCode,
        ichancyPlayerId: record.ichancyPlayerId,
        ichancyLogin: record.login,
        ichancyEmail: record.email,
        ichancyRegisteredAt: now,
      })),
      skipDuplicates: true,
    });
    return {
      created: inserted.count,
      existing: existing + (fresh.length - inserted.count),
      heldElsewhere,
      heldBy,
    };
  }

  /**
   * Which of `records` an operator in `sameTree` already holds (by Ichancy id, or login matched
   * case-insensitively), and which operators. Nothing to ask when no other operator reads this tree.
   */
  private async heldBySameTree(
    records: readonly AgentPlayerRecord[],
    sameTree: readonly { id: string; slug: string }[],
  ): Promise<{ ids: Set<string | null>; logins: Set<string>; slugs: Set<string> }> {
    const none = { ids: new Set<string | null>(), logins: new Set<string>(), slugs: new Set<string>() };
    if (records.length === 0 || sameTree.length === 0) return none;

    const slugOf = new Map(sameTree.map((operator) => [operator.id, operator.slug]));
    // Cross-operator ON PURPOSE, and bounded to the operators on this exact login and agent id: the
    // question is precisely whether one of them already holds the account.
    const held = await this.prisma.player.findMany({
      where: acrossTenants<Prisma.PlayerWhereInput>({
        tenantId: { in: [...slugOf.keys()] },
        OR: [
          { ichancyPlayerId: { in: records.map((record) => record.ichancyPlayerId) } },
          { ichancyLogin: { in: records.map((record) => record.login), mode: 'insensitive' } },
        ],
      }),
      select: { tenantId: true, ichancyPlayerId: true, ichancyLogin: true },
    });
    for (const player of held) {
      none.ids.add(player.ichancyPlayerId);
      if (player.ichancyLogin !== null) none.logins.add(player.ichancyLogin.toLowerCase());
      const slug = slugOf.get(player.tenantId);
      if (slug !== undefined) none.slugs.add(slug);
    }
    return none;
  }

  /** Best effort, like every summary row: the rows are the result, this is only its receipt. */
  private async recordImport(actorAdminId: string, id: string, counts: ImportCounts): Promise<void> {
    try {
      await this.prisma.runInTransaction((tx) =>
        runWithTenant(id, () =>
          this.audit.write(tx, {
            action: TenantAuditActions.TENANT_PLAYERS_IMPORTED,
            actor: adminActor(actorAdminId),
            subjectType: TENANT_SUBJECT,
            subjectId: id,
            after: {
              scanned: counts.scanned,
              created: counts.created,
              existing: counts.existing,
              stoppedByError: counts.error !== null,
            },
            metadata: { adapter: this.adapterName() },
          }),
        ),
      );
    } catch (error: unknown) {
      this.logger.error(`Tenant ${id}: the import summary was not recorded: ${describeError(error)}`);
    }
  }

  // ── health ──────────────────────────────────────────────────────────────────────────────────

  /**
   * The Ichancy half of GET /:id/health (dashboard tenantIchancyHealthSchema). `sharesAgentWith` is
   * computed on every call (it is one read of the tenants table); the check itself is cached for
   * ICHANCY_HEALTH_CACHE_SECONDS, see there.
   *
   * The check reads the agent wallet with the operator's agent. It signs in only when no session for
   * exactly these credentials exists (a new or never-activated operator, or one whose password was
   * changed at another operator sharing the login), so a serving operator's health costs one wallet
   * read and rotates nothing. Either way `ok: true` means these exact credentials obtained the session
   * the float was read with.
   */
  async health(target: IchancyHealthTarget): Promise<TenantIchancyHealthView> {
    const sharesAgentWith = await this.operatorsOnAgent(
      ichancyAgentKey(target.ichancyBaseUrl, target.ichancyUsername),
      target.id,
    );

    const fake = this.config.ichancy.fake;
    const notChecked = (reason: string): TenantIchancyHealthView =>
      ichancyHealthNotChecked({
        baseUrl: target.ichancyBaseUrl,
        username: target.ichancyUsername,
        agentId: target.ichancyAgentId,
        sharesAgentWith,
        reason,
        fake,
        checkedAt: new Date(),
      });

    if (target.id === TENANT_ZERO_ID) return notChecked(PLATFORM_HAS_NO_AGENT_MESSAGE);

    // Under ICHANCY_FAKE the adapter is not asked at all: its wallet is a made-up float, and `ok: true`
    // beside it was read as a real connection. Nothing is cached either, so a restart into real mode
    // never serves a fixture's answer.
    if (fake) return notChecked(ICHANCY_FAKE_MODE_MESSAGE);

    const check = await this.cache.getOrSet<IchancyCheck>(
      ichancyHealthCacheKey(target.id),
      ICHANCY_HEALTH_CACHE_SECONDS,
      () => this.checkAgent(target),
    );

    return {
      ok: check.ok,
      fake: false,
      baseUrl: target.ichancyBaseUrl,
      username: target.ichancyUsername,
      agentId: target.ichancyAgentId,
      checkedAt: check.checkedAt,
      error: check.error,
      floatMinor: check.floatMinor,
      belowWatermark: check.belowWatermark,
      sharesAgentWith,
    };
  }

  private async checkAgent(target: IchancyHealthTarget): Promise<IchancyCheck> {
    const wallet = await runWithTenant(target.id, () =>
      this.withSignInFallback(() =>
        this.ichancy.getAgentWallet({ correlationId: HEALTH_CORRELATION }),
      ),
    );
    const checkedAt = new Date().toISOString();

    if (wallet.kind !== 'ok') {
      // No float was read, so there is nothing to compare: `belowWatermark: false` means "no
      // comparison was possible" here (TENANT-OPERATIONS.md §6, detail 3), never "healthy".
      return {
        ok: false,
        checkedAt,
        error: describeFailure(wallet),
        floatMinor: null,
        belowWatermark: false,
      };
    }

    // `availableWallet`, as the float sync compares: what an approval is actually drawn against.
    const available = wallet.data.availableMinor;
    return {
      ok: true,
      checkedAt,
      error: null,
      floatMinor: available.toString(),
      belowWatermark: available < target.agentFloatLowWatermarkMinor,
    };
  }

  // ── shared ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Runs `read`; when it failed only because this process has no session for these exact
   * credentials, proves them with one real sign-in and runs it once more. MUST run inside the
   * operator's context.
   */
  private async withSignInFallback<T>(
    read: () => Promise<IchancyResult<T>>,
  ): Promise<IchancyResult<T>> {
    const first = await read();
    if (first.kind !== 'rejected' || !CURED_BY_SIGN_IN.has(first.code)) return first;

    const proof = await this.ichancy.signIn();
    if (proof.kind === 'rejected') return ichancyRejected(proof.code, proof.message);
    if (proof.kind === 'ambiguous') return ichancyAmbiguous(proof.cause);
    return read();
  }

  /**
   * Slugs of the operators whose login is this agent key, other than `excludeId`, sorted. Matched on
   * the normalised base URL and username, NOT on the agent id: the session belongs to the login
   * (TENANT-OPERATIONS.md §6, detail 1). `Tenant` is not tenant-scoped, so this sees every operator.
   */
  private async operatorsOnAgent(agentKey: string, excludeId: string): Promise<string[]> {
    return (await this.operatorsSharingLogin(agentKey, excludeId)).map((operator) => operator.slug);
  }

  /** operatorsOnAgent with each operator's agent id, which the import needs to tell trees apart. */
  private async operatorsSharingLogin(
    agentKey: string,
    excludeId: string,
  ): Promise<{ id: string; slug: string; agentId: string }[]> {
    const rows = await this.prisma.tenant.findMany({
      where: { id: { not: excludeId } },
      select: { id: true, slug: true, ichancyBaseUrl: true, ichancyUsername: true, ichancyAgentId: true },
      orderBy: { slug: 'asc' },
    });
    return rows
      .filter((row) => ichancyAgentKey(row.ichancyBaseUrl, row.ichancyUsername) === agentKey)
      .map((row) => ({ id: row.id, slug: row.slug, agentId: row.ichancyAgentId }));
  }

  private async forgetHealth(id: string): Promise<void> {
    await this.cache.del(ichancyHealthCacheKey(id));
  }

  private adapterName(): 'fake' | 'real' {
    return this.config.ichancy.fake ? 'fake' : 'real';
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One sentence for a failed Ichancy result, with its code when it has one. */
function describeFailure(result: { kind: 'rejected'; code: string; message: string } | { kind: 'ambiguous'; cause: string }): string {
  return result.kind === 'rejected' ? `${result.code}: ${result.message}` : result.cause;
}

/**
 * The records of a page that belong to this operator. With the login to itself (`shared` false) that
 * is every record: the signed-in login's tree is the operator's. With another operator on the login
 * under another agent id, only a record naming this agent id as its parent is; one naming none is
 * counted as unattributed and left out. See the file header.
 */
function attributeToAgent(
  records: readonly AgentPlayerRecord[],
  agentId: string,
  shared: boolean,
): { mine: AgentPlayerRecord[]; unattributed: number } {
  if (!shared) return { mine: [...records], unattributed: 0 };
  const mine: AgentPlayerRecord[] = [];
  let unattributed = 0;
  for (const record of records) {
    if (record.parentId === null) unattributed += 1;
    else if (record.parentId === agentId) mine.push(record);
    // A record naming another agent id is that operator's player: neither ours nor a gap to report.
  }
  return { mine, unattributed };
}

/** A username, agent id or base URL that only occupies its column. */
function isInert(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length === 0 || isTenantSecretSentinel(trimmed);
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

/** The URL's origin (scheme, case-folded host, non-default port), or null when it does not parse. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Whether two base URLs name the same host a password may be sent to. A URL that does not parse
 * matches nothing, not even itself: an unreadable stored host is no proof of where a password went.
 */
function sameOrigin(a: string, b: string): boolean {
  const left = originOf(a);
  return left !== null && left === originOf(b);
}

/** A failed sign-in as the refusal the console shows verbatim. `tail` says what did not happen. */
function signInRefusal(
  result: { kind: 'rejected'; code: string; message: string } | { kind: 'ambiguous'; cause: string },
  tail: string,
): AppException {
  if (result.kind === 'ambiguous') {
    return new ServiceUnavailableError(
      TenantErrorCodes.TENANT_ICHANCY_UNAVAILABLE,
      `Ichancy did not answer the sign-in, so the credentials could not be verified (${result.cause}). ` +
        `${tail} Try again in a moment.`,
    );
  }
  if (UNCONFIGURED_CODES.has(result.code)) {
    return ichancyUnconfigured(`${result.message} ${tail}`);
  }
  if (result.code === TRANSPORT_ORIGIN_UNSUPPORTED_CODE) {
    return new BusinessRuleError(
      TenantErrorCodes.ICHANCY_SIGNIN_FAILED,
      `This deployment cannot reach the operator's Ichancy host: ${result.message} ${tail}`,
    );
  }
  return new BusinessRuleError(
    TenantErrorCodes.ICHANCY_SIGNIN_FAILED,
    `Ichancy refused the sign-in with these credentials (${result.code}: ${result.message}). ${tail}`,
  );
}

function ichancyUnconfigured(message: string): BusinessRuleError {
  return new BusinessRuleError(TenantErrorCodes.TENANT_ICHANCY_UNCONFIGURED, message);
}

function agentHasPlayers(players: number): BusinessRuleError {
  // The dashboard mock's sentence, and `details.players` so the dialog can say how many.
  return new BusinessRuleError(
    TenantErrorCodes.TENANT_AGENT_HAS_PLAYERS,
    'This operator has linked players, so its Ichancy agent id cannot be changed.',
    { players },
  );
}

function tenantClosed(): BusinessRuleError {
  return new BusinessRuleError(
    TenantErrorCodes.TENANT_CLOSED,
    'This operator is closed. A closed operator keeps its records but cannot be suspended or activated.',
  );
}

function platformLocked(): BusinessRuleError {
  return new BusinessRuleError(TenantErrorCodes.TENANT_PLATFORM_LOCKED, PLATFORM_HAS_NO_AGENT_MESSAGE);
}
