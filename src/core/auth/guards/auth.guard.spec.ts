/**
 * AuthGuard's admin branch: the admin is the row named by (tid, sub), and a Telegram id — present
 * or not — plays no part in deciding who the caller is.
 *
 * Tokens are signed and verified for real (JwtService + SessionService); only the identity lookup
 * is a stub, so each test can see exactly which door the guard knocked on.
 */
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AdminRole } from '@prisma/client';

import { ForbiddenError, UnauthorizedError } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';
import {
  REQUEST_ADMIN_KEY,
  REQUEST_PLAYER_KEY,
  type AuthenticatedAdmin,
  type RequestPrincipals,
} from '@common/decorators/auth.types';

import type { LockService } from '../../cache/lock.service';
import type { RedisService } from '../../cache/redis.service';
import type { AppConfigService } from '../../config/config.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { PLAYER_ROLE } from '../auth.types';
import type { AdminIdentityService } from '../services/admin-identity.service';
import { SessionService } from '../services/session.service';
import { AuthGuard } from './auth.guard';

const SECRET = 'unit-test-secret-at-least-32-characters-long';
const HOME_TENANT = '00000000-0000-0000-0000-000000000000';
const ADMIN_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';

interface FakeRequest extends RequestPrincipals {
  headers: Record<string, string>;
}

const ADMIN: AuthenticatedAdmin = {
  adminUserId: ADMIN_ID,
  telegramUserId: null,
  tenantId: HOME_TENANT,
  role: AdminRole.PLATFORM_ADMIN,
  displayName: 'Platform owner',
};

function contextFor(request: FakeRequest): ExecutionContext {
  const handler = (): void => undefined;
  class Controller {}
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => Controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function build(resolved: AuthenticatedAdmin | null): {
  guard: AuthGuard;
  jwt: JwtService;
  sessions: SessionService;
  resolveById: jest.Mock;
  resolveByTelegram: jest.Mock;
  isSessionRevoked: jest.Mock;
} {
  const jwt = new JwtService({ secret: SECRET, signOptions: { algorithm: 'HS256', expiresIn: 900 } });
  const config = { jwt: { secret: SECRET, accessTtl: '15m', refreshTtlMs: 60_000 } };
  const isSessionRevoked = jest.fn().mockResolvedValue(false);
  const redis = { exists: isSessionRevoked } as unknown as RedisService;
  const sessions = new SessionService(
    {} as PrismaService,
    jwt,
    config as unknown as AppConfigService,
    redis,
    {} as LockService,
  );

  const resolveById = jest.fn().mockResolvedValue(resolved);
  const resolveByTelegram = jest.fn().mockResolvedValue(resolved);
  const admins = { resolveById, resolveByTelegram } as unknown as AdminIdentityService;

  return {
    guard: new AuthGuard(new Reflector(), sessions, admins),
    jwt,
    sessions,
    resolveById,
    resolveByTelegram,
    isSessionRevoked,
  };
}

const bearer = (token: string): FakeRequest => ({ headers: { authorization: `Bearer ${token}` } });

describe('AuthGuard', () => {
  it('resolves an admin token without tgid by (tid, sub) and attaches the principal', async () => {
    const { guard, sessions, resolveById, resolveByTelegram } = build(ADMIN);
    const { accessToken } = await sessions.issueAdminAccessToken(ADMIN);
    const request = bearer(accessToken);

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

    expect(resolveById).toHaveBeenCalledTimes(1);
    expect(resolveById).toHaveBeenCalledWith(HOME_TENANT, ADMIN_ID);
    expect(resolveByTelegram).not.toHaveBeenCalled();
    expect(request[REQUEST_ADMIN_KEY]).toEqual(ADMIN);
    expect(request[REQUEST_PLAYER_KEY]).toBeUndefined();
  });

  it('ignores a tgid in an older admin token: identity still comes from sub', async () => {
    const { guard, jwt, resolveById, resolveByTelegram } = build(ADMIN);
    const legacy = await jwt.signAsync({
      sub: ADMIN_ID,
      tgid: '912911246',
      role: 'SUPER_ADMIN',
      sid: 'legacy',
      tid: HOME_TENANT,
    });

    await expect(guard.canActivate(contextFor(bearer(legacy)))).resolves.toBe(true);

    expect(resolveById).toHaveBeenCalledWith(HOME_TENANT, ADMIN_ID);
    expect(resolveByTelegram).not.toHaveBeenCalled();
  });

  it('answers 403 ADMIN_INACTIVE when (tid, sub) resolves to nobody', async () => {
    const { guard, sessions } = build(null);
    const { accessToken } = await sessions.issueAdminAccessToken(ADMIN);
    const request = bearer(accessToken);

    const error: unknown = await guard
      .canActivate(contextFor(request))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).errorCode).toBe(CommonErrorCodes.ADMIN_INACTIVE);
    expect(request[REQUEST_ADMIN_KEY]).toBeUndefined();
  });

  it('never resolves identity in a tenant named by a header', async () => {
    const { guard, sessions, resolveById } = build(ADMIN);
    const { accessToken } = await sessions.issueAdminAccessToken(ADMIN);
    const request = bearer(accessToken);
    request.headers['x-tenant-id'] = '00000000-0000-0000-0000-000000000001';

    await guard.canActivate(contextFor(request));

    expect(resolveById).toHaveBeenCalledWith(HOME_TENANT, ADMIN_ID);
  });

  it('still attaches a player principal from a player token', async () => {
    const { guard, jwt, resolveById } = build(null);
    const token = await jwt.signAsync({
      sub: 'player-1',
      tgid: '7123456789012345',
      role: PLAYER_ROLE,
      sid: 'session-1',
      tid: HOME_TENANT,
    });
    const request = bearer(token);

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

    expect(request[REQUEST_PLAYER_KEY]).toEqual({
      playerId: 'player-1',
      telegramUserId: 7_123_456_789_012_345n,
      sessionId: 'session-1',
    });
    expect(resolveById).not.toHaveBeenCalled();
  });

  it('rejects a player token without tgid before any lookup', async () => {
    const { guard, jwt, resolveById, isSessionRevoked } = build(null);
    const token = await jwt.signAsync({
      sub: 'player-1',
      role: PLAYER_ROLE,
      sid: 'session-1',
      tid: HOME_TENANT,
    });

    const error: unknown = await guard
      .canActivate(contextFor(bearer(token)))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnauthorizedError);
    expect((error as UnauthorizedError).errorCode).toBe(CommonErrorCodes.INVALID_TOKEN);
    expect(resolveById).not.toHaveBeenCalled();
    expect(isSessionRevoked).not.toHaveBeenCalled();
  });
});
