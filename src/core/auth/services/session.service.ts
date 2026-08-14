/**
 * WHY two token types with different storage: an access JWT is fast to check (no IO) but cannot be
 * withdrawn once issued; a refresh token can be revoked but costs a database round trip. Using only
 * JWTs would mean a stolen token stays valid for its full lifetime; using only opaque tokens would
 * put a query on every request. So: a 15-minute stateless access token, and a long-lived opaque
 * refresh token that is a row we control.
 *
 * Three things here are deliberate and load-bearing:
 *
 *  1. ONLY THE sha256 OF THE REFRESH TOKEN IS STORED. A database dump — or a backup, or a leaked
 *     read replica — must not be replayable as a set of live sessions.
 *
 *  2. REFRESH ROTATES, AND REUSE IS TREATED AS THEFT. When a rotated token is presented a second
 *     time there are only two explanations: a client bug, or an attacker replaying a token the real
 *     user has already rotated past. We cannot tell them apart, so we kill every session for that
 *     player. Logging everyone out is a bad afternoon; leaving an attacker with a live session on a
 *     cashier account is a bad quarter.
 *
 *  3. REVOCATION IS PUBLISHED TO REDIS, NOT CHECKED IN POSTGRES. The guard needs "is this session
 *     still valid?" on every request. A tombstone with a TTL equal to the access token's lifetime
 *     answers it in one O(1) Redis call, and after that TTL the token has expired on its own — so
 *     the tombstone is never needed again and does not accumulate.
 */
import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { UnauthorizedError } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';
import { type AuthenticatedAdmin } from '@common/decorators/auth.types';
import { AppConfigService } from '../../config/config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LockService } from '../../cache/lock.service';
import { RedisService } from '../../cache/redis.service';
import {
  INIT_DATA_NONCE_TTL_SECONDS,
  REFRESH_TOKEN_BYTES,
  initDataNonceKey,
  sessionRevocationKey,
  ttlToSeconds,
} from '../auth.constants';
import {
  PLAYER_ROLE,
  type AccessTokenClaims,
  type IssuedSession,
  type SessionContext,
  type TokenRole,
} from '../auth.types';

/**
 * `player_sessions.ip` is an INET column: handing it "unknown" or a comma-joined
 * X-Forwarded-For list makes Postgres reject the INSERT with 22P02 and the login fails for a
 * reason that has nothing to do with authentication. Anything unrecognisable becomes null.
 */
