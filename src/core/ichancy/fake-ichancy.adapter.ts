/**
 * WHY: every e2e test and every local dev run goes through this instead of the real agent API. Not
 * because HTTP is slow, but because the behaviours that matter are impossible to trigger on demand
 * against a live partner: an ambiguous credit that ACTUALLY moved the money, an agent float that
 * runs dry mid-approval, a duplicate registration.
 *
 * The internal balance map is the point. `mode: 'ambiguous', applyAnyway: true` reproduces the exact
 * scenario the credit worker exists for — the API told us nothing, the player was credited anyway —
 * so BALANCE_DELTA verification can be tested end to end rather than asserted about.
 *
 * It deliberately mirrors the real adapter's guardrails (positive amounts only, unknown player =>
 * ambiguous balance, agent float actually decrements) so a test that passes here is not passing
 * because the fake was more forgiving than production.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  IchancyMoneyCodecError,
  minorToCreditWireAmount,
  minorToDebitWireAmount,
} from './money-codec';
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
  type IchancyResult,
} from './ichancy.types';

export type FakeIchancyMode =
  /** Everything works and the in-memory balances move. */
  | 'ok'
  /** A definite business "no" (see `code`/`message`, default WRONG_ARGUMENTS). */
  | 'rejected'
  /** We learn nothing. Combine with `applyAnyway: true` to move the money behind our back. */
  | 'ambiguous'
  /** Succeeds, but only after `delayMs` — for testing per-player mutexes and timeouts. */
  | 'slow'
  /** registerPlayer answers "Duplicate login"; the id is still resolvable. */
  | 'already-exists'
  /** Our agent wallet is empty: credits are refused with the real Ichancy sentence. */
  | 'agent-float-empty';

export type FakeIchancyOperation =
  | 'ensurePlayer'
  | 'getPlayerBalance'
  | 'creditPlayer'
  | 'debitPlayer'
  | 'getAgentWallet'
  | 'findPlayerByLogin';

export interface FakeIchancyBehaviour {
  /** Defaults to 'any' — the next call of ANY operation consumes it. */
  operation?: FakeIchancyOperation | 'any';
  mode: FakeIchancyMode;
  /** Only meaningful with 'ambiguous': the far side really did apply the movement. */
  applyAnyway?: boolean;
  code?: string;
  message?: string;
  cause?: string;
  delayMs?: number;
  /** How many calls this behaviour covers before it is discarded. Default 1. */
  times?: number;
}

export interface FakeIchancyCall {
  readonly operation: FakeIchancyOperation;
  readonly mode: FakeIchancyMode;
  readonly at: Date;
  readonly input: unknown;
}

export interface FakePlayer {
  ichancyPlayerId: string;
  login: string;
  email: string;
  balanceMinor: bigint;
}

const DEFAULT_AGENT_BALANCE_MINOR = 100_000_00n;
const DEFAULT_SLOW_MS = 100;

/** The exact sentences the real API sends, so error-map keeps being exercised in tests. */
const AGENT_FLOAT_MESSAGE = 'The amount is greater than you have in Total Available(FROM)';
const PLAYER_BALANCE_MESSAGE = 'Amount is greater than account balance';
const DUPLICATE_LOGIN_MESSAGE = 'Duplicate login';

@Injectable()
export class FakeIchancyAdapter implements IchancyPort {
  private readonly logger = new Logger(FakeIchancyAdapter.name);

  private defaultMode: FakeIchancyMode = 'ok';
  private slowMs = DEFAULT_SLOW_MS;
  private scripted: FakeIchancyBehaviour[] = [];
  private readonly playersByLogin = new Map<string, FakePlayer>();
  private readonly playersById = new Map<string, FakePlayer>();
  private agentBalanceMinor = DEFAULT_AGENT_BALANCE_MINOR;
  private agentAvailableMinor = DEFAULT_AGENT_BALANCE_MINOR;
  private sequence = 0;

  readonly calls: FakeIchancyCall[] = [];

  // ---- scripting API (tests only) -------------------------------------------------------------

