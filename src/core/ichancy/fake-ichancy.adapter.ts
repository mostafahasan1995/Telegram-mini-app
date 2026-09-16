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
 *
 * ══ KEYED PER AGENT, LIKE PRODUCTION ═════════════════════════════════════════════════════════════
 * In the app it resolves the agent of the operator in the tenant context exactly as the real adapter
 * does (ICHANCY_AGENT_RESOLVER), and keeps players and the agent wallet PER AGENT KEY. So operator A's
 * players are invisible to operator B's calls, B's credits drain B's float, a call with no operator in
 * context throws, and every recorded call says which agent made it. Two operators sharing a login
 * share one bucket, because they share one Ichancy account. Constructed bare (a unit test), it has no
 * resolver and serves a single unkeyed agent.
 *
 * Its sign-in accepts any credentials unless a test says otherwise (rejectSignIn, or a scripted
 * `signIn` behaviour): ICHANCY_FAKE is a mode where no real money can move, so a fake activation is
 * recorded as fake by the caller rather than refused.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  IchancyMoneyCodecError,
  minorToCreditWireAmount,
  minorToDebitWireAmount,
} from './money-codec';
import {
  ICHANCY_AGENT_RESOLVER,
  IchancyAgentErrorCodes,
  ichancyAgentKey,
  isIchancyAgentUnavailableError,
  type IchancyAgent,
  type IchancyAgentCandidate,
  type IchancyAgentResolver,
} from './ichancy-agent';
import { type IchancySignedIn } from './ichancy-session.service';
import {
  type AgentPlayerPage,
  type AgentPlayerPageRequest,
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
  | 'findPlayerByLogin'
  | 'listAgentPlayers'
  | 'signIn';

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
  /** The agent the call was made as; FAKE_UNKEYED_AGENT without a resolver. */
  readonly agentKey: string;
  /** The operator whose credentials were used, or null without a resolver. */
  readonly tenantId: string | null;
  /** The agent id a registration would have used, or null without a resolver. */
  readonly agentId: string | null;
}

export interface FakePlayer {
  ichancyPlayerId: string;
  login: string;
  email: string;
  balanceMinor: bigint;
  /** The agent id it was registered under, as the listing reports it; null when seeded without one. */
  parentId: string | null;
}

/** The single bucket of a fake constructed without a resolver. */
export const FAKE_UNKEYED_AGENT = 'unkeyed';

const DEFAULT_AGENT_BALANCE_MINOR = 100_000_00n;
const DEFAULT_SLOW_MS = 100;

/** The exact sentences the real API sends, so error-map keeps being exercised in tests. */
const AGENT_FLOAT_MESSAGE = 'The amount is greater than you have in Total Available(FROM)';
const PLAYER_BALANCE_MESSAGE = 'Amount is greater than account balance';
const DUPLICATE_LOGIN_MESSAGE = 'Duplicate login';
const INVALID_CREDENTIALS_MESSAGE = 'Invalid username or password.';

interface FakeAgentState {
  readonly playersByLogin: Map<string, FakePlayer>;
  readonly playersById: Map<string, FakePlayer>;
  agentBalanceMinor: bigint;
  agentAvailableMinor: bigint;
  signIns: number;
}

/** Who a call is made as: the bucket, and the agent when a resolver produced one. */
interface FakeCaller {
  readonly key: string;
  readonly agent: IchancyAgent | null;
}

type Resolution =
  | { readonly kind: 'caller'; readonly caller: FakeCaller }
  | { readonly kind: 'refused'; readonly code: string; readonly message: string };

@Injectable()
export class FakeIchancyAdapter implements IchancyPort {
  private readonly logger = new Logger(FakeIchancyAdapter.name);

  private defaultMode: FakeIchancyMode = 'ok';
  private slowMs = DEFAULT_SLOW_MS;
  private scripted: FakeIchancyBehaviour[] = [];
  private readonly agents = new Map<string, FakeAgentState>();
  /** Case-folded usernames whose sign-in is refused, as a wrong password would be. */
  private readonly refusedSignIns = new Set<string>();
  private refuseEverySignIn = false;
  private sequence = 0;

