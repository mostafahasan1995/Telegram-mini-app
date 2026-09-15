/**
 * Who may ask for a staff Telegram link code and who may remove a link, with the link mechanics
 * stubbed. The integration spec (admin-telegram-link.int.spec.ts) runs the same rules over HTTP, the
 * webhook and the bot against real rows.
 */
import type { AdminRole, AdminUser } from '@prisma/client';

import type { AuthenticatedAdmin } from '@common/decorators/auth.types';
import { AppException } from '@common/exceptions/app.exception';
import type {
  StaffLinkIssueOutcome,
  StaffTelegramLinkService,
  StaffUnlinkOutcome,
} from '@core/telegram/staff-link/staff-telegram-link.service';
import { TENANT_ZERO_ID } from '@core/tenant/tenant.constants';
import { runWithTenant } from '@core/tenant/tenant.storage';

import type { AdminUserRepository } from '../repositories/admin-user.repository';

import { AdminTelegramLinkService } from './admin-telegram-link.service';

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const SELF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const principal = (role: AdminRole, tenantId = OPERATOR): AuthenticatedAdmin => ({
  adminUserId: SELF,
  telegramUserId: null,
  tenantId,
  role,
  displayName: 'Actor',
});

const row = (fields: Partial<AdminUser> = {}): AdminUser => ({
  id: OTHER,
  tenantId: OPERATOR,
  telegramUserId: null,
  username: 'staff',
  displayName: 'Staff',
  role: 'REVIEWER',
  isActive: true,
  passwordHash: 'x',
  totpSecretEnc: null,
  lastLoginAt: null,
  createdAt: new Date('2026-09-15T00:00:00Z'),
  updatedAt: new Date('2026-09-15T00:00:00Z'),
  ...fields,
});

const failureOf = async (call: Promise<unknown>): Promise<AppException> => {
  const outcome = await call.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  if (!(outcome instanceof AppException)) throw new Error('expected a refusal');
  return outcome;
};