  reset(): void {
    this.defaultMode = 'ok';
    this.slowMs = DEFAULT_SLOW_MS;
    this.scripted = [];
    this.playersByLogin.clear();
    this.playersById.clear();
    this.agentBalanceMinor = DEFAULT_AGENT_BALANCE_MINOR;
    this.agentAvailableMinor = DEFAULT_AGENT_BALANCE_MINOR;
    this.sequence = 0;
    this.calls.length = 0;
  }

  setMode(mode: FakeIchancyMode): void {
    this.defaultMode = mode;
  }

  setSlowDelayMs(ms: number): void {
    this.slowMs = ms;
  }

  /** Queue one-shot behaviours; they are consumed in order, before the default mode applies. */
  script(behaviour: FakeIchancyBehaviour | FakeIchancyBehaviour[]): void {
    this.scripted.push(...(Array.isArray(behaviour) ? behaviour : [behaviour]));
  }

  seedPlayer(player: {
    login: string;
    email?: string;
    ichancyPlayerId?: string;
    balanceMinor?: bigint;
  }): FakePlayer {
    const existing = this.playersByLogin.get(player.login.toLowerCase());
    if (existing) {
      if (player.balanceMinor !== undefined) existing.balanceMinor = player.balanceMinor;
      return existing;
    }
    const created: FakePlayer = {
      ichancyPlayerId: player.ichancyPlayerId ?? this.nextPlayerId(),
      login: player.login,
      email: player.email ?? `${player.login}@fake.local`,
      balanceMinor: player.balanceMinor ?? 0n,
    };
    this.playersByLogin.set(created.login.toLowerCase(), created);
    this.playersById.set(created.ichancyPlayerId, created);
    return created;
  }

  setPlayerBalance(ichancyPlayerId: string, balanceMinor: bigint): void {
    const player = this.playersById.get(ichancyPlayerId);
    if (!player) throw new Error(`FakeIchancyAdapter: unknown player ${ichancyPlayerId}`);
    player.balanceMinor = balanceMinor;
  }

  peekPlayerBalance(ichancyPlayerId: string): bigint | null {
    return this.playersById.get(ichancyPlayerId)?.balanceMinor ?? null;
  }

  setAgentWallet(wallet: { balanceMinor: bigint; availableMinor?: bigint }): void {
    this.agentBalanceMinor = wallet.balanceMinor;
    this.agentAvailableMinor = wallet.availableMinor ?? wallet.balanceMinor;
  }

  peekAgentWallet(): AgentWallet {
    return { balanceMinor: this.agentBalanceMinor, availableMinor: this.agentAvailableMinor };
  }

  callsFor(operation: FakeIchancyOperation): FakeIchancyCall[] {
    return this.calls.filter((call) => call.operation === operation);
  }

  // ---- IchancyPort ----------------------------------------------------------------------------

  async ensurePlayer(input: EnsurePlayerInput): Promise<IchancyResult<EnsuredPlayer>> {
    const behaviour = this.begin('ensurePlayer', input);
    await this.pause(behaviour);
    const existing = this.playersByLogin.get(input.login.toLowerCase());

    switch (behaviour.mode) {
      case 'rejected':
        return ichancyRejected(
          behaviour.code ?? IchancyRejectionCodes.VALIDATION_FAILED,
          behaviour.message ?? 'Login property is required',
        );
      case 'ambiguous':
        if (behaviour.applyAnyway) this.seedPlayer({ login: input.login, email: input.email });
        return ichancyAmbiguous(behaviour.cause ?? 'registerPlayer timed out');
      case 'already-exists': {
        const player = existing ?? this.seedPlayer({ login: input.login, email: input.email });
        this.logger.debug(`${DUPLICATE_LOGIN_MESSAGE}: ${input.login}`);
        return ichancyOk({ ichancyPlayerId: player.ichancyPlayerId, created: false });
      }
      case 'ok':
      case 'slow':
      case 'agent-float-empty': {
        if (existing)
          return ichancyOk({ ichancyPlayerId: existing.ichancyPlayerId, created: false });
        const player = this.seedPlayer({ login: input.login, email: input.email });
        return ichancyOk({ ichancyPlayerId: player.ichancyPlayerId, created: true });
      }
    }
  }

