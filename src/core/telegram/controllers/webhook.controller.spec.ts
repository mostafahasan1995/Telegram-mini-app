/**
 * The parts of the webhook ingress a database cannot show: every authentication path opens exactly
 * one secret and runs one comparison, whether or not the path token names an operator; and a stopped
 * operator or a broken secret is logged once rather than once per update. The integration spec
 * beside this file covers the real rows, the dedupe and the job payload.
 */
import { Logger } from '@nestjs/common';
import { TenantStatus } from '@prisma/client';
import { type Queue } from 'bullmq';
import { type Update } from 'grammy/types';

import { AppException } from '@common/exceptions/app.exception';

import {
  type TenantRegistryService,
  type TenantSummary,
  type TenantWebhookRoute,
} from '../../tenant/services/tenant-registry.service';
import { TenantSecretService } from '../../tenant/services/tenant-secret.service';
import { type UpdateDedupeService } from '../services/update-dedupe.service';
import { type TelegramUpdateJobData } from '../telegram.types';
import { TelegramWebhookController } from './webhook.controller';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const PATH_TOKEN = 'path_token_for_unit_spec_0123456789';
const SECRET = 'the-real-webhook-secret';

const update = (updateId: number): Update =>
  ({ update_id: updateId, message: { text: 'hi' } }) as unknown as Update;

const summary = (status: TenantStatus): TenantSummary => ({
  id: TENANT_ID,
  slug: 'unit',
  displayName: 'Unit',
  status,
  currencyCode: 'NSP',
});