describe('AdminTelegramLinkService', () => {
  let issue: jest.Mock<Promise<StaffLinkIssueOutcome>, [unknown]>;
  let unlink: jest.Mock<Promise<StaffUnlinkOutcome>, [unknown]>;
  let findByIdInTenant: jest.Mock<Promise<AdminUser | null>, [string, string]>;
  let service: AdminTelegramLinkService;

  const inOperator = <T>(body: () => Promise<T>): Promise<T> => runWithTenant(OPERATOR, body);

  beforeEach(() => {
    issue = jest.fn<Promise<StaffLinkIssueOutcome>, [unknown]>().mockResolvedValue({
      kind: 'issued',
      code: 'ABCD-EFGH',
      expiresAt: new Date('2026-09-15T10:10:00Z'),
      botUsername: 'cashier_bot',
      admin: row(),
    });
    unlink = jest
      .fn<Promise<StaffUnlinkOutcome>, [unknown]>()
      .mockResolvedValue({ kind: 'unlinked', changed: true, admin: row(), codesRevoked: 0, previousTelegramUserId: 5n });
    findByIdInTenant = jest.fn<Promise<AdminUser | null>, [string, string]>().mockResolvedValue(row());
    service = new AdminTelegramLinkService(
      { issue, unlink } as unknown as StaffTelegramLinkService,
      { findByIdInTenant } as unknown as AdminUserRepository,
    );
  });

  describe('issueCode', () => {
    it('gives a staff member a code for their own account, with the command and the bot to send it to', async () => {
      const view = await inOperator(() => service.issueCode(principal('REVIEWER'), SELF));

      expect(issue).toHaveBeenCalledWith({
        tenantId: OPERATOR,
        adminUserId: SELF,
        actor: { type: 'ADMIN', id: SELF },
      });
      expect(view).toEqual({
        adminUserId: SELF,
        code: 'ABCD-EFGH',
        command: '/link ABCD-EFGH',
        expiresAt: '2026-09-15T10:10:00.000Z',
        ttlSeconds: 600,
        botUsername: 'cashier_bot',
        botUrl: 'https://t.me/cashier_bot',
      });
    });

    it.each<AdminRole>(['SUPER_ADMIN', 'FINANCE_ADMIN', 'REVIEWER'])(
      "refuses a %s asking for somebody else's code, before anything is read",
      async (role) => {
        const refusal = await failureOf(inOperator(() => service.issueCode(principal(role), OTHER)));

        expect(refusal.httpStatus).toBe(403);
        expect(refusal.errorCode).toBe('ADMIN_TELEGRAM_LINK_FORBIDDEN');
        expect(issue).not.toHaveBeenCalled();
      },
    );

    it('lets platform staff ask for any staff account of the operator they work in', async () => {
      await inOperator(() => service.issueCode(principal('PLATFORM_ADMIN', TENANT_ZERO_ID), OTHER));
      expect(issue).toHaveBeenCalledWith(expect.objectContaining({ tenantId: OPERATOR, adminUserId: OTHER }));
    });

    it('does not treat a PLATFORM_ADMIN row outside tenant zero as platform staff', async () => {
      const refusal = await failureOf(
        inOperator(() => service.issueCode(principal('PLATFORM_ADMIN', OPERATOR), OTHER)),
      );
      expect(refusal.httpStatus).toBe(403);
    });

    it.each<[StaffLinkIssueOutcome, number, string, unknown]>([
      [{ kind: 'not-found' }, 404, 'ADMIN_NOT_FOUND', undefined],
      [{ kind: 'already-linked', admin: row() }, 409, 'ADMIN_TELEGRAM_ALREADY_LINKED', undefined],
      [{ kind: 'platform' }, 422, 'ADMIN_TELEGRAM_LINK_NOT_ALLOWED', { reason: 'PLATFORM' }],
      [{ kind: 'closed' }, 422, 'ADMIN_TELEGRAM_LINK_NOT_ALLOWED', { reason: 'OPERATOR_CLOSED' }],
      [{ kind: 'reserved-id' }, 422, 'ADMIN_TELEGRAM_LINK_NOT_ALLOWED', { reason: 'AGENT_PRINCIPAL' }],
      [{ kind: 'inactive' }, 422, 'ADMIN_TELEGRAM_LINK_NOT_ALLOWED', { reason: 'INACTIVE' }],
    ])('answers %j with %d %s', async (outcome, status, code, details) => {
      issue.mockResolvedValue(outcome);
      const refusal = await failureOf(inOperator(() => service.issueCode(principal('REVIEWER'), SELF)));

      expect(refusal.httpStatus).toBe(status);
      expect(refusal.errorCode).toBe(code);
      expect(refusal.details).toEqual(details);
    });

    it('gives no bot link when the bot has no known username', async () => {
      issue.mockResolvedValue({
        kind: 'issued',
        code: 'ABCD-EFGH',
        expiresAt: new Date(),
        botUsername: null,
        admin: row(),
      });
      const view = await inOperator(() => service.issueCode(principal('REVIEWER'), SELF));
      expect(view).toMatchObject({ botUsername: null, botUrl: null });
    });
  });

  describe('unlink', () => {
    it('lets a staff member remove their own link without reading anybody else', async () => {
      const view = await inOperator(() => service.unlink(principal('REVIEWER'), SELF));

      expect(findByIdInTenant).not.toHaveBeenCalled();
      expect(unlink).toHaveBeenCalledWith({ tenantId: OPERATOR, adminUserId: SELF, actor: { type: 'ADMIN', id: SELF } });
      expect(view).toMatchObject({ id: OTHER, telegramLinked: false });
    });

    it("refuses a FINANCE_ADMIN removing somebody else's link", async () => {
      const refusal = await failureOf(inOperator(() => service.unlink(principal('FINANCE_ADMIN'), OTHER)));
      expect(refusal.errorCode).toBe('ADMIN_TELEGRAM_LINK_FORBIDDEN');
      expect(unlink).not.toHaveBeenCalled();
    });

    it("lets a SUPER_ADMIN remove a staff member's link in their operator, and 404s one that is not there", async () => {
      await inOperator(() => service.unlink(principal('SUPER_ADMIN'), OTHER));
      expect(findByIdInTenant).toHaveBeenCalledWith(OPERATOR, OTHER);
      expect(unlink).toHaveBeenCalledTimes(1);

      findByIdInTenant.mockResolvedValue(null);
      const refusal = await failureOf(inOperator(() => service.unlink(principal('SUPER_ADMIN'), OTHER)));
      expect(refusal.httpStatus).toBe(404);
    });

    it("refuses a SUPER_ADMIN changing a platform admin's link", async () => {
      findByIdInTenant.mockResolvedValue(row({ role: 'PLATFORM_ADMIN' }));
      const refusal = await failureOf(inOperator(() => service.unlink(principal('SUPER_ADMIN'), OTHER)));
      expect(refusal.errorCode).toBe('ADMIN_TELEGRAM_LINK_FORBIDDEN');
      expect(unlink).not.toHaveBeenCalled();
    });

    it("refuses to touch the agent principal's reserved id", async () => {
      unlink.mockResolvedValue({ kind: 'reserved-id' });
      const refusal = await failureOf(inOperator(() => service.unlink(principal('REVIEWER'), SELF)));
      expect(refusal.details).toEqual({ reason: 'AGENT_PRINCIPAL' });
    });
  });
});
