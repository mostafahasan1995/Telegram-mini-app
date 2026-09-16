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
import { LoginCodeService } from '@core/auth/services/login-code.service';
import { SessionService } from '@core/auth/services/session.service';
import { UnauthorizedError } from '@common/exceptions/app.exception';
// Not the '@core/tenant' barrel: it re-exports TENANT_ZERO_ID but not TENANT_BOOTSTRAP_ID.
import { TENANT_BOOTSTRAP_ID } from '@core/tenant/tenant.constants';
import { PlayerErrorCodes } from '../player.constants';
import { initDataNonceKey } from '@core/auth/auth.constants';
import type { IssuedSession, SessionContext } from '@core/auth/auth.types';

import type { AuthTokensView } from '../dtos/auth.dto';
import type { PlayerView } from '../dtos/player.view';
import { PlayerService } from './player.service';
import { ReferralService } from './referral.service';

/**
 * ⚠ INTERIM: ONLY THE BOOTSTRAP OPERATOR'S PLAYERS CAN SIGN IN TO THE MINI APP.
 *
 * WHY NOT requireEffectiveTenantId() HERE, unlike every other service: both sign-in routes are
 * @Public(). They arrive with no bearer token, so TenantContextMiddleware never opened a context
 * and there is nothing ambient to require — the tenant is precisely what signing in establishes.
 *
 * Every operator has its own bot now, and initData is signed with the token of the bot whose web
 * app was opened. But the mini app does not yet say WHICH operator it was opened for, and the API
 * contract has not decided how it will (a tenant hint in the request, a per-operator origin, ...).
 * Until that is decided, sign-in is pinned to the bootstrap operator: InitDataService checks the
 * signature against THAT operator's sealed bot token, and a player of any other operator gets
 * INIT_DATA_HASH_INVALID, because their initData was signed by a different bot. That is a known,
 * deliberate gap for a later step, not a bug to paper over by trying every operator's token (which
 * would turn one signature check into a search across operators).
 */
const SIGN_IN_TENANT_ID = TENANT_BOOTSTRAP_ID;

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
    private readonly codes: LoginCodeService,
    private readonly sessions: SessionService,
    private readonly players: PlayerService,
    private readonly referrals: ReferralService,
    private readonly audit: AuditService,
    private readonly locks: LockService,
    private readonly config: AppConfigService,
  ) {}

  async loginWithInitData(rawInitData: string, context: SessionContext): Promise<LoginResult> {
    // 1 — authenticate, against the bot of the operator sign-in is pinned to (see SIGN_IN_TENANT_ID).
    const verified = await this.initData.verify(rawInitData, SIGN_IN_TENANT_ID);

    // 2 — one initData, one login.
    await this.sessions.consumeInitDataNonce(verified.hash);

    try {
      // 3 — player row + audit, atomically.
      const { player, playerId, tenantId, isNew } = await this.prisma.runInTransaction(
        async (tx) => {
          const upserted = await this.players.upsertFromTelegram(
            tx,
            SIGN_IN_TENANT_ID,
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
        },
      );

      // 4 — session. The session belongs to the operator the PLAYER ROW does — `tenantId` read back
      // off the upsert, not the SIGN_IN_TENANT_ID we guessed going in. A returning player keeps the
      // operator they registered with, and a session in a different tenant than its player is a
      // token whose `tid` claim would point every later request at somebody else's data.
      const issued = await this.sessions.issueForPlayer(tenantId, playerId, verified.user.id, {
        ...context,
        telegramAuthDate: verified.authDate,
      });

      // Best effort, after the session exists. A referral is worth nothing next to a login.
      const referral = await this.captureReferral(
        tenantId,
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

  /**
   * Sign in with a one-time code the bot sent the player in a direct chat.
   *
   * WHY THIS EXISTS ALONGSIDE initData: initData is signed by the Telegram webview and a native
   * Android/iOS binary cannot produce it. The bot, though, already knows who is talking to it, so a
   * code minted there carries that proof to the app. Same mechanism the staff console uses, in a
   * separate Redis scope so neither code type can be redeemed on the other's route.
   *
   * WHY THERE IS NO upsertFromTelegram HERE, unlike the initData path: the code can only have been
   * minted inside a bot chat, and the bot's own handler calls `ensurePlayerRow` before it will mint
   * one. So the Player row provably exists by the time a code can be presented. Finding nothing
   * therefore means the row was deleted between minting and redeeming, which is a refusal and not a
   * reason to quietly create an account from an id we cannot see profile fields for.
   *
   * WHY NO REFERRAL CAPTURE: referrals arrive as a `start_param` on the first /start, which has
   * already happened by the time this player can run /login. Re-binding here would let somebody
   * re-attribute an existing account by signing in again.
   */
  async loginWithBotCode(rawCode: string, context: SessionContext): Promise<LoginResult> {
    const telegramUserId = await this.codes.redeem('player', rawCode);
    if (telegramUserId === null) {
      throw new UnauthorizedError(
        PlayerErrorCodes.BOT_CODE_INVALID,
        'That code is not valid. Send /login to the bot for a new one.',
      );
    }

    const row = await this.prisma.player.findUnique({
      where: { tenantId_telegramUserId: { tenantId: SIGN_IN_TENANT_ID, telegramUserId } },
      // `tenantId` is selected so the session below is stamped with the ROW's operator rather than
      // the constant we searched with. They are the same value today; they stop being the same the
      // moment a second bot exists, and this line is what keeps this code correct on that day.
      select: { id: true, tenantId: true },
    });
    if (row === null) {
      throw new UnauthorizedError(
        PlayerErrorCodes.BOT_CODE_INVALID,
        'That code is not valid. Send /login to the bot for a new one.',
      );
    }
    const playerId = row.id;

    await this.prisma.runInTransaction(async (tx) => {
      await this.audit.write(tx, {
        action: 'player.login',
        actor: { type: 'PLAYER', id: playerId },
        subjectType: 'Player',
        subjectId: playerId,
        after: { method: 'bot-code' },
      });
    });

    const player = await this.players.getOwnView(playerId);
    const issued = await this.sessions.issueForPlayer(
      row.tenantId,
      playerId,
      telegramUserId,
      context,
    );

    return {
      player,
      tokens: this.toTokensView(issued),
      // A bot code can only be minted for a player row that already exists, so this sign-in is by
      // definition never the one that created the account.
      isNewPlayer: false,
      referral: 'IGNORED_NO_PAYLOAD',
    };
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
    tenantId: string,
    playerId: string,
    telegramUserId: bigint,
    startParam: string | null,
  ): Promise<string> {
    if (startParam === null) return 'IGNORED_NO_PAYLOAD';
    try {
      const result = await this.referrals.bindFromStartPayload(
        // The referred player's operator: a `ref_<telegram id>` payload must only ever resolve to
        // a referrer standing in the same tenant as the player being attributed.
        tenantId,
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