describe('TelegramWebhookController', () => {
  let secrets: TenantSecretService;
  let findByWebhookPathToken: jest.Mock<Promise<TenantWebhookRoute | null>, [string]>;
  let find: jest.Mock<Promise<TenantSummary | null>, [string]>;
  let record: jest.Mock;
  let rollback: jest.Mock;
  let add: jest.Mock;
  let controller: TelegramWebhookController;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  const route = (webhookSecretEnc: string | null): TenantWebhookRoute => ({
    tenantId: TENANT_ID,
    webhookSecretEnc,
  });

  const refused = async (call: Promise<unknown>): Promise<AppException> => {
    const outcome = await call.then(
      () => null,
      (thrown: unknown) => thrown,
    );
    if (!(outcome instanceof AppException)) throw new Error('expected a refusal');
    return outcome;
  };

  beforeEach(() => {
    secrets = new TenantSecretService('unit_spec_root_secret_0123456789');
    findByWebhookPathToken = jest.fn();
    find = jest.fn().mockResolvedValue(summary(TenantStatus.ACTIVE));
    record = jest.fn().mockResolvedValue({ isNew: true, id: 'row-1' });
    rollback = jest.fn().mockResolvedValue(undefined);
    add = jest.fn().mockResolvedValue(undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    controller = new TelegramWebhookController(
      { findByWebhookPathToken, find } as unknown as TenantRegistryService,
      secrets,
      { record, rollback } as unknown as UpdateDedupeService,
      { add } as unknown as Queue<TelegramUpdateJobData>,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('equal work on every authentication path', () => {
    it('opens the decoy once for an unknown token and refuses', async () => {
      findByWebhookPathToken.mockResolvedValue(null);
      const open = jest.spyOn(secrets, 'openWebhookSecret');

      const refusal = await refused(controller.receive('unknown_token_0001', SECRET, update(1)));

      expect(refusal.httpStatus).toBe(403);
      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0]?.[0].id).toBe('webhook-decoy');
      expect(find).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it("opens the operator's own secret once for a known token", async () => {
      findByWebhookPathToken.mockResolvedValue(route(secrets.sealWebhookSecret(SECRET)));
      const open = jest.spyOn(secrets, 'openWebhookSecret');

      await expect(controller.receive(PATH_TOKEN, SECRET, update(1))).resolves.toEqual({
        ok: true,
      });

      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0]?.[0].id).toBe(TENANT_ID);
    });

    it('falls back to the decoy when the stored secret cannot be opened, and refuses', async () => {
      findByWebhookPathToken.mockResolvedValue(route('v1.not.a.real-envelope'));

      const refusal = await refused(controller.receive(PATH_TOKEN, SECRET, update(1)));

      expect(refusal.httpStatus).toBe(403);
      expect(record).not.toHaveBeenCalled();
    });

    it('gives the unknown-token, wrong-secret and unset-secret refusals the same code and message', async () => {
      findByWebhookPathToken.mockResolvedValueOnce(null);
      const unknown = await refused(controller.receive('unknown_token_0001', SECRET, update(1)));

      findByWebhookPathToken.mockResolvedValueOnce(route(secrets.sealWebhookSecret(SECRET)));
      const wrong = await refused(controller.receive(PATH_TOKEN, 'wrong', update(2)));

      findByWebhookPathToken.mockResolvedValueOnce(route(null));
      const unset = await refused(controller.receive(PATH_TOKEN, SECRET, update(3)));

      for (const refusal of [unknown, wrong, unset]) {
        expect([refusal.httpStatus, refusal.errorCode, refusal.message]).toEqual([
          wrong.httpStatus,
          wrong.errorCode,
          wrong.message,
        ]);
      }
    });

    it('refuses when the route outlived a deleted operator', async () => {
      findByWebhookPathToken.mockResolvedValue(route(secrets.sealWebhookSecret(SECRET)));
      find.mockResolvedValue(null);

      const refusal = await refused(controller.receive(PATH_TOKEN, SECRET, update(1)));
      expect(refusal.httpStatus).toBe(403);
    });
  });

  describe('logging once', () => {
    beforeEach(() => {
      findByWebhookPathToken.mockResolvedValue(route(secrets.sealWebhookSecret(SECRET)));
    });

    it('logs a suspended operator once per status, and again after it served in between', async () => {
      find.mockResolvedValue(summary(TenantStatus.SUSPENDED));
      await controller.receive(PATH_TOKEN, SECRET, update(1));
      await controller.receive(PATH_TOKEN, SECRET, update(2));
      expect(warn).toHaveBeenCalledTimes(1);

      find.mockResolvedValue(summary(TenantStatus.CLOSED));
      await controller.receive(PATH_TOKEN, SECRET, update(3));
      expect(warn).toHaveBeenCalledTimes(2);

      find.mockResolvedValue(summary(TenantStatus.ACTIVE));
      await controller.receive(PATH_TOKEN, SECRET, update(4));
      find.mockResolvedValue(summary(TenantStatus.CLOSED));
      await controller.receive(PATH_TOKEN, SECRET, update(5));
      expect(warn).toHaveBeenCalledTimes(3);
      expect(record).toHaveBeenCalledTimes(1);
    });

    it('logs an unset secret once, without the path token or any secret in the line', async () => {
      findByWebhookPathToken.mockResolvedValue(route(null));

      await refused(controller.receive(PATH_TOKEN, SECRET, update(1)));
      await refused(controller.receive(PATH_TOKEN, SECRET, update(2)));

      expect(error).toHaveBeenCalledTimes(1);
      const line = String(error.mock.calls[0]?.[0]);
      expect(line).toContain(TENANT_ID);
      expect(line).not.toContain(PATH_TOKEN);
      expect(line).not.toContain(SECRET);
    });
  });

  describe('enqueue', () => {
    beforeEach(() => {
      findByWebhookPathToken.mockResolvedValue(route(secrets.sealWebhookSecret(SECRET)));
    });

    it('tags the job with the tenant and a tenant-scoped job id', async () => {
      await controller.receive(PATH_TOKEN, SECRET, update(77));

      expect(record).toHaveBeenCalledWith(TENANT_ID, update(77));
      expect(add).toHaveBeenCalledWith(
        'process-update',
        { tenantId: TENANT_ID, updateRowId: 'row-1', updateId: '77', update: update(77) },
        expect.objectContaining({ jobId: `tg-${TENANT_ID}-77` }),
      );
    });

    it("rolls back the tenant's record and rethrows when the enqueue fails", async () => {
      add.mockRejectedValue(new Error('queue down'));

      await expect(controller.receive(PATH_TOKEN, SECRET, update(78))).rejects.toThrow(
        'queue down',
      );
      expect(rollback).toHaveBeenCalledWith(TENANT_ID, 'row-1', 78);
    });
  });
});
