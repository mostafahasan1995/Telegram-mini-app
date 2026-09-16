/**
 * WHY: this is the anti-corruption boundary. Above this line the application knows only bigint minor
 * units, our own player id, and the three-way IchancyResult. It knows nothing about `moneyStatus:5`,
 * about registerPlayer answering the number 1, or about 201-meaning-unauthorized.
 *
 * Three rules that callers must respect and that shaped these signatures:
 *  1. `creditPlayer`/`debitPlayer` take a POSITIVE amountMinor. The adapter owns the sign flip that
 *     the withdraw endpoints require, so no caller can accidentally deposit a negative number.
 *  2. `comment` is not decoration: the credit worker passes the deposit shortId so a human can find
 *     the movement in the Ichancy back-office. It is our only cross-reference — there is no
 *     idempotency key and no lookup-by-reference endpoint.
 *  3. EVERY CALL IS MADE AS THE OPERATOR IN THE TENANT CONTEXT. No method takes a tenant: the adapter
 *     reads the operator's own agent (base URL, username, password, agent id, currency) from its
 *     row through ICHANCY_AGENT_RESOLVER. A call with no operator in context throws
 *     IchancyAgentUnavailableError(NO_TENANT_CONTEXT) instead of borrowing an agent; an operator
 *     with no usable agent gets a `rejected` result (nothing was sent). So a worker, cron or
 *     processor must enter `runWithTenant()` with the operator that owns the player or deposit
 *     before it calls anything here.
 */
import { type IchancyAgentCandidate } from './ichancy-agent';
import { type IchancySignedIn } from './ichancy-session.service';
import { type IchancyResult } from './ichancy.types';

/** DI token. Inject with `@Inject(ICHANCY_PORT) private readonly ichancy: IchancyPort`. */
export const ICHANCY_PORT = 'ICHANCY_PORT';

/**
 * Correlation for the ichancy_calls audit row. All optional: a call without context is still logged,
 * it is just harder to join to a deposit later.
 */
export interface IchancyCallContext {
  /** Ties every attempt of one logical operation (and its log lines) together. */
  readonly correlationId?: string | null;
  /** Our DepositRequest.id (uuid), not the shortId. */
  readonly depositRequestId?: string | null;
  /** OUR Player.id (uuid) — never the Ichancy player id. */
  readonly playerId?: string | null;
}

export interface EnsurePlayerInput {
  /** Ichancy `login`, i.e. the username we generate for the player. */
  readonly login: string;
  readonly email: string;
  readonly password: string;
  readonly context?: IchancyCallContext;
}

export interface EnsuredPlayer {
  readonly ichancyPlayerId: string;
  /** false when the player already existed on their side (duplicate login/email). */
  readonly created: boolean;
}

export interface PlayerBalance {
  readonly balanceMinor: bigint;
}

export interface PlayerMoveInput {
  readonly ichancyPlayerId: string;
  /** ALWAYS positive. debitPlayer negates it on the wire. */
  readonly amountMinor: bigint;
  /** Deposit shortId (or an equally traceable string) — shows up in the Ichancy panel. */
  readonly comment: string;
  readonly context?: IchancyCallContext;
}

export interface PlayerMoveOutcome {
  /**
   * null means "the move succeeded but the API did not tell us the resulting balance" — the
   * documented `result: []` success. Callers that need the balance must re-read it.
   */
  readonly balanceMinor: bigint | null;
}

export interface AgentWallet {
  readonly balanceMinor: bigint;
  /** What we can actually spend right now (availableWallet), which is what limits approvals. */
  readonly availableMinor: bigint;
}

export interface FoundPlayer {
  readonly ichancyPlayerId: string;
}

/** One page of the agent's own players, as the import reads them. */
export interface AgentPlayerPageRequest {
  /** 0-based offset. */
  readonly start: number;
  readonly limit: number;
}

export interface AgentPlayerRecord {
  readonly ichancyPlayerId: string;
  readonly login: string;
  readonly email: string | null;
  /**
   * The agent id the player hangs off (`parentId` at registration), when the row says. The listing
   * returns every player of the SIGNED-IN login, so two operators sharing one login under different
   * agent ids can only tell their players apart by this; null means Ichancy did not say.
   */
  readonly parentId: string | null;
}

export interface AgentPlayerPage {
  /** The records that carried both an id and a login. */
  readonly records: readonly AgentPlayerRecord[];
  /** How many rows the page held, usable or not: what an import reports as scanned. */
  readonly received: number;
}

export interface IchancyPort {
  /**
   * Register the player, or resolve the id of the one that already exists. Effectively idempotent:
   * a "Duplicate login" is a success with created:false.
   */
  ensurePlayer(input: EnsurePlayerInput): Promise<IchancyResult<EnsuredPlayer>>;

  /** Oracle #1 for BALANCE_DELTA verification. */
  getPlayerBalance(
    ichancyPlayerId: string,
    context?: IchancyCallContext,
  ): Promise<IchancyResult<PlayerBalance>>;

  /** depositToPlayer. amountMinor > 0. */
  creditPlayer(input: PlayerMoveInput): Promise<IchancyResult<PlayerMoveOutcome>>;

  /** withdrawFromPlayer. amountMinor > 0; a NEGATIVE amount goes on the wire. */
  debitPlayer(input: PlayerMoveInput): Promise<IchancyResult<PlayerMoveOutcome>>;

  /** Oracle #2: our finite agent float, synced into the ICHANCY_AGENT_FLOAT ledger account. */
  getAgentWallet(context?: IchancyCallContext): Promise<IchancyResult<AgentWallet>>;

  /** null (inside an `ok`) means "no such login under our agent", which is not an error. */
  findPlayerByLogin(
    login: string,
    context?: IchancyCallContext,
  ): Promise<IchancyResult<FoundPlayer | null>>;

  /** One page of the players under the operator's agent, for the import of existing players. */
  listAgentPlayers(
    page: AgentPlayerPageRequest,
    context?: IchancyCallContext,
  ): Promise<IchancyResult<AgentPlayerPage>>;

  /**
   * A REAL sign-in, now, proving credentials: those of the operator in context, or `candidate`
   * credentials that are not saved yet (a PATCH being verified). A `rejected` result means Ichancy
   * refused them; `ambiguous` means we could not find out. It is what activation and a credential
   * edit rest on, so it never answers from a stored session.
   */
  signIn(candidate?: IchancyAgentCandidate): Promise<IchancyResult<IchancySignedIn>>;
}