  readonly calls: FakeIchancyCall[] = [];

  constructor(
    @Optional()
    @Inject(ICHANCY_AGENT_RESOLVER)
    private readonly resolver: IchancyAgentResolver | null = null,
  ) {}

  // ---- scripting API (tests only) -------------------------------------------------------------

  reset(): void {
    this.defaultMode = 'ok';
    this.slowMs = DEFAULT_SLOW_MS;
    this.scripted = [];
    this.agents.clear();
    this.refusedSignIns.clear();
    this.refuseEverySignIn = false;
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

  /** Every later sign-in with this username is refused with Ichancy's wrong-password answer. */
  rejectSignIn(username: string): void {
    this.refusedSignIns.add(username.trim().toLowerCase());
  }

  /**
   * Every later sign-in is refused, whatever the login, until reset(). For a suite whose operators
   * must stay SUSPENDED after create, the way a wrong password leaves them.
   */
  refuseAllSignIns(): void {
    this.refuseEverySignIn = true;
  }

  /** The key the fake files an agent under — the same key production keys its session by. */
  static agentKeyOf(baseUrl: string, username: string): string {
    return ichancyAgentKey(baseUrl, username);
  }

  seedPlayer(player: {
    login: string;
    email?: string;
    ichancyPlayerId?: string;
    balanceMinor?: bigint;
    /** Required when the fake resolves agents; see keyFor. */
    agentKey?: string;
    parentId?: string | null;
  }): FakePlayer {
    const state = this.state(this.keyFor(player.agentKey));
    const existing = state.playersByLogin.get(player.login.toLowerCase());
    if (existing) {
      if (player.balanceMinor !== undefined) existing.balanceMinor = player.balanceMinor;
      return existing;
    }
    const created: FakePlayer = {
      ichancyPlayerId: player.ichancyPlayerId ?? this.nextPlayerId(),
      login: player.login,
      email: player.email ?? `${player.login}@fake.local`,
      balanceMinor: player.balanceMinor ?? 0n,
      parentId: player.parentId ?? null,
    };
    state.playersByLogin.set(created.login.toLowerCase(), created);
    state.playersById.set(created.ichancyPlayerId, created);
    return created;
  }

  setPlayerBalance(ichancyPlayerId: string, balanceMinor: bigint, agentKey?: string): void {
    const player = this.state(this.keyFor(agentKey)).playersById.get(ichancyPlayerId);
    if (!player) throw new Error(`FakeIchancyAdapter: unknown player ${ichancyPlayerId}`);
    player.balanceMinor = balanceMinor;
  }

  peekPlayerBalance(ichancyPlayerId: string, agentKey?: string): bigint | null {
    return this.state(this.keyFor(agentKey)).playersById.get(ichancyPlayerId)?.balanceMinor ?? null;
  }

  setAgentWallet(wallet: { balanceMinor: bigint; availableMinor?: bigint; agentKey?: string }): void {
    const state = this.state(this.keyFor(wallet.agentKey));
    state.agentBalanceMinor = wallet.balanceMinor;
    state.agentAvailableMinor = wallet.availableMinor ?? wallet.balanceMinor;
  }

  peekAgentWallet(agentKey?: string): AgentWallet {
    const state = this.state(this.keyFor(agentKey));
    return { balanceMinor: state.agentBalanceMinor, availableMinor: state.agentAvailableMinor };
  }

  /** How many sign-ins this agent has been through. */
  signInCount(agentKey?: string): number {
    return this.state(this.keyFor(agentKey)).signIns;
  }

  callsFor(operation: FakeIchancyOperation): FakeIchancyCall[] {
    return this.calls.filter((call) => call.operation === operation);
  }

  callsForAgent(agentKey: string): FakeIchancyCall[] {
    return this.calls.filter((call) => call.agentKey === agentKey);
  }

  // ---- IchancyPort ----------------------------------------------------------------------------

  async ensurePlayer(input: EnsurePlayerInput): Promise<IchancyResult<EnsuredPlayer>> {
    const resolution = await this.resolve();
    if (resolution.kind === 'refused') return ichancyRejected(resolution.code, resolution.message);
    const caller = resolution.caller;
    const behaviour = this.begin('ensurePlayer', input, caller);
    await this.pause(behaviour);
    const existing = this.state(caller.key).playersByLogin.get(input.login.toLowerCase());
    const seed = (): FakePlayer =>
      this.seedPlayer({
        login: input.login,
        email: input.email,
        agentKey: caller.key,
        parentId: caller.agent?.agentId ?? null,
      });

    switch (behaviour.mode) {
      case 'rejected':
        return ichancyRejected(
          behaviour.code ?? IchancyRejectionCodes.VALIDATION_FAILED,
          behaviour.message ?? 'Login property is required',
        );
      case 'ambiguous':
        if (behaviour.applyAnyway) seed();
        return ichancyAmbiguous(behaviour.cause ?? 'registerPlayer timed out');
      case 'already-exists': {
        const player = existing ?? seed();
        this.logger.debug(`${DUPLICATE_LOGIN_MESSAGE}: ${input.login}`);
        return ichancyOk({ ichancyPlayerId: player.ichancyPlayerId, created: false });
      }
      case 'ok':
      case 'slow':
      case 'agent-float-empty': {
        if (existing)
          return ichancyOk({ ichancyPlayerId: existing.ichancyPlayerId, created: false });
        const player = seed();
        return ichancyOk({ ichancyPlayerId: player.ichancyPlayerId, created: true });
      }
    }
  }

  async getPlayerBalance(
    ichancyPlayerId: string,
    context?: IchancyCallContext,
  ): Promise<IchancyResult<PlayerBalance>> {
    const resolution = await this.resolve();
    if (resolution.kind === 'refused') return ichancyRejected(resolution.code, resolution.message);
    const caller = resolution.caller;
    const behaviour = this.begin('getPlayerBalance', { ichancyPlayerId, context }, caller);
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
        const player = this.state(caller.key).playersById.get(ichancyPlayerId);
        // Mirrors the real adapter: `result: []` is unknown, never zero. Another agent's player is
        // exactly as unknown as a player that does not exist.
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
    const resolution = await this.resolve();
    if (resolution.kind === 'refused') return ichancyRejected(resolution.code, resolution.message);
    const caller = resolution.caller;
    const behaviour = this.begin('creditPlayer', input, caller);
    await this.pause(behaviour);

    const encoded = this.encode(input.amountMinor, 'credit');
    if (encoded) return encoded;
    const state = this.state(caller.key);

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
        if (behaviour.applyAnyway) this.applyCredit(state, input);
        return ichancyAmbiguous(behaviour.cause ?? 'depositToPlayer timed out');
      default: {
        if (input.amountMinor > state.agentAvailableMinor) {
          return ichancyRejected(
            IchancyRejectionCodes.INSUFFICIENT_AGENT_FLOAT,
            AGENT_FLOAT_MESSAGE,
          );
        }
        const player = this.applyCredit(state, input);
        if (!player) return ichancyAmbiguous(`Unknown player ${input.ichancyPlayerId}`);
        return ichancyOk({ balanceMinor: player.balanceMinor });
      }
    }
  }

