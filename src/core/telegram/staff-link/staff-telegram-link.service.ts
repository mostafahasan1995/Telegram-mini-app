/**
 * Linking a staff account to the Telegram account that works it (owner decision 4, 2026-09-15).
 *
 * Deposit cards in the staff group are acted on by whoever taps them, checked by the TAPPER's Telegram
 * id (AdminIdentityService.resolveByTelegram), never by the chat. Staff accounts are username and
 * password logins and carry no Telegram id, so without a verified link nobody could act in the group.
 *
 * ══ THE FLOW ═════════════════════════════════════════════════════════════════════════════════════
 *  1. The console asks for a code for one staff account (issue). A short code is shown once; only its
 *     keyed digest is stored, it works once, for STAFF_LINK_CODE_TTL_MINUTES, and a new code for the
 *     same account revokes the previous one, so at most one is live per account.
 *  2. The staff member sends `/link <code>` to the operator's bot in a private chat. The webhook has
 *     already replaced the code with its digest (staff-link-code.util). The update processor hands the
 *     update here before grammY (handleUpdate), for an ACTIVE or a SUSPENDED operator.
 *  3. In one transaction under the staff row's lock: the code must be this operator's (looked up by
 *     operator AND digest, and the operator is inside the digest), unused, unrevoked and unexpired; the
 *     account active and not linked; and the sender's Telegram id not already on another staff account
 *     of this operator. Then the code is used up, `from.id` is written, and the link is audited.
 *  4. After the commit: the cached identity for that Telegram id is evicted (a negative answer may be
 *     cached from an earlier tap), the chat is told, and the admin command menu is pushed.
 *
 * ══ WHY THE SENDER IS TRUSTED ════════════════════════════════════════════════════════════════════
 * `from.id` comes from an update that reached the webhook with this operator's secret, so Telegram says
 * who sent it. The code proves the console session: whoever holds it was shown it by the console. Both
 * together are the link. Nothing a client sends over HTTP can set the Telegram id; the staff directory
 * still refuses the field on create and update.
 *
 * ══ WHAT A REFUSAL SAYS ══════════════════════════════════════════════════════════════════════════
 * Unknown, expired, used and revoked codes all get the same answer in the chat, so a guess learns
 * nothing. A code of this operator that did not link is audited with the true reason; an unknown code
 * has no account to audit against and is only logged, and every attempt counts against the sender's
 * limit (STAFF_LINK_ATTEMPTS_PER_WINDOW). A code posted in a group is revoked, because everyone there
 * has read it.
 *
 * NEVER THE CODE OR ITS DIGEST in a log line, an audit row or an error.
 */
import { Injectable, Logger } from '@nestjs/common';
import { TenantStatus, type AdminUser } from '@prisma/client';
import type { Message, Update } from 'grammy/types';

import { SYSTEM_ACTOR, adminActor, type Actor } from '@common/types/actor.type';
import { AuditService } from '@core/audit/audit.service';
import { AdminIdentityService } from '@core/auth/services/admin-identity.service';
import { RedisService } from '@core/cache/redis.service';
import { isUniqueConstraintError, mapPrismaError } from '@core/prisma/prisma-errors';
import { PrismaService } from '@core/prisma/prisma.service';
import type { Tx } from '@core/prisma/tx.type';
import { TenantSecretService } from '@core/tenant/services/tenant-secret.service';
import { TENANT_ZERO_ID } from '@core/tenant/tenant.constants';
import { runWithTenant } from '@core/tenant/tenant.storage';

import { BotService } from '../services/bot.service';
import { TenantBotSetupService } from '../services/tenant-bot-setup.service';
import {
  formatStaffLinkCode,
  newStaffLinkCode,
  staffLinkCommandOf,
  type StaffLinkCommand,
} from '../utils/staff-link-code.util';

import {
  STAFF_LINK_ATTEMPTS_PER_WINDOW,
  STAFF_LINK_ATTEMPT_WINDOW_SECONDS,
  STAFF_LINK_CODE_TTL_MINUTES,
  STAFF_TELEGRAM_LINK_AUDIT_SUBJECT,
  StaffTelegramLinkAuditActions,
  staffLinkAttemptCountedKey,
  staffLinkAttemptsKey,
} from './staff-link.constants';

