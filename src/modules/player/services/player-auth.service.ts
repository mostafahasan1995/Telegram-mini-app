/**
 * The mini-app login flow. Order of operations here is security-critical, so it is spelled out:
 *
 *   1. VERIFY the signature. Nothing else may touch the payload first — everything after this line
 *      is authenticated data, everything before it is a string from the internet.
 *   2. BURN the replay nonce. A valid initData stays valid for its whole freshness window, so
 *      without this one capture is a 5-minute skeleton key to somebody's cashier account.
 *   3. UPSERT the player and write the login audit in ONE transaction.
 *   4. ISSUE the session.
 *
 * WHY the nonce is released again when steps 3–4 fail: `consumeInitDataNonce` is one-shot by
 * design, but the client cannot mint a fresh initData on demand — Telegram hands it to the web app
 * once per launch. So a transient database blip during step 3 would otherwise lock the player out
 * until they fully relaunch the app, and support would see "login works on the second try, but only
 * after closing Telegram". Releasing the claim on failure keeps one-shot semantics for SUCCESSFUL
 * logins (the only case a replay could exploit) while making a failed attempt genuinely retryable.
 *
 * WHY referral capture cannot fail the login: `start_param` is marketing metadata. A player who
 * arrives through a broken or malicious deep link must still be able to sign in.
 */
import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '@core/config/config.service';
import { PrismaService } from '@core/prisma/prisma.service';
import { LockService } from '@core/cache/lock.service';
import { AuditService } from '@core/audit/audit.service';
import { InitDataService } from '@core/auth/services/init-data.service';
import { SessionService } from '@core/auth/services/session.service';
import { initDataNonceKey } from '@core/auth/auth.constants';
import type { IssuedSession, SessionContext } from '@core/auth/auth.types';

import type { AuthTokensView } from '../dtos/auth.dto';
import type { PlayerView } from '../dtos/player.view';
import { PlayerService } from './player.service';
import { ReferralService } from './referral.service';

export interface LoginResult {
  player: PlayerView;
  tokens: AuthTokensView;
  isNewPlayer: boolean;
  /** What happened to the `start_param` referral, for observability. Never a failure. */
  referral: string;
}

@Injectable()
export class PlayerAuthService {
  private readonly logger = new Logger(PlayerAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly initData: InitDataService,
    private readonly sessions: SessionService,
    private readonly players: PlayerService,
    private readonly referrals: ReferralService,
    private readonly audit: AuditService,
    private readonly locks: LockService,
    private readonly config: AppConfigService,
  ) {}

  async loginWithInitData(rawInitData: string, context: SessionContext): Promise<LoginResult> {
    // 1 — authenticate.
    const verified = this.initData.verify(rawInitData);

    // 2 — one initData, one login.
    await this.sessions.consumeInitDataNonce(verified.hash);

    try {
      // 3 — player row + audit, atomically.
      const { player, playerId, isNew } = await this.prisma.runInTransaction(async (tx) => {
        const upserted = await this.players.upsertFromTelegram(
          tx,
          {
            telegramUserId: verified.user.id,
            telegramUsername: verified.user.username ?? null,
            firstName: verified.user.firstName,
            lastName: verified.user.lastName ?? null,
            languageCode: verified.user.languageCode ?? null,
          },
          this.config.ichancy.currency,
        );

        await this.audit.write(tx, {
          action: 'player.login',
          actor: { type: 'PLAYER', id: upserted.playerId },
          subjectType: 'Player',
          subjectId: upserted.playerId,
          after: {
            telegramAuthDate: verified.authDate.toISOString(),
            chatType: verified.chatType ?? null,
          },
        });

        return upserted;
      });

      // 4 — session.
      const issued = await this.sessions.issueForPlayer(playerId, verified.user.id, {
        ...context,
        telegramAuthDate: verified.authDate,
      });

      // Best effort, after the session exists. A referral is worth nothing next to a login.
      const referral = await this.captureReferral(
        playerId,
        verified.user.id,
        verified.startParam ?? null,
      );

      return {
        player,
        tokens: this.toTokensView(issued),
        isNewPlayer: isNew,
        referral,
      };
    } catch (error: unknown) {
      // The login did not happen, so the one-shot must not have been spent. Releasing it cannot
      // enable a replay: a replay only pays off when it produces a session, and none was issued.
      await this.locks.releaseClaim(initDataNonceKey(verified.hash)).catch(() => undefined);
      throw error;
    }
  }

  async refresh(rawRefreshToken: string, context: SessionContext): Promise<AuthTokensView> {
    const issued = await this.sessions.refresh(rawRefreshToken, context);
    return this.toTokensView(issued);
  }

  /** Logout for THIS device only. Revoking every session on a logout tap would be a hostile UX. */
  async logout(sessionId: string): Promise<void> {
    await this.sessions.revoke(sessionId);
  }

  private async captureReferral(
    playerId: string,
    telegramUserId: bigint,
    startParam: string | null,
  ): Promise<string> {
    if (startParam === null) return 'IGNORED_NO_PAYLOAD';
    try {
      const result = await this.referrals.bindFromStartPayload(
        playerId,
        telegramUserId,
        startParam,
        'miniapp:start_param',
      );
      return result.outcome;
    } catch (error: unknown) {
      this.logger.warn(
        `Referral capture failed for player ${playerId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 'IGNORED_NO_PAYLOAD';
    }
  }

  private toTokensView(issued: IssuedSession): AuthTokensView {
    return {
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      accessTokenExpiresAt: issued.accessTokenExpiresAt.toISOString(),
      refreshTokenExpiresAt: issued.refreshTokenExpiresAt.toISOString(),
    };
  }
}