function sanitizeIp(ip: string | null | undefined): string | null {
  if (typeof ip !== 'string') return null;
  const first = ip.split(',')[0]?.trim();
  if (first === undefined || first.length === 0) return null;
  const candidate = first.startsWith('::ffff:') ? first.slice(7) : first;
  const isIpv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(candidate);
  const isIpv6 = /^[0-9a-f:]+$/i.test(first) && first.includes(':');
  if (isIpv4) {
    return candidate.split('.').every((part) => Number(part) <= 255) ? candidate : null;
  }
  return isIpv6 ? first : null;
}

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly accessTtlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
    private readonly redis: RedisService,
    private readonly locks: LockService,
  ) {
    this.accessTtlSeconds = ttlToSeconds(config.jwt.accessTtl);
  }

  /**
   * Burns an initData hash so the same one can never mint a second session.
   *
   * A valid signature is replayable for as long as `auth_date` stays fresh; without this, an
   * initData captured from a proxy log is a 5-minute skeleton key. Callers MUST call this after
   * InitDataService.verify() and before issuing anything.
   *
   * Consequence for clients: re-posting the same initData is an error by design. A client that
   * needs a new access token uses `refresh()`, not a second login.
   */
  async consumeInitDataNonce(initDataHash: string): Promise<void> {
    const claimed = await this.locks.claimOnce(
      initDataNonceKey(initDataHash),
      INIT_DATA_NONCE_TTL_SECONDS,
    );
    if (!claimed) {
      throw new UnauthorizedError(
        CommonErrorCodes.INIT_DATA_REPLAYED,
        'This Telegram session data has already been used. Please reopen the app.',
      );
    }
  }

  /** Mints a fresh session for an already-resolved player. */
  async issueForPlayer(
    playerId: string,
    telegramUserId: bigint,
    context: SessionContext = {},
  ): Promise<IssuedSession> {
    const refreshToken = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    const refreshTokenExpiresAt = new Date(Date.now() + this.config.jwt.refreshTtlMs);

    const session = await this.prisma.playerSession.create({
      data: {
        playerId,
        refreshTokenHash: sha256Hex(refreshToken),
        expiresAt: refreshTokenExpiresAt,
        ip: sanitizeIp(context.ip),
        userAgent: context.userAgent ?? null,
        telegramAuthDate: context.telegramAuthDate ?? null,
      },
      select: { id: true },
    });

    return this.buildIssuedSession(
      session.id,
      playerId,
      telegramUserId,
      PLAYER_ROLE,
      refreshToken,
      refreshTokenExpiresAt,
    );
  }

  /**
   * Rotates a refresh token. The presented token is dead afterwards, whatever happens.
   */
  async refresh(rawRefreshToken: string, context: SessionContext = {}): Promise<IssuedSession> {
    if (typeof rawRefreshToken !== 'string' || rawRefreshToken.length === 0) {
      throw new UnauthorizedError(
        CommonErrorCodes.REFRESH_TOKEN_INVALID,
        'Refresh token is missing.',
      );
    }

    const presentedHash = sha256Hex(rawRefreshToken);
    const existing = await this.prisma.playerSession.findUnique({
      where: { refreshTokenHash: presentedHash },
      select: {
        id: true,
        playerId: true,
        expiresAt: true,
        revokedAt: true,
        replacedBySessionId: true,
        player: { select: { telegramUserId: true } },
      },
    });

    if (!existing) {
      throw new UnauthorizedError(
        CommonErrorCodes.REFRESH_TOKEN_INVALID,
        'Refresh token is not valid. Please sign in again.',
      );
    }

    // Reuse detection. `replacedBySessionId` being set means this exact token was already rotated,
    // so whoever holds it is one step behind the legitimate client — or is not the legitimate
    // client at all. Both hypotheses end the same way: burn the whole chain.
    if (existing.revokedAt !== null || existing.replacedBySessionId !== null) {
      this.logger.warn(
        `Refresh token reuse detected for player ${existing.playerId} (session ${existing.id}); revoking all sessions`,
      );
      await this.revokeAllForPlayer(existing.playerId);
      throw new UnauthorizedError(
        CommonErrorCodes.REFRESH_TOKEN_REUSED,
        'This session is no longer valid. Please sign in again.',
      );
    }

    if (existing.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedError(
        CommonErrorCodes.REFRESH_TOKEN_INVALID,
        'Your session has expired. Please sign in again.',
      );
    }

    const refreshToken = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    const refreshTokenExpiresAt = new Date(Date.now() + this.config.jwt.refreshTtlMs);

    // One transaction: the old session must never be revoked without its replacement existing, and
    // the replacement must never exist without the old one being closed out.
    const created = await this.prisma.$transaction(async (tx) => {
      const next = await tx.playerSession.create({
        data: {
          playerId: existing.playerId,
          refreshTokenHash: sha256Hex(refreshToken),
          expiresAt: refreshTokenExpiresAt,
          ip: sanitizeIp(context.ip),
          userAgent: context.userAgent ?? null,
          telegramAuthDate: context.telegramAuthDate ?? null,
        },
        select: { id: true },
      });

      // updateMany (not update) so the WHERE can re-assert `replacedBySessionId: null`. That turns
      // the write into a compare-and-swap: two concurrent refreshes presenting the same token
      // cannot both win, because the loser matches zero rows and rolls its new session back.
      const rotated = await tx.playerSession.updateMany({
        where: { id: existing.id, replacedBySessionId: null, revokedAt: null },
        data: { revokedAt: new Date(), replacedBySessionId: next.id },
      });

      if (rotated.count !== 1) {
        throw new UnauthorizedError(
          CommonErrorCodes.REFRESH_TOKEN_REUSED,
          'This session is no longer valid. Please sign in again.',
        );
      }

      return next;
    });

    // The old access token stays cryptographically valid until it expires; the tombstone is what
    // actually stops it being used.
    await this.publishRevocation(existing.id);

    return this.buildIssuedSession(
      created.id,
      existing.playerId,
      existing.player.telegramUserId,
      PLAYER_ROLE,
      refreshToken,
      refreshTokenExpiresAt,
    );
  }

  /** Logout for one device. */
  async revoke(sessionId: string): Promise<void> {
    await this.prisma.playerSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.publishRevocation(sessionId);
  }

  /** Logout everywhere. Used on refresh-token reuse and by admin-forced sign-out. */
  async revokeAllForPlayer(playerId: string): Promise<number> {
    const sessions = await this.prisma.playerSession.findMany({
      where: { playerId, revokedAt: null },
      select: { id: true },
    });

    if (sessions.length === 0) return 0;

    await this.prisma.playerSession.updateMany({
      where: { playerId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // One round trip regardless of how many devices the player had.
    const pipeline = this.redis.pipeline();
    for (const session of sessions) {
      pipeline.set(sessionRevocationKey(session.id), '1', 'EX', this.accessTtlSeconds);
    }
    await pipeline.exec();

    return sessions.length;
  }

  /**
   * Guard hot path: has this session been killed while its access token is still in date?
   * Fails CLOSED on a Redis outage — an unavailable revocation list must not silently re-authorize
   * sessions we have already terminated.
   */
  async isSessionRevoked(sessionId: string): Promise<boolean> {
    try {
      return (await this.redis.exists(sessionRevocationKey(sessionId))) === 1;
    } catch (error: unknown) {
      this.logger.error(
        `Revocation check failed for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return true;
    }
  }

  /**
   * Verifies an access token's signature, expiry and claim shape.
   * `algorithms` is pinned explicitly: without it a token with `"alg":"none"` — or one signed with
   * a different algorithm the library happens to accept — is a complete authentication bypass.
   */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(token, {
        algorithms: ['HS256'],
        secret: this.config.jwt.secret,
      });
    } catch (error: unknown) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TokenExpiredError') {
        throw new UnauthorizedError(
          CommonErrorCodes.TOKEN_EXPIRED,
          'Your session has expired. Please refresh.',
        );
      }
      throw new UnauthorizedError(CommonErrorCodes.INVALID_TOKEN, 'The access token is not valid.');
    }

    // A token can be perfectly signed and still be the wrong shape (an old format after a deploy).
    if (
      typeof claims?.sub !== 'string' ||
      typeof claims.tgid !== 'string' ||
      typeof claims.sid !== 'string' ||
      typeof claims.role !== 'string'
    ) {
      throw new UnauthorizedError(CommonErrorCodes.INVALID_TOKEN, 'The access token is not valid.');
    }

    return claims;
  }

  /**
   * Admins get an access token but no refresh token: they re-authenticate from Telegram initData,
   * which is always available inside the mini-app. That keeps `player_sessions` exclusively about
   * players (an admin is not necessarily a Player row) and means an admin's authority cannot
   * outlive a deactivation by more than the 60s identity cache.
   */
  async issueAdminAccessToken(admin: AuthenticatedAdmin): Promise<{
    accessToken: string;
    accessTokenExpiresAt: Date;
  }> {
    const accessToken = await this.signAccessToken(
      admin.adminUserId,
      admin.telegramUserId,
      admin.role,
      randomUUID(),
    );
    return {
      accessToken,
      accessTokenExpiresAt: new Date(Date.now() + this.accessTtlSeconds * 1_000),
    };
  }

  private async buildIssuedSession(
    sessionId: string,
    subjectId: string,
    telegramUserId: bigint,
    role: TokenRole,
    refreshToken: string,
    refreshTokenExpiresAt: Date,
  ): Promise<IssuedSession> {
    const accessToken = await this.signAccessToken(subjectId, telegramUserId, role, sessionId);
    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: new Date(Date.now() + this.accessTtlSeconds * 1_000),
      refreshTokenExpiresAt,
      sessionId,
    };
  }

  private signAccessToken(
    subjectId: string,
    telegramUserId: bigint,
    role: TokenRole,
    sessionId: string,
  ): Promise<string> {
    // tgid is stringified here and nowhere else: a bigint would throw in JSON.stringify without the
    // global toJSON patch, and a number would round a 64-bit Telegram id.
    return this.jwt.signAsync({
      sub: subjectId,
      tgid: telegramUserId.toString(),
      role,
      sid: sessionId,
    });
  }

  private async publishRevocation(sessionId: string): Promise<void> {
    await this.redis.set(sessionRevocationKey(sessionId), '1', 'EX', this.accessTtlSeconds);
  }
}