  async getPlayerBalance(
    ichancyPlayerId: string,
    context?: IchancyCallContext,
  ): Promise<IchancyResult<PlayerBalance>> {
    const behaviour = this.begin('getPlayerBalance', { ichancyPlayerId, context });
    await this.pause(behaviour);

    switch (behaviour.mode) {
      case 'rejected':
        return ichancyRejected(
          behaviour.code ?? IchancyRejectionCodes.WRONG_ARGUMENTS,
          behaviour.message ?? 'Wrong arguments',
        );
      case 'ambiguous':
        return ichancyAmbiguous(behaviour.cause ?? 'getPlayerBalanceById timed out');
      default: {
        const player = this.playersById.get(ichancyPlayerId);
        // Mirrors the real adapter: `result: []` is unknown, never zero.
        if (!player) {
          return ichancyAmbiguous(
            `getPlayerBalanceById returned no wallet row for player ${ichancyPlayerId}`,
          );
        }
        return ichancyOk({ balanceMinor: player.balanceMinor });
      }
    }
  }

  async creditPlayer(input: PlayerMoveInput): Promise<IchancyResult<PlayerMoveOutcome>> {
    const behaviour = this.begin('creditPlayer', input);
    await this.pause(behaviour);

    const encoded = this.encode(input.amountMinor, 'credit');
    if (encoded) return encoded;

    switch (behaviour.mode) {
      case 'rejected':
        return ichancyRejected(
          behaviour.code ?? IchancyRejectionCodes.WRONG_ARGUMENTS,
          behaviour.message ?? 'Wrong arguments',
        );
      case 'agent-float-empty':
        return ichancyRejected(IchancyRejectionCodes.INSUFFICIENT_AGENT_FLOAT, AGENT_FLOAT_MESSAGE);
      case 'ambiguous':
        // THE case the credit worker exists for: silence on the wire, money on the far side.
        if (behaviour.applyAnyway) this.applyCredit(input);
        return ichancyAmbiguous(behaviour.cause ?? 'depositToPlayer timed out');
      default: {
        if (input.amountMinor > this.agentAvailableMinor) {
          return ichancyRejected(
            IchancyRejectionCodes.INSUFFICIENT_AGENT_FLOAT,
            AGENT_FLOAT_MESSAGE,
          );
        }
        const player = this.applyCredit(input);
        if (!player) return ichancyAmbiguous(`Unknown player ${input.ichancyPlayerId}`);
        return ichancyOk({ balanceMinor: player.balanceMinor });
      }
    }
  }

  async debitPlayer(input: PlayerMoveInput): Promise<IchancyResult<PlayerMoveOutcome>> {
    const behaviour = this.begin('debitPlayer', input);
    await this.pause(behaviour);

    const encoded = this.encode(input.amountMinor, 'debit');
    if (encoded) return encoded;

    switch (behaviour.mode) {
      case 'rejected':
        return ichancyRejected(
          behaviour.code ?? IchancyRejectionCodes.WRONG_ARGUMENTS,
          behaviour.message ?? 'Wrong arguments',
        );
      case 'ambiguous':
        if (behaviour.applyAnyway) this.applyDebit(input);
        return ichancyAmbiguous(behaviour.cause ?? 'withdrawFromPlayer timed out');
      default: {
        const player = this.playersById.get(input.ichancyPlayerId);
        if (!player) return ichancyAmbiguous(`Unknown player ${input.ichancyPlayerId}`);
        if (player.balanceMinor < input.amountMinor) {
          return ichancyRejected(
            IchancyRejectionCodes.INSUFFICIENT_PLAYER_BALANCE,
            PLAYER_BALANCE_MESSAGE,
          );
        }
        this.applyDebit(input);
        return ichancyOk({ balanceMinor: player.balanceMinor });
      }
    }
  }