/** How many times issuing retries after a digest collision. One is already vanishingly unlikely. */
const ISSUE_ATTEMPTS = 3;

/**
 * KEYS[1] the sender's attempt counter, KEYS[2] this update's counted marker, ARGV[1] the window in
 * seconds. Returns the counter after this update: incremented (with the window started on the first
 * attempt) the first time the update is seen, read unchanged on a retry. See withinAttemptLimit.
 */
const COUNT_ATTEMPT_ONCE_SCRIPT = `
if redis.call('SET', KEYS[2], '1', 'EX', ARGV[1], 'NX') then
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
  return count
end
return tonumber(redis.call('GET', KEYS[1]) or '0')
`;

export interface StaffLinkActorInput {
  tenantId: string;
  adminUserId: string;
  actor: Actor;
}

export type StaffLinkIssueOutcome =
  | {
      kind: 'issued';
      /** Grouped for reading, `ABCD-EFGH`. Shown once to the console; stored nowhere. */
      code: string;
      expiresAt: Date;
      botUsername: string | null;
      admin: AdminUser;
    }
  | { kind: 'not-found' }
  /** Tenant zero is the platform: it has no bot to send a code to. */
  | { kind: 'platform' }
  | { kind: 'closed' }
  /** The operator's agent principal, whose Telegram id is the reserved 0: never a person. */
  | { kind: 'reserved-id' }
  | { kind: 'inactive' }
  | { kind: 'already-linked'; admin: AdminUser };

export type StaffUnlinkOutcome =
  | {
      kind: 'unlinked';
      changed: boolean;
      admin: AdminUser;
      codesRevoked: number;
      /** The Telegram id that was removed, or null when there was none. */
      previousTelegramUserId: bigint | null;
    }
  | { kind: 'not-found' }
  | { kind: 'reserved-id' };

/** Why a `/link` did or did not link. Recorded on the audit row and in the log. */
export type StaffLinkAttemptResult =
  | 'LINKED'
  | 'ALREADY_LINKED_TO_SENDER'
  | 'CODE_UNKNOWN'
  | 'CODE_EXPIRED'
  | 'CODE_USED'
  | 'CODE_REVOKED'
  | 'ACCOUNT_INACTIVE'
  | 'ACCOUNT_ALREADY_LINKED'
  | 'TELEGRAM_ALREADY_LINKED'
  | 'CODE_EXPOSED'
  | 'NO_CODE'
  /** A `/link` in an edited message, in a private chat: answered, never redeemed. */
  | 'EDITED'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'IGNORED';

export interface StaffLinkUpdateResult {
  /** The update was a `/link` for this bot: grammY must not see it. */
  consumed: boolean;
  result: StaffLinkAttemptResult | null;
}

const NOT_A_LINK: StaffLinkUpdateResult = { consumed: false, result: null };

/** What the transaction decided, and what the chat is told afterwards. */
type RedeemDecision =
  | { result: 'LINKED'; admin: AdminUser; operatorName: string }
  | { result: 'ALREADY_LINKED_TO_SENDER'; admin: AdminUser }
  | {
      result: Exclude<StaffLinkAttemptResult, 'LINKED' | 'ALREADY_LINKED_TO_SENDER'>;
    };

/** One answer for every code that is not usable, so a guess learns nothing. Arabic first. */
const CODE_NOT_VALID =
  'هذا الرمز غير صالح أو انتهت صلاحيته. اطلب رمزاً جديداً من لوحة التحكم وأرسل /link متبوعاً بالرمز.\n' +
  'This code is not valid or has expired. Get a new code from the console and send /link followed by the code.';

