/**
 * WHY: this is where every Ichancy oddity is absorbed so the rest of the app never sees it.
 *
 * The three rules it enforces, in order of how much money they save:
 *  1. ONE replay, ever. A call is attempted once; if (and only if) it comes back token_expired it is
 *     replayed once after a single-flight refresh. There is no other retry anywhere in this file,
 *     because without an idempotency key a second POST of depositToPlayer is a second payout.
 *  2. Unknown is unknown. Timeouts, 5xx, unparseable bodies and unrecognised error strings all come
 *     out as `ambiguous`, which forces the caller into the balance-delta verification path.
 *  3. Nothing is decided from the HTTP status alone (they answer 201 for "unauthorized" and 200 for
 *     failures) — see error-map.ts.
 *
 * Registration gets special treatment: `login` is a natural idempotency key, so an ambiguous or
 * "Duplicate login" registerPlayer is settled by looking the player up instead of guessing. And
 * because registerPlayer answers the NUMBER 1 rather than an id, the lookup happens on success too.
 */
import { Injectable, Logger } from '@nestjs/common';
import { type IchancyOperation } from '@prisma/client';
import { AppConfigService } from '@core/config/config.service';
import {
  minorToCreditWireAmount,
  minorToDebitWireAmount,
  parseWireMoney,
  tryParseWireMoney,
  IchancyMoneyCodecError,
} from './money-codec';
import { IchancyHttpClient, type IchancyAttempt } from './ichancy-http.client';
import { IchancySessionError, IchancySessionService } from './ichancy-session.service';
import {
  type AgentWallet,
  type EnsurePlayerInput,
  type EnsuredPlayer,
  type FoundPlayer,
  type IchancyCallContext,
  type IchancyPort,
  type PlayerBalance,
  type PlayerMoveInput,
  type PlayerMoveOutcome,
} from './ichancy.port';
import {
  ichancyAmbiguous,
  ichancyOk,
  ichancyRejected,
  IchancyRejectionCodes,
  isIchancyOk,
  isIchancyRejected,
  type IchancyResult,
} from './ichancy.types';
import {
  IchancyEndpoint,
  LOGIN_FIELDS,
  MoneyStatus,
  PLAYER_ID_FIELDS,
  readObjectResult,
  readRecords,
  readStringFieldAny,
  type IchancyEndpointName,
  type IchancyEnvelope,
} from './ichancy.wire';

type EnvelopeResult = IchancyResult<IchancyEnvelope | null>;