  async getAgentWallet(context?: IchancyCallContext): Promise<IchancyResult<AgentWallet>> {
    const behaviour = this.begin('getAgentWallet', { context });
    await this.pause(behaviour);

    switch (behaviour.mode) {
      case 'rejected':
        return ichancyRejected(
          behaviour.code ?? IchancyRejectionCodes.NO_WALLET,
          behaviour.message ?? "You don't have NSP wallet",
        );
      case 'ambiguous':
        return ichancyAmbiguous(behaviour.cause ?? 'getAgentAllWallets timed out');
      case 'agent-float-empty':
        return ichancyOk({ balanceMinor: 0n, availableMinor: 0n });
      default:
        return ichancyOk({
          balanceMinor: this.agentBalanceMinor,
          availableMinor: this.agentAvailableMinor,
        });
    }
  }

  async findPlayerByLogin(
    login: string,
    context?: IchancyCallContext,
  ): Promise<IchancyResult<FoundPlayer | null>> {
    const behaviour = this.begin('findPlayerByLogin', { login, context });
    await this.pause(behaviour);

    switch (behaviour.mode) {
      case 'rejected':
        return ichancyRejected(
          behaviour.code ?? IchancyRejectionCodes.WRONG_ARGUMENTS,
          behaviour.message ?? 'Wrong arguments',
        );
      case 'ambiguous':
        return ichancyAmbiguous(behaviour.cause ?? 'getPlayersForCurrentAgent timed out');
      default: {
        const player = this.playersByLogin.get(login.toLowerCase());
        return ichancyOk(player ? { ichancyPlayerId: player.ichancyPlayerId } : null);
      }
    }
  }

  // ---- internals ------------------------------------------------------------------------------

  private begin(operation: FakeIchancyOperation, input: unknown): FakeIchancyBehaviour {
    const behaviour = this.takeBehaviour(operation);
    this.calls.push({ operation, mode: behaviour.mode, at: new Date(), input });
    return behaviour;
  }

  private takeBehaviour(operation: FakeIchancyOperation): FakeIchancyBehaviour {
    const index = this.scripted.findIndex(
      (item) => (item.operation ?? 'any') === 'any' || item.operation === operation,
    );
    if (index < 0) return { mode: this.defaultMode };
    const behaviour = this.scripted[index];
    if (!behaviour) return { mode: this.defaultMode };
    const remaining = (behaviour.times ?? 1) - 1;
    if (remaining <= 0) this.scripted.splice(index, 1);
    else this.scripted[index] = { ...behaviour, times: remaining };
    return behaviour;
  }

  private pause(behaviour: FakeIchancyBehaviour): Promise<void> {
    const ms = behaviour.delayMs ?? (behaviour.mode === 'slow' ? this.slowMs : 0);
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Runs the real codec so an amount that production could not encode fails here too. */
  private encode(
    amountMinor: bigint,
    direction: 'credit' | 'debit',
  ): IchancyResult<PlayerMoveOutcome> | null {
    try {
      if (direction === 'credit') minorToCreditWireAmount(amountMinor);
      else minorToDebitWireAmount(amountMinor);
      return null;
    } catch (error) {
      const code =
        error instanceof IchancyMoneyCodecError
          ? error.code
          : IchancyRejectionCodes.WRONG_ARGUMENTS;
      return ichancyRejected(code, error instanceof Error ? error.message : String(error));
    }
  }

  private applyCredit(input: PlayerMoveInput): FakePlayer | null {
    const player = this.playersById.get(input.ichancyPlayerId);
    if (!player) return null;
    player.balanceMinor += input.amountMinor;
    this.agentBalanceMinor -= input.amountMinor;
    this.agentAvailableMinor -= input.amountMinor;
    return player;
  }

  private applyDebit(input: PlayerMoveInput): FakePlayer | null {
    const player = this.playersById.get(input.ichancyPlayerId);
    if (!player) return null;
    player.balanceMinor -= input.amountMinor;
    this.agentBalanceMinor += input.amountMinor;
    this.agentAvailableMinor += input.amountMinor;
    return player;
  }

  private nextPlayerId(): string {
    this.sequence += 1;
    return `fake-player-${String(this.sequence).padStart(6, '0')}`;
  }
}