  async debitPlayer(input: PlayerMoveInput): Promise<IchancyResult<PlayerMoveOutcome>> {
    const resolution = await this.resolve();
    if (resolution.kind === 'refused') return ichancyRejected(resolution.code, resolution.message);
    const caller = resolution.caller;
    const behaviour = this.begin('debitPlayer', input, caller);
    await this.pause(behaviour);

    const encoded = this.encode(input.amountMinor, 'debit');
    if (encoded) return encoded;
    const state = this.state(caller.key);

    switch (behaviour.mode) {
      case 'rejected':
        return ichancyRejected(
          behaviour.code ?? IchancyRejectionCodes.WRONG_ARGUMENTS,
          behaviour.message ?? 'Wrong arguments',
        );
      case 'ambiguous':
        if (behaviour.applyAnyway) this.applyDebit(state, input);
        return ichancyAmbiguous(behaviour.cause ?? 'withdrawFromPlayer timed out');
      default: {
        const player = state.playersById.get(input.ichancyPlayerId);
        if (!player) return ichancyAmbiguous(`Unknown player ${input.ichancyPlayerId}`);
        if (player.balanceMinor < input.amountMinor) {
          return ichancyRejected(
            IchancyRejectionCodes.INSUFFICIENT_PLAYER_BALANCE,
            PLAYER_BALANCE_MESSAGE,
          );
        }
        this.applyDebit(state, input);
        return ichancyOk({ balanceMinor: player.balanceMinor });
      }
    }
  }