function sessionFailureCode(error: unknown): string {
  return error instanceof IchancySessionError ? error.code : 'ICHANCY_SESSION_UNAVAILABLE';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

@Injectable()
export class HttpIchancyAdapter implements IchancyPort {
  private readonly logger = new Logger(HttpIchancyAdapter.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly http: IchancyHttpClient,
    private readonly session: IchancySessionService,
  ) {}

  async ensurePlayer(input: EnsurePlayerInput): Promise<IchancyResult<EnsuredPlayer>> {
    const registered = await this.send(
      'REGISTER_PLAYER',
      IchancyEndpoint.REGISTER_PLAYER,
      {
        player: {
          email: input.email,
          password: input.password,
          parentId: this.config.ichancy.agentId,
          login: input.login,
        },
      },
      input.context,
    );

    if (isIchancyRejected(registered)) {
      if (registered.code !== IchancyRejectionCodes.ALREADY_EXISTS) return registered;
      // "Duplicate login"/"Duplicate email" is a success in disguise: the player exists, we just do
      // not know their id yet. This is what makes ensurePlayer idempotent.
      return this.resolveEnsuredPlayer(input, false, `Ichancy said: ${registered.message}`);
    }

    if (!isIchancyOk(registered)) {
      // We do not know whether the account was created. A lookup settles it without any risk: the
      // worst case is that it is not there yet and we stay ambiguous.
      const resolved = await this.resolveEnsuredPlayer(input, false, registered.cause);
      return isIchancyOk(resolved) ? resolved : ichancyAmbiguous(registered.cause);
    }

    // Success. `result` is the number 1 — never the id — so the id always has to be looked up.
    return this.resolveEnsuredPlayer(input, true, 'registerPlayer reported success');
  }

  async getPlayerBalance(
    ichancyPlayerId: string,
    context?: IchancyCallContext,
  ): Promise<IchancyResult<PlayerBalance>> {
    const response = await this.send(
      'GET_PLAYER_BALANCE_BY_ID',
      IchancyEndpoint.GET_PLAYER_BALANCE_BY_ID,
      { playerId: ichancyPlayerId },
      context,
    );
    if (!isIchancyOk(response)) return response;

    const rows = readRecords(response.data?.result);
    const wallet = this.pickWallet(rows);
    if (!wallet) {
      // An empty `result: []` is NOT "balance zero". Treating it as zero would poison a balance-delta
      // verification: b0 would read 0, b1 would read the real balance, and a FAILED credit could look
      // like a successful one. Unknown stays unknown.
      return ichancyAmbiguous(
        `getPlayerBalanceById returned no wallet row for player ${ichancyPlayerId}`,
      );
    }

    try {
      return ichancyOk({ balanceMinor: parseWireMoney(wallet['balance'], 'balance') });
    } catch (error) {
      return ichancyAmbiguous(
        `getPlayerBalanceById returned an undecodable balance for ${ichancyPlayerId}: ${describeError(error)}`,
      );
    }
  }

  async creditPlayer(input: PlayerMoveInput): Promise<IchancyResult<PlayerMoveOutcome>> {
    return this.movePlayerFunds('credit', input);
  }

  async debitPlayer(input: PlayerMoveInput): Promise<IchancyResult<PlayerMoveOutcome>> {
    return this.movePlayerFunds('debit', input);
  }

  async getAgentWallet(context?: IchancyCallContext): Promise<IchancyResult<AgentWallet>> {
    const response = await this.send(
      'GET_AGENT_ALL_WALLETS',
      IchancyEndpoint.GET_AGENT_ALL_WALLETS,
      {},
      context,
    );
    if (!isIchancyOk(response)) return response;

    const rows = readRecords(response.data?.result);
    const wallet = this.pickWallet(rows);
    if (!wallet) {
      return ichancyAmbiguous(
        `getAgentAllWallets returned no ${this.config.ichancy.currency} wallet for the agent`,
      );
    }

    try {
      // Every money field here arrives as a STRING. `availableWallet` is what actually limits a
      // payout; the fallbacks exist because the field set differs between their environments.
      const balanceMinor = parseWireMoney(wallet['balance'], 'balance');
      const availableMinor =
        tryParseWireMoney(wallet['availableWallet']) ??
        tryParseWireMoney(wallet['currentWallet']) ??
        tryParseWireMoney(wallet['availability']);
      if (availableMinor === null) {
        this.logger.warn(
          'Agent wallet has no decodable availableWallet/currentWallet/availability; falling back to balance',
        );
      }
      return ichancyOk({ balanceMinor, availableMinor: availableMinor ?? balanceMinor });
    } catch (error) {
      return ichancyAmbiguous(
        `getAgentAllWallets returned an undecodable wallet: ${describeError(error)}`,
      );
    }
  }

  async findPlayerByLogin(
    login: string,
    context?: IchancyCallContext,
  ): Promise<IchancyResult<FoundPlayer | null>> {
    const response = await this.send(
      'GET_PLAYERS_FOR_CURRENT_AGENT',
      IchancyEndpoint.GET_PLAYERS_FOR_CURRENT_AGENT,
      {
        start: 0,
        limit: 20,
        filter: { userName: { action: '=', value: login, valueLabel: login } },
      },
      context,
    );
    if (!isIchancyOk(response)) return response;

    // Handles both documented shapes: `{ records: [...] }` and a bare `[]`.
    const records = readRecords(response.data?.result);
    const wanted = login.toLowerCase();
    const named = records.filter((record) => {
      const candidate = readStringFieldAny(record, LOGIN_FIELDS);
      return candidate !== null && candidate.toLowerCase() === wanted;
    });

    let match: Record<string, unknown> | undefined = named[0];
    if (named.length > 1) {
      // Two players with the same login should be impossible. Refusing to guess is the only safe
      // move: picking wrong means crediting a stranger.
      return ichancyAmbiguous(
        `getPlayersForCurrentAgent returned ${String(named.length)} players for login ${login}`,
      );
    }
    if (!match && records.length === 1) {
      const only = records[0];
      // The filter is an exact match on their side; accept a single record that simply does not echo
      // the login field back, but never a record whose login disagrees with ours.
      if (only && readStringFieldAny(only, LOGIN_FIELDS) === null) match = only;
    }
    if (!match) return ichancyOk(null);

    const ichancyPlayerId = readStringFieldAny(match, PLAYER_ID_FIELDS);
    if (ichancyPlayerId === null) {
      return ichancyAmbiguous(
        `getPlayersForCurrentAgent returned a record for ${login} without a playerId`,
      );
    }
    return ichancyOk({ ichancyPlayerId });
  }

  // --------------------------------------------------------------------------------------------

  private async movePlayerFunds(
    direction: 'credit' | 'debit',
    input: PlayerMoveInput,
  ): Promise<IchancyResult<PlayerMoveOutcome>> {
    let amount: number;
    try {
      amount =
        direction === 'credit'
          ? minorToCreditWireAmount(input.amountMinor)
          : minorToDebitWireAmount(input.amountMinor);
    } catch (error) {
      // Encoding failed before anything left the process, so this is a definite no-op: `rejected`.
      const code =
        error instanceof IchancyMoneyCodecError
          ? error.code
          : IchancyRejectionCodes.WRONG_ARGUMENTS;
      return ichancyRejected(code, describeError(error));
    }

    const currency = this.config.ichancy.currency;
    const response = await this.send(
      direction === 'credit' ? 'DEPOSIT_TO_PLAYER' : 'WITHDRAW_FROM_PLAYER',
      direction === 'credit'
        ? IchancyEndpoint.DEPOSIT_TO_PLAYER
        : IchancyEndpoint.WITHDRAW_FROM_PLAYER,
      {
        amount,
        comment: input.comment,
        playerId: input.ichancyPlayerId,
        currencyCode: currency,
        currency,
        moneyStatus: MoneyStatus.PLAYER,
      },
      input.context,
    );
    if (!isIchancyOk(response)) return response;

    // Documented success shapes: `{ balance, creditLine, ... }` or a bare `[]`. The empty array is
    // still a success — it just leaves the resulting balance unknown, which the port models as null.
    const record = readObjectResult(response.data?.result);
    const balanceMinor = record ? tryParseWireMoney(record['balance']) : null;
    return ichancyOk({ balanceMinor });
  }

  /** Resolve the Ichancy player id for a login we just registered (or that already existed). */
  private async resolveEnsuredPlayer(
    input: EnsurePlayerInput,
    created: boolean,
    reason: string,
  ): Promise<IchancyResult<EnsuredPlayer>> {
    const found = await this.findPlayerByLogin(input.login, input.context);
    if (!isIchancyOk(found)) return found;
    if (found.data === null) {
      return ichancyAmbiguous(
        `${reason}, but no player with login ${input.login} is visible under our agent yet`,
      );
    }
    return ichancyOk({ ichancyPlayerId: found.data.ichancyPlayerId, created });
  }

  /** Prefer our currency, then their "main" flag, then whatever came first. */
  private pickWallet(rows: Record<string, unknown>[]): Record<string, unknown> | null {
    if (rows.length === 0) return null;
    const currency = this.config.ichancy.currency.toLowerCase();
    const byCurrency = rows.find((row) => {
      const code = row['currencyCode'];
      return typeof code === 'string' && code.toLowerCase() === currency;
    });
    if (byCurrency) return byCurrency;
    const main = rows.find((row) => row['main'] === true || row['mainCurrency'] === true);
    return main ?? rows[0] ?? null;
  }

  /**
   * One attempt, then AT MOST one replay after a token refresh. Never more — see the file header.
   */
  private async send(
    operation: IchancyOperation,
    endpoint: IchancyEndpointName,
    body: Record<string, unknown>,
    context?: IchancyCallContext,
  ): Promise<EnvelopeResult> {
    let accessToken: string;
    try {
      accessToken = await this.session.getAccessToken();
    } catch (error) {
      // Nothing was sent. This is the one auth failure we can honestly call a definite non-event.
      return ichancyRejected(sessionFailureCode(error), describeError(error));
    }

    const first = await this.http.call({
      operation,
      endpoint,
      body,
      accessToken,
      attempt: 1,
      context,
    });
    if (first.classification.outcome !== 'token_expired') return this.toEnvelopeResult(first);

    let refreshed: string;
    try {
      refreshed = await this.session.refreshAfterUnauthorized(accessToken);
    } catch (error) {
      // A request has already been sent by now. It *looks* like it was refused at the door, but the
      // 201-means-unauthorized quirk means we cannot promise that, so this stays ambiguous.
      return ichancyAmbiguous(
        `${endpoint}: could not renew the Ichancy session after an unauthorized answer: ${describeError(error)}`,
      );
    }

    const second = await this.http.call({
      operation,
      endpoint,
      body,
      accessToken: refreshed,
      attempt: 2,
      context,
    });
    if (second.classification.outcome === 'token_expired') {
      return ichancyAmbiguous(
        `${endpoint}: still unauthorized after refreshing the agent session — the agent tokens are being invalidated by another process`,
      );
    }
    return this.toEnvelopeResult(second);
  }

  private toEnvelopeResult(attempt: IchancyAttempt): EnvelopeResult {
    const classification = attempt.classification;
    switch (classification.outcome) {
      case 'ok':
        return ichancyOk(attempt.envelope);
      case 'rejected':
      case 'already_exists':
        return ichancyRejected(classification.code, classification.message);
      case 'token_expired':
      case 'ambiguous':
        return ichancyAmbiguous(classification.message);
    }
  }
}