const REPLIES: Readonly<Record<Exclude<StaffLinkAttemptResult, 'LINKED' | 'ALREADY_LINKED_TO_SENDER' | 'IGNORED'>, string>> = {
  CODE_UNKNOWN: CODE_NOT_VALID,
  CODE_EXPIRED: CODE_NOT_VALID,
  CODE_USED: CODE_NOT_VALID,
  CODE_REVOKED: CODE_NOT_VALID,
  ACCOUNT_INACTIVE: CODE_NOT_VALID,
  ACCOUNT_ALREADY_LINKED: CODE_NOT_VALID,
  TELEGRAM_ALREADY_LINKED:
    'حساب تيليغرام هذا مربوط بالفعل بحساب موظف آخر لدى هذا المشغّل. ألغِ ربطه من لوحة التحكم أولاً، أو أرسل الرمز من حساب تيليغرام الخاص بصاحب الرمز.\n' +
    'This Telegram account is already linked to another staff account of this operator. Unlink it in the console first, or send the code from the Telegram account of the person it is for.',
  CODE_EXPOSED:
    '⚠️ لا تنشر رمز الربط في مجموعة أبداً. إذا كان رمزاً حقيقياً فقد أُلغي. اطلب رمزاً جديداً من لوحة التحكم وأرسله إليّ في محادثة خاصة.\n' +
    'Never post a link code in a group. If it was a real code, it no longer works. Get a new code from the console and send it to me in a private chat.',
  NO_CODE:
    'أرسل /link متبوعاً بالرمز الظاهر في لوحة التحكم، مثل: /link ABCD-EFGH\n' +
    'Send /link followed by the code shown in the console, for example: /link ABCD-EFGH',
  EDITED:
    'لا أقرأ الرسائل المعدّلة. أرسل /link متبوعاً بالرمز في رسالة جديدة، مثل: /link ABCD-EFGH\n' +
    'Edited messages are not read. Send /link followed by the code as a new message, for example: /link ABCD-EFGH',
  RATE_LIMITED:
    'محاولات كثيرة جداً. انتظر 15 دقيقة ثم حاول مرة أخرى.\n' +
    'Too many attempts. Wait 15 minutes, then try again.',
  UNAVAILABLE:
    'تعذّر ربط الحساب الآن. حاول مرة أخرى بعد قليل.\nLinking is not available right now. Try again shortly.',
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A stored Telegram id that can never be a person: Telegram numbers users from 1 (the agent principal holds 0). */
const isReservedTelegramId = (telegramUserId: bigint | null): boolean =>
  telegramUserId !== null && telegramUserId <= 0n;

@Injectable()
export class StaffTelegramLinkService {
  private readonly logger = new Logger(StaffTelegramLinkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly identities: AdminIdentityService,
    private readonly redis: RedisService,
    private readonly secrets: TenantSecretService,
    private readonly bot: BotService,
    private readonly setup: TenantBotSetupService,
  ) {}

  // ── the console ────────────────────────────────────────────────────────────────────────────────

  /**
   * A fresh code for one staff account of `tenantId`. The CALLER decides who may ask (the staff member
   * for themselves, or a platform admin); this decides whether the account can be linked at all.
   */
  async issue(input: StaffLinkActorInput): Promise<StaffLinkIssueOutcome> {
    const { tenantId } = input;
    if (tenantId === TENANT_ZERO_ID) return { kind: 'platform' };
    const operator = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true, botUsername: true },
    });
    if (operator === null) return { kind: 'not-found' };
    // The webhook drops a CLOSED operator's updates, so its code could never be redeemed.
    if (operator.status === TenantStatus.CLOSED) return { kind: 'closed' };

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.issueOnce(input, operator.botUsername);
      } catch (error: unknown) {
        // Only a digest that already exists is retried, with a new code. Anything else is real.
        const mapped = mapPrismaError(error, { model: 'AdminTelegramLinkCode', operation: 'create' });
        if (!isUniqueConstraintError(mapped) || attempt >= ISSUE_ATTEMPTS) throw error;
      }
    }
  }

  private async issueOnce(
    input: StaffLinkActorInput,
    botUsername: string | null,
  ): Promise<StaffLinkIssueOutcome> {
    const { tenantId, adminUserId } = input;
    const code = newStaffLinkCode();
    const codeDigest = this.secrets.staffLinkCodeDigest(tenantId, code);
    const expiresAt = new Date(Date.now() + STAFF_LINK_CODE_TTL_MINUTES * 60_000);

    return runWithTenant(tenantId, () =>
      this.prisma.runInTransaction(async (tx): Promise<StaffLinkIssueOutcome> => {
        const admin = await this.lockAdmin(tx, tenantId, adminUserId);
        if (admin === null) return { kind: 'not-found' };
        if (isReservedTelegramId(admin.telegramUserId)) return { kind: 'reserved-id' };
        if (!admin.isActive) return { kind: 'inactive' };
        if (admin.telegramUserId !== null) return { kind: 'already-linked', admin };

        const now = new Date();
        const revoked = await tx.adminTelegramLinkCode.updateMany({
          where: { tenantId, adminUserId, usedAt: null, revokedAt: null },
          data: { revokedAt: now },
        });
        const row = await tx.adminTelegramLinkCode.create({
          data: {
            tenantId,
            adminUserId,
            codeDigest,
            issuedByAdminId: input.actor.id ?? adminUserId,
            expiresAt,
          },
          select: { id: true },
        });
        await this.audit.write(tx, {
          action: StaffTelegramLinkAuditActions.CODE_ISSUED,
          actor: input.actor,
          subjectType: STAFF_TELEGRAM_LINK_AUDIT_SUBJECT,
          subjectId: adminUserId,
          after: { codeId: row.id, expiresAt: expiresAt.toISOString() },
          metadata: { previousCodesRevoked: revoked.count },
        });

        return { kind: 'issued', code: formatStaffLinkCode(code), expiresAt, botUsername, admin };
      }),
    );
  }

  /**
   * Removes the account's Telegram link and revokes any live code for it. Idempotent: an account with
   * no link answers `changed: false`. The CALLER decides who may ask.
   */
  async unlink(input: StaffLinkActorInput): Promise<StaffUnlinkOutcome> {
    const { tenantId, adminUserId } = input;

    const outcome = await runWithTenant(tenantId, () =>
      this.prisma.runInTransaction(async (tx): Promise<StaffUnlinkOutcome> => {
        const admin = await this.lockAdmin(tx, tenantId, adminUserId);
        if (admin === null) return { kind: 'not-found' };
        // The agent principal's reserved 0 is how its sign-in finds it again; it is not a link.
        if (isReservedTelegramId(admin.telegramUserId)) return { kind: 'reserved-id' };

        const revoked = await tx.adminTelegramLinkCode.updateMany({
          where: { tenantId, adminUserId, usedAt: null, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        if (admin.telegramUserId === null) {
          return {
            kind: 'unlinked',
            changed: false,
            admin,
            codesRevoked: revoked.count,
            previousTelegramUserId: null,
          };
        }

        const updated = await tx.adminUser.update({
          where: { id: adminUserId, tenantId },
          data: { telegramUserId: null },
        });
        await this.audit.write(tx, {
          action: StaffTelegramLinkAuditActions.UNLINKED,
          actor: input.actor,
          subjectType: STAFF_TELEGRAM_LINK_AUDIT_SUBJECT,
          subjectId: adminUserId,
          before: { telegramUserId: admin.telegramUserId.toString() },
          after: { telegramUserId: null },
          metadata: { codesRevoked: revoked.count },
        });
        return {
          kind: 'unlinked',
          changed: true,
          admin: updated,
          codesRevoked: revoked.count,
          previousTelegramUserId: admin.telegramUserId,
        };
      }),
    );

    if (outcome.kind === 'unlinked' && outcome.previousTelegramUserId !== null) {
      // The OLD Telegram id, which the bot would otherwise keep resolving for up to a minute.
      await this.identities.invalidate({
        tenantId,
        adminUserId,
        telegramUserId: outcome.previousTelegramUserId,
      });
    }
    return outcome;
  }

  // ── the bot ────────────────────────────────────────────────────────────────────────────────────

  /**
   * A `/link` update of `tenantId`'s bot. MUST be given the tenant the authenticated webhook resolved,
   * never one read off the update. Returns `consumed: false` for anything that is not a `/link` for this
   * bot. Database failures are thrown so the update job retries; everything the chat is told is best
   * effort.
   */
  async handleUpdate(tenantId: string, update: Update): Promise<StaffLinkUpdateResult> {
    // An edit is read only to be answered (or, in a group, to void the code it exposed), never redeemed:
    // a command is a new message, as for every other bot command. The webhook redacted it all the same
    // (staff-link-code.util, EDITS TOO).
    const edited = update.message === undefined && update.edited_message !== undefined;
    const message: Message | undefined = update.message ?? update.edited_message;
    const command = staffLinkCommandOf(message);
    if (message === undefined || command === null) return NOT_A_LINK;
    if (!(await this.addressedToThisBot(tenantId, command))) return NOT_A_LINK;

    const from = message.from;
    // A channel post or another bot: nobody to link, and nothing for grammY either.
    if (from === undefined || from.is_bot) return { consumed: true, result: 'IGNORED' };
    const sender = BigInt(from.id);

    const allowed = await this.withinAttemptLimit(tenantId, sender, update.update_id);
    if (allowed === 'unavailable' || allowed === 'over') {
      if (allowed === 'unavailable') await this.say(tenantId, message, REPLIES.UNAVAILABLE);
      return { consumed: true, result: allowed === 'over' ? 'RATE_LIMITED' : 'UNAVAILABLE' };
    }
    if (allowed === 'just-over') {
      this.logger.warn(`Tenant ${tenantId}: Telegram user ${sender} hit the /link attempt limit`);
      await this.say(tenantId, message, REPLIES.RATE_LIMITED);
      return { consumed: true, result: 'RATE_LIMITED' };
    }

    if (message.chat.type !== 'private') {
      if (command.digest === null) return { consumed: true, result: 'IGNORED' };
      await this.revokeExposed(tenantId, command.digest, sender, message);
      await this.say(tenantId, message, REPLIES.CODE_EXPOSED);
      return { consumed: true, result: 'CODE_EXPOSED' };
    }

    if (edited) {
      await this.say(tenantId, message, REPLIES.EDITED);
      return { consumed: true, result: 'EDITED' };
    }

    if (command.digest === null) {
      await this.say(tenantId, message, REPLIES.NO_CODE);
      return { consumed: true, result: 'NO_CODE' };
    }

    const decision = await this.redeem(tenantId, command.digest, sender, from.username ?? null);
    switch (decision.result) {
      case 'LINKED': {
        await this.identities.invalidate({ tenantId, adminUserId: decision.admin.id, telegramUserId: sender });
        this.logger.log(`Tenant ${tenantId}: staff account ${decision.admin.id} linked to Telegram user ${sender}`);
        await this.say(
          tenantId,
          message,
          `✅ تم ربط حساب تيليغرام هذا بحساب الموظف ${decision.admin.displayName} لدى ${decision.operatorName}. ` +
            'يمكنك الآن التعامل مع بطاقات الإيداع في مجموعة الموظفين حسب صلاحياتك.\n' +
            `This Telegram account is now linked to the staff account ${decision.admin.displayName} of ` +
            `${decision.operatorName}. You can act on deposit cards in the staff group, within your role.`,
        );
        await this.pushMenusQuietly(tenantId);
        break;
      }
      case 'ALREADY_LINKED_TO_SENDER':
        await this.say(
          tenantId,
          message,
          `ℹ️ حساب تيليغرام هذا مربوط بالفعل بحساب ${decision.admin.displayName}. لم يتغير شيء.\n` +
            `This Telegram account is already linked to ${decision.admin.displayName}. Nothing changed.`,
        );
        break;
      case 'IGNORED':
        break;
      default:
        this.logger.warn(`Tenant ${tenantId}: /link from Telegram user ${sender} refused (${decision.result})`);
        await this.say(tenantId, message, REPLIES[decision.result]);
    }
    return { consumed: true, result: decision.result };
  }

  /** Step 3 of the header, in one transaction. Refusals of a known code are audited in it. */
  private async redeem(
    tenantId: string,
    codeDigest: string,
    sender: bigint,
    senderUsername: string | null,
  ): Promise<RedeemDecision> {
    try {
      return await runWithTenant(tenantId, () =>
        this.prisma.runInTransaction(async (tx): Promise<RedeemDecision> => {
          // Pinned to THIS operator: a code another operator issued is unknown here, and its digest
          // differs anyway because the operator is inside it.
          const code = await tx.adminTelegramLinkCode.findFirst({ where: { tenantId, codeDigest } });
          if (code === null) return { result: 'CODE_UNKNOWN' };

          const admin = await this.lockAdmin(tx, tenantId, code.adminUserId);
          const now = new Date();

          const refuse = async (
            result: Exclude<StaffLinkAttemptResult, 'LINKED' | 'ALREADY_LINKED_TO_SENDER'>,
            revoke: boolean,
            detail: Record<string, unknown> = {},
          ): Promise<RedeemDecision> => {
            if (revoke) {
              await tx.adminTelegramLinkCode.updateMany({
                where: { id: code.id, tenantId, usedAt: null, revokedAt: null },
                data: { revokedAt: now },
              });
            }
            await this.audit.write(tx, {
              action: StaffTelegramLinkAuditActions.REFUSED,
              actor: SYSTEM_ACTOR,
              subjectType: STAFF_TELEGRAM_LINK_AUDIT_SUBJECT,
              subjectId: code.adminUserId,
              metadata: {
                reason: result,
                codeId: code.id,
                telegramUserId: sender.toString(),
                telegramUsername: senderUsername,
                codeRevoked: revoke,
                ...detail,
              },
            });
            return { result };
          };

          // The person who already used this code, sending it again, is told it is done.
          if (admin !== null && admin.telegramUserId === sender && admin.isActive) {
            if (code.usedAt === null && code.revokedAt === null) {
              await tx.adminTelegramLinkCode.updateMany({
                where: { id: code.id, tenantId, usedAt: null, revokedAt: null },
                data: { usedAt: now, usedByTelegramUserId: sender },
              });
            }
            return { result: 'ALREADY_LINKED_TO_SENDER', admin };
          }
          if (code.usedAt !== null) return refuse('CODE_USED', false);
          if (code.revokedAt !== null) return refuse('CODE_REVOKED', false);
          if (code.expiresAt.getTime() <= now.getTime()) return refuse('CODE_EXPIRED', false);
          if (admin === null || !admin.isActive) return refuse('ACCOUNT_INACTIVE', true);
          if (admin.telegramUserId !== null) return refuse('ACCOUNT_ALREADY_LINKED', true);

          // The per-operator unique index would refuse this too; asking first gives the chat an answer
          // and the audit row the account that holds the id. The code stays live: the right person may
          // still send it from the right Telegram account.
          const holder = await tx.adminUser.findFirst({
            where: { tenantId, telegramUserId: sender, id: { not: admin.id } },
            select: { id: true },
          });
          if (holder !== null) {
            return refuse('TELEGRAM_ALREADY_LINKED', false, { heldByAdminUserId: holder.id });
          }

          const claimed = await tx.adminTelegramLinkCode.updateMany({
            where: { id: code.id, tenantId, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
            data: { usedAt: now, usedByTelegramUserId: sender },
          });
          if (claimed.count !== 1) return refuse('CODE_USED', false);

          const linked = await tx.adminUser.update({
            where: { id: admin.id, tenantId },
            data: { telegramUserId: sender },
          });
          await this.audit.write(tx, {
            // The staff member themselves: the code proves the console session, the update proves the
            // Telegram account.
            action: StaffTelegramLinkAuditActions.LINKED,
            actor: adminActor(admin.id),
            subjectType: STAFF_TELEGRAM_LINK_AUDIT_SUBJECT,
            subjectId: admin.id,
            before: { telegramUserId: null },
            after: { telegramUserId: sender.toString() },
            metadata: {
              via: 'bot',
              codeId: code.id,
              codeIssuedByAdminId: code.issuedByAdminId,
              telegramUsername: senderUsername,
            },
          });

          const operator = await tx.tenant.findUnique({
            where: { id: tenantId },
            select: { displayName: true },
          });
          return { result: 'LINKED', admin: linked, operatorName: operator?.displayName ?? '' };
        }),
      );
    } catch (error: unknown) {
      // Two staff accounts claiming the same Telegram id at the same moment: the index kept one.
      if (isUniqueConstraintError(mapPrismaError(error, { model: 'AdminUser', operation: 'update' }))) {
        return { result: 'TELEGRAM_ALREADY_LINKED' };
      }
      throw error;
    }
  }

  /** A code posted in a group has been read by everyone there: it must not work any more. */
  private async revokeExposed(
    tenantId: string,
    codeDigest: string,
    sender: bigint,
    message: Message,
  ): Promise<void> {
    await runWithTenant(tenantId, () =>
      this.prisma.runInTransaction(async (tx) => {
        const code = await tx.adminTelegramLinkCode.findFirst({
          where: { tenantId, codeDigest, usedAt: null, revokedAt: null },
          select: { id: true, adminUserId: true },
        });
        if (code === null) return;
        await tx.adminTelegramLinkCode.updateMany({
          where: { id: code.id, tenantId, usedAt: null, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await this.audit.write(tx, {
          action: StaffTelegramLinkAuditActions.REFUSED,
          actor: SYSTEM_ACTOR,
          subjectType: STAFF_TELEGRAM_LINK_AUDIT_SUBJECT,
          subjectId: code.adminUserId,
          metadata: {
            reason: 'CODE_EXPOSED',
            codeId: code.id,
            telegramUserId: sender.toString(),
            chatId: String(message.chat.id),
            codeRevoked: true,
          },
        });
      }),
    );
  }

  /**
   * Counts this attempt, once per update. `just-over` is the first attempt past the limit (the one that
   * is answered); `over` is every later one (answered with silence, so the limit cannot be used to make
   * the bot spam). Redis down is `unavailable`: failing closed, because the limit is what makes a short
   * code safe to accept.
   *
   * WHY ONCE PER UPDATE: a database failure during redemption rethrows, and BullMQ retries the job up to
   * five times. Counting each retry would lock a staff member out for the window because the database
   * blinked. The update is marked counted in the same atomic script that counts it, so a retry reads the
   * count without adding to it, and no crash can land between counting and marking. The same script sets
   * the window's expiry with the first increment, so a counter can never be left without one.
   */
  private async withinAttemptLimit(
    tenantId: string,
    sender: bigint,
    updateId: number,
  ): Promise<'ok' | 'just-over' | 'over' | 'unavailable'> {
    try {
      const reply = await this.redis.eval(
        COUNT_ATTEMPT_ONCE_SCRIPT,
        2,
        staffLinkAttemptsKey(tenantId, sender),
        staffLinkAttemptCountedKey(tenantId, updateId),
        STAFF_LINK_ATTEMPT_WINDOW_SECONDS,
      );
      const count = Number(reply);
      if (!Number.isInteger(count)) throw new Error('the attempt counter answered a non-integer');
      if (count <= STAFF_LINK_ATTEMPTS_PER_WINDOW) return 'ok';
      return count === STAFF_LINK_ATTEMPTS_PER_WINDOW + 1 ? 'just-over' : 'over';
    } catch (error: unknown) {
      this.logger.error(`Tenant ${tenantId}: the /link attempt counter is unavailable: ${describeError(error)}`);
      return 'unavailable';
    }
  }

  /** A command naming no bot is this bot's (it received it); one naming a bot must name this one. */
  private async addressedToThisBot(tenantId: string, command: StaffLinkCommand): Promise<boolean> {
    if (command.mention === null) return true;
    const row = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { botUsername: true },
    });
    const username = row?.botUsername ?? null;
    return username !== null && username.toLowerCase() === command.mention.toLowerCase();
  }

  /** The staff row, locked for the rest of the transaction, in this operator only. */
  private async lockAdmin(tx: Tx, tenantId: string, adminUserId: string): Promise<AdminUser | null> {
    await tx.$queryRaw`SELECT id FROM admin_users WHERE id = ${adminUserId}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE`;
    return tx.adminUser.findFirst({ where: { tenantId, id: adminUserId } });
  }

  /** Plain text, never HTML: display names are typed by people. Never thrown. */
  private async say(tenantId: string, message: Message, text: string): Promise<void> {
    try {
      await this.bot.sendMessage(tenantId, message.chat.id, text, { linkPreview: false });
    } catch (error: unknown) {
      this.logger.warn(
        `Tenant ${tenantId}: could not answer a /link in chat ${message.chat.id}: ${describeError(error)}`,
      );
    }
  }

  /** The newly linked staff member gets the admin command menu in their private chat. Never thrown. */
  private async pushMenusQuietly(tenantId: string): Promise<void> {
    try {
      const result = await this.setup.pushMenus(tenantId);
      if (result.fatalError !== null || result.warnings.length > 0) {
        this.logger.warn(
          `Tenant ${tenantId}: menus after a staff link: ${result.fatalError ?? result.warnings.join('; ')}`,
        );
      }
    } catch (error: unknown) {
      this.logger.warn(`Tenant ${tenantId}: menus were not pushed after a staff link: ${describeError(error)}`);
    }
  }
}