  async getAgentWallet(context?: IchancyCallContext): Promise<IchancyResult<AgentWallet>> {
    const resolution = await this.resolve();
    if (resolution.kind === 'refused') return ichancyRejected(resolution.code, resolution.message);
    const caller = resolution.caller;
    const behaviour = this.begin('getAgentWallet', { context }, caller);
    await this.pause(behaviour);
    const state = this.state(caller.key);

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
          balanceMinor: state.agentBalanceMinor,
          availableMinor: state.agentAvailableMinor,
        });
    }
  }

  async findPlayerByLogin(
    login: string,
    context?: IchancyCallContext,
  ): Promise<IchancyResult<FoundPlayer | null>> {
    const resolution = await this.resolve();
    if (resolution.kind === 'refused') return ichancyRejected(resolution.code, resolution.message);
    const caller = resolution.caller;
    const behaviour = this.begin('findPlayerByLogin', { login, context }, caller);
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
        const player = this.state(caller.key).playersByLogin.get(login.toLowerCase());
        return ichancyOk(player ? { ichancyPlayerId: player.ichancyPlayerId } : null);
      }
    }
  }

  async listAgentPlayers(
    page: AgentPlayerPageRequest,
    context?: IchancyCallContext,
  ): Promise<IchancyResult<AgentPlayerPage>> {
    const resolution = await this.resolve();
    if (resolution.kind === 'refused') return ichancyRejected(resolution.code, resolution.message);
    const caller = resolution.caller;
    const behaviour = this.begin('listAgentPlayers', { page, context }, caller);
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
        const all = [...this.state(caller.key).playersById.values()].sort((a, b) =>
          a.ichancyPlayerId.localeCompare(b.ichancyPlayerId),
        );
        const slice = all.slice(page.start, page.start + page.limit);
        return ichancyOk({
          records: slice.map((player) => ({
            ichancyPlayerId: player.ichancyPlayerId,
            login: player.login,
            email: player.email,
            parentId: player.parentId,
          })),
          received: slice.length,
        });
      }
    }
  }

  async signIn(candidate?: IchancyAgentCandidate): Promise<IchancyResult<IchancySignedIn>> {
    let caller: FakeCaller;
    let username: string;
    if (candidate !== undefined) {
      const agent = this.resolver === null ? null : this.resolver.fromCandidate(candidate);
      caller = {
        key: agent?.agentKey ?? ichancyAgentKey(candidate.baseUrl, candidate.username),
        agent,
      };
      username = candidate.username;
    } else {
      const resolution = await this.resolve();
      if (resolution.kind === 'refused') return ichancyRejected(resolution.code, resolution.message);
      caller = resolution.caller;
      username = caller.agent?.username ?? '';
    }

    // The input records the agent, never the password.
    const behaviour = this.begin('signIn', { agentKey: caller.key }, caller);
    await this.pause(behaviour);

    if (
      behaviour.mode === 'rejected' ||
      this.refuseEverySignIn ||
      this.refusedSignIns.has(username.trim().toLowerCase())
    ) {
      return ichancyRejected(
        behaviour.code ?? IchancyRejectionCodes.INVALID_CREDENTIALS,
        behaviour.message ?? INVALID_CREDENTIALS_MESSAGE,
      );
    }
    if (behaviour.mode === 'ambiguous') {
      return ichancyAmbiguous(behaviour.cause ?? 'signin timed out');
    }
    const state = this.state(caller.key);
    state.signIns += 1;
    return ichancyOk({ agentKey: caller.key, generation: state.signIns });
  }

  // ---- internals ------------------------------------------------------------------------------

  /**
   * Mirrors HttpIchancyAdapter.asCurrentAgent: no operator in context throws, an operator without a
   * usable agent is refused, and without a resolver everything is the unkeyed agent.
   */
  private async resolve(): Promise<Resolution> {
    if (this.resolver === null) {
      return { kind: 'caller', caller: { key: FAKE_UNKEYED_AGENT, agent: null } };
    }
    try {
      const agent = await this.resolver.forCurrentTenant();
      return { kind: 'caller', caller: { key: agent.agentKey, agent } };
    } catch (error: unknown) {
      if (
        isIchancyAgentUnavailableError(error) &&
        error.code !== IchancyAgentErrorCodes.NO_TENANT_CONTEXT
      ) {
        return { kind: 'refused', code: error.code, message: error.message };
      }
      throw error;
    }
  }

  /**
   * A helper named no agent. Without a resolver there is only one; with one, guessing would seed a
   * bucket no call ever reads, and a test would pass for the wrong reason, so it is refused.
   */
  private keyFor(agentKey: string | undefined): string {
    if (agentKey !== undefined) return agentKey;
    if (this.resolver === null) return FAKE_UNKEYED_AGENT;
    throw new Error(
      'FakeIchancyAdapter is keyed per agent here: pass agentKey (FakeIchancyAdapter.agentKeyOf(baseUrl, username))',
    );
  }

  private state(key: string): FakeAgentState {
    let state = this.agents.get(key);
    if (state === undefined) {
      state = {
        playersByLogin: new Map(),
        playersById: new Map(),
        agentBalanceMinor: DEFAULT_AGENT_BALANCE_MINOR,
        agentAvailableMinor: DEFAULT_AGENT_BALANCE_MINOR,
        signIns: 0,
      };
      this.agents.set(key, state);
    }
    return state;
  }

  private begin(
    operation: FakeIchancyOperation,
    input: unknown,
    caller: FakeCaller,
  ): FakeIchancyBehaviour {
    const behaviour = this.takeBehaviour(operation);
    this.calls.push({
      operation,
      mode: behaviour.mode,
      at: new Date(),
      input,
      agentKey: caller.key,
      tenantId: caller.agent?.tenantId ?? null,
      agentId: caller.agent?.agentId ?? null,
    });
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

  private applyCredit(state: FakeAgentState, input: PlayerMoveInput): FakePlayer | null {
    const player = state.playersById.get(input.ichancyPlayerId);
    if (!player) return null;
    player.balanceMinor += input.amountMinor;
    state.agentBalanceMinor -= input.amountMinor;
    state.agentAvailableMinor -= input.amountMinor;
    return player;
  }

  private applyDebit(state: FakeAgentState, input: PlayerMoveInput): FakePlayer | null {
    const player = state.playersById.get(input.ichancyPlayerId);
    if (!player) return null;
    player.balanceMinor -= input.amountMinor;
    state.agentBalanceMinor += input.amountMinor;
    state.agentAvailableMinor += input.amountMinor;
    return player;
  }

  private nextPlayerId(): string {
    this.sequence += 1;
    return `fake-player-${String(this.sequence).padStart(6, '0')}`;
  }
}
