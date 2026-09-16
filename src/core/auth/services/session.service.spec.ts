/**
 * Access-token shape rules for the two principals.
 *
 * The property under test: an ADMIN token identifies its admin by (tid, sub) and needs no Telegram
 * id — a console-only admin has none — while a PLAYER token still must carry one. Signing and
 * verification use a real JwtService, because "the claim is absent from the signed payload" is only
 * provable by decoding what was actually signed.
 */
import { JwtService } from '@nestjs/jwt';
import { AdminRole } from '@prisma/client';

import { UnauthorizedError } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';
import type { AuthenticatedAdmin } from '@common/decorators/auth.types';

import type { LockService } from '../../cache/lock.service';
import type { RedisService } from '../../cache/redis.service';
import type { AppConfigService } from '../../config/config.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { PLAYER_ROLE } from '../auth.types';
import { SessionService } from './session.service';

const SECRET = 'unit-test-secret-at-least-32-characters-long';
const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const ADMIN_ID = '7d5e2a8c-3b1f-4c6d-9e0a-1f2b3c4d5e6f';

function build(): { sessions: SessionService; jwt: JwtService } {
  const jwt = new JwtService({ secret: SECRET, signOptions: { algorithm: 'HS256', expiresIn: 900 } });
  // Only `jwt` is read on the paths exercised here; the rest are never touched.
  const config = { jwt: { secret: SECRET, accessTtl: '15m', refreshTtlMs: 60_000 } };
  const sessions = new SessionService(
    {} as PrismaService,
    jwt,
    config as unknown as AppConfigService,
    {} as RedisService,
    {} as LockService,
  );
  return { sessions, jwt };
}

async function expectInvalid(promise: Promise<unknown>): Promise<void> {
  const error: unknown = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(UnauthorizedError);
  expect((error as UnauthorizedError).errorCode).toBe(CommonErrorCodes.INVALID_TOKEN);
}

describe('SessionService access tokens', () => {
  describe('admin tokens', () => {
    const consoleOnlyAdmin: AuthenticatedAdmin = {
      adminUserId: ADMIN_ID,
      telegramUserId: null,
      tenantId: TENANT_ID,
      role: AdminRole.PLATFORM_ADMIN,
      displayName: 'Console only',
    };

    it('signs (tid, sub = adminUserId) and NO tgid for an admin without a Telegram id', async () => {
      const { sessions, jwt } = build();

      const { accessToken } = await sessions.issueAdminAccessToken(consoleOnlyAdmin);
      const payload = jwt.decode<Record<string, unknown>>(accessToken);

      expect(payload).toMatchObject({ sub: ADMIN_ID, tid: TENANT_ID, role: 'PLATFORM_ADMIN' });
      expect(typeof payload['sid']).toBe('string');
      expect(payload).not.toHaveProperty('tgid');
    });

    it('signs no tgid even when the admin HAS a Telegram id — identity is the row', async () => {
      const { sessions, jwt } = build();

      const { accessToken } = await sessions.issueAdminAccessToken({
        ...consoleOnlyAdmin,
        role: AdminRole.SUPER_ADMIN,
        telegramUserId: 7_123_456_789_012_345n,
      });

      expect(jwt.decode<Record<string, unknown>>(accessToken)).not.toHaveProperty('tgid');
    });

    it('verifies an admin token that carries no tgid', async () => {
      const { sessions } = build();
      const { accessToken } = await sessions.issueAdminAccessToken(consoleOnlyAdmin);

      const claims = await sessions.verifyAccessToken(accessToken);

      expect(claims).toMatchObject({ sub: ADMIN_ID, tid: TENANT_ID, role: 'PLATFORM_ADMIN' });
      expect(claims.tgid).toBeUndefined();
    });

    it('still verifies an older admin token that carries a tgid', async () => {
      const { sessions, jwt } = build();
      const legacy = await jwt.signAsync({
        sub: ADMIN_ID,
        tgid: '912911246',
        role: 'SUPER_ADMIN',
        sid: 'legacy-sid',
        tid: TENANT_ID,
      });

      await expect(sessions.verifyAccessToken(legacy)).resolves.toMatchObject({ sub: ADMIN_ID });
    });

    it('rejects an admin token whose tgid is present but not a decimal id', async () => {
      const { sessions, jwt } = build();
      for (const tgid of [123, 'abc', '', null]) {
        const token = await jwt.signAsync({
          sub: ADMIN_ID,
          tgid,
          role: 'SUPER_ADMIN',
          sid: 's',
          tid: TENANT_ID,
        });
        await expectInvalid(sessions.verifyAccessToken(token));
      }
    });

    it('rejects an admin token with no tid or no sub', async () => {
      const { sessions, jwt } = build();
      const noTid = await jwt.signAsync({ sub: ADMIN_ID, role: 'SUPER_ADMIN', sid: 's' });
      const emptySub = await jwt.signAsync({ sub: '', role: 'SUPER_ADMIN', sid: 's', tid: TENANT_ID });

      await expectInvalid(sessions.verifyAccessToken(noTid));
      await expectInvalid(sessions.verifyAccessToken(emptySub));
    });
  });

  describe('player tokens', () => {
    it('still requires a tgid', async () => {
      const { sessions, jwt } = build();
      const token = await jwt.signAsync({
        sub: 'player-1',
        role: PLAYER_ROLE,
        sid: 'session-1',
        tid: TENANT_ID,
      });

      await expectInvalid(sessions.verifyAccessToken(token));
    });

    it('requires the tgid to be a decimal id, so the guard never hits a BigInt SyntaxError', async () => {
      const { sessions, jwt } = build();
      const token = await jwt.signAsync({
        sub: 'player-1',
        tgid: '12ab',
        role: PLAYER_ROLE,
        sid: 'session-1',
        tid: TENANT_ID,
      });

      await expectInvalid(sessions.verifyAccessToken(token));
    });

    it('accepts a well-formed player token', async () => {
      const { sessions, jwt } = build();
      const token = await jwt.signAsync({
        sub: 'player-1',
        tgid: '7123456789012345',
        role: PLAYER_ROLE,
        sid: 'session-1',
        tid: TENANT_ID,
      });

      await expect(sessions.verifyAccessToken(token)).resolves.toMatchObject({
        role: PLAYER_ROLE,
        tgid: '7123456789012345',
      });
    });
  });

  it('rejects a token signed with another secret', async () => {
    const { sessions } = build();
    const forged = await new JwtService({ secret: 'a-completely-different-secret-value!!' }).signAsync(
      { sub: ADMIN_ID, role: 'PLATFORM_ADMIN', sid: 's', tid: TENANT_ID },
    );

    await expectInvalid(sessions.verifyAccessToken(forged));
  });
});
