/**
 * Policy tests for the adapter, driven through the REAL classifier with real response fixtures from
 * the Ichancy spec. The two things that must never regress:
 *   - exactly one replay after a token refresh, never two POSTs of a money call for any other reason
 *   - `result: []` / `result: 1` / string money are all handled without inventing a balance
 */
import { HttpIchancyAdapter } from './http-ichancy.adapter';
import {
  IchancyAgentErrorCodes,
  IchancyAgentUnavailableError,
  ichancyAgentKey,
  type IchancyAgent,
  type IchancyAgentCandidate,
  type IchancyAgentResolver,
} from './ichancy-agent';
import {
  type IchancyAttempt,
  type IchancyCallParams,
  type IchancyHttpClient,
} from './ichancy-http.client';
import { IchancySessionError, type IchancySessionService } from './ichancy-session.service';
import { classifyEnvelope } from './error-map';
import { IchancyRejectionCodes } from './ichancy.types';
import { toEnvelope, type IchancyEndpointName } from './ichancy.wire';

interface ScriptedResponse {
  httpStatus: number;
  body: unknown;
}

class StubHttpClient {
  readonly calls: IchancyCallParams[] = [];
  private readonly scripted = new Map<string, ScriptedResponse[]>();

  on(endpoint: IchancyEndpointName, ...responses: ScriptedResponse[]): void {
    this.scripted.set(endpoint, [...(this.scripted.get(endpoint) ?? []), ...responses]);
  }

  call(params: IchancyCallParams): Promise<IchancyAttempt> {
    this.calls.push(params);
    const queue = this.scripted.get(params.endpoint) ?? [];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    const response: ScriptedResponse = next ?? {
      httpStatus: 200,
      body: { status: true, result: 1 },
    };
    const envelope = toEnvelope(response.body);
    return Promise.resolve({
      classification: classifyEnvelope(response.httpStatus, envelope),
      httpStatus: response.httpStatus,
      envelope,
      durationMs: 1,
    });
  }

  countFor(endpoint: IchancyEndpointName): number {
    return this.calls.filter((call) => call.endpoint === endpoint).length;
  }
}

class StubSession {
  token = 'access-1';
  refreshCalls = 0;
  failGetAccessToken = false;
  /** The agent key of every session request, in order. */
  readonly agentKeys: string[] = [];
  readonly signedIn: IchancyAgent[] = [];

  getAccessToken(agent: IchancyAgent): Promise<string> {
    this.agentKeys.push(agent.agentKey);
    if (this.failGetAccessToken) {
      return Promise.reject(
        new IchancySessionError('ICHANCY_SESSION_MISSING', 'No Ichancy session in Redis'),
      );
    }
    return Promise.resolve(this.token);
  }

  refreshAfterUnauthorized(agent: IchancyAgent, _stale: string | null): Promise<string> {
    this.agentKeys.push(agent.agentKey);
    this.refreshCalls += 1;
    this.token = `access-${String(this.refreshCalls + 1)}`;
    return Promise.resolve(this.token);
  }

  signInNow(agent: IchancyAgent): Promise<{ kind: 'ok'; data: { agentKey: string; generation: number } }> {
    this.signedIn.push(agent);
    return Promise.resolve({ kind: 'ok', data: { agentKey: agent.agentKey, generation: 1 } });
  }
}

function agentOf(baseUrl: string, username: string, agentId: string, currency: string): IchancyAgent {
  return {
    tenantId: `tenant-${username}`,
    baseUrl,
    username,
    password: `password-of-${username}`,
    agentId,
    currency,
    agentKey: ichancyAgentKey(baseUrl, username),
    credentialDigest: `digest-${username}`,
  };
}

const AGENT = agentOf('https://agent.example.com', 'agent', 'AGENT-1', 'NSP');

/** Answers the agent of "the operator in context", or the error a real resolver would throw. */
class StubResolver implements IchancyAgentResolver {
  current: IchancyAgent | IchancyAgentUnavailableError = AGENT;

  forCurrentTenant(): Promise<IchancyAgent> {
    return this.current instanceof IchancyAgentUnavailableError
      ? Promise.reject(this.current)
      : Promise.resolve(this.current);
  }

  forTenant(): Promise<IchancyAgent> {
    return this.forCurrentTenant();
  }

  fromCandidate(candidate: IchancyAgentCandidate): IchancyAgent {
    return {
      ...agentOf(candidate.baseUrl, candidate.username, candidate.agentId, candidate.currency),
      tenantId: candidate.tenantId,
      password: candidate.password,
    };
  }
}

const ok = (result: unknown): ScriptedResponse => ({
  httpStatus: 200,
  body: { status: true, html: '', result, notification: [] },
});

const businessError = (content: string): ScriptedResponse => ({
  httpStatus: 422,
  body: { status: false, html: '', result: false, notification: [{ content, status: 'error' }] },
});

const unauthorized: ScriptedResponse = {
  httpStatus: 201,
  body: {
    status: true,
    result: false,
    notification: [{ content: 'Invalid access', status: 'error' }],
  },
};

const playersPage = (records: unknown[]): ScriptedResponse =>
  ok({ records, totalRecordsCount: String(records.length), titles: {}, total: {} });

describe('HttpIchancyAdapter', () => {
  let http: StubHttpClient;
  let session: StubSession;
  let resolver: StubResolver;
  let adapter: HttpIchancyAdapter;

  beforeEach(() => {
    http = new StubHttpClient();
    session = new StubSession();
    resolver = new StubResolver();
    adapter = new HttpIchancyAdapter(
      http as unknown as IchancyHttpClient,
      session as unknown as IchancySessionService,
      resolver,
    );
  });

  describe("whose agent: the operator's in context, and only that one", () => {
    const B = agentOf('https://agents.operator-b.example', 'agent_b', '2002', 'USD');

    it("makes the whole registration as the operator's own agent: base URL, token and parentId", async () => {
      resolver.current = B;
      http.on('registerPlayer', ok(1));
      http.on('getPlayersForCurrentAgent', playersPage([{ playerId: 'P-7', username: 'player_7' }]));

      await adapter.ensurePlayer({ login: 'player_7', email: 'p7@example.com', password: 'hunter22' });

      expect(http.calls.map((call) => call.agent.baseUrl)).toEqual([B.baseUrl, B.baseUrl]);
      expect(http.calls.every((call) => call.agent.agentKey === B.agentKey)).toBe(true);
      expect(http.calls[0]?.body).toMatchObject({ player: { parentId: '2002' } });
      expect(new Set(session.agentKeys)).toEqual(new Set([B.agentKey]));
    });

    it("moves money and reads wallets in the operator's own currency", async () => {
      resolver.current = B;
      http.on('depositToPlayer', ok({ balance: '1.00', currencyCode: 'USD' }));
      http.on('getAgentAllWallets', ok([
        { currencyCode: 'NSP', balance: '999.00', availableWallet: '999.00' },
        { currencyCode: 'USD', balance: '12.00', availableWallet: '10.00' },
      ]));

      await adapter.creditPlayer({ ichancyPlayerId: 'P-1', amountMinor: 100n, comment: 'X' });
      const wallet = await adapter.getAgentWallet();

      expect(http.calls[0]?.body).toMatchObject({ currencyCode: 'USD', currency: 'USD' });
      expect(wallet).toEqual({ kind: 'ok', data: { balanceMinor: 1_200n, availableMinor: 1_000n } });
    });

    it('throws, sending nothing, when no operator is in context', async () => {
      resolver.current = new IchancyAgentUnavailableError(
        IchancyAgentErrorCodes.NO_TENANT_CONTEXT,
        'No operator in the tenant context',
      );

      await expect(
        adapter.creditPlayer({ ichancyPlayerId: 'P-1', amountMinor: 100n, comment: 'X' }),
      ).rejects.toMatchObject({ code: 'ICHANCY_NO_TENANT_CONTEXT' });
      expect(http.calls).toHaveLength(0);
      expect(session.agentKeys).toHaveLength(0);
    });

    it('rejects, sending nothing, for an operator with no usable agent', async () => {
      resolver.current = new IchancyAgentUnavailableError(
        IchancyAgentErrorCodes.AGENT_UNCONFIGURED,
        'The Ichancy password of operator t is not set',
      );

      expect(await adapter.getPlayerBalance('P-1')).toMatchObject({
        kind: 'rejected',
        code: 'ICHANCY_AGENT_UNCONFIGURED',
      });
      expect(http.calls).toHaveLength(0);
    });

    it('verifies candidate credentials with a real sign-in of exactly those credentials', async () => {
      const result = await adapter.signIn({
        tenantId: 'tenant-c',
        baseUrl: 'https://agents.c.example',
        username: 'agent_c',
        password: 'new-password',
        agentId: '3003',
        currency: 'NSP',
      });

      expect(result.kind).toBe('ok');
      expect(session.signedIn).toHaveLength(1);
      expect(session.signedIn[0]).toMatchObject({
        tenantId: 'tenant-c',
        username: 'agent_c',
        password: 'new-password',
        agentKey: ichancyAgentKey('https://agents.c.example', 'agent_c'),
      });
    });

    it("lists the agent's own players a page at a time, counting rows it cannot use", async () => {
      http.on(
        'getPlayersForCurrentAgent',
        playersPage([
          { playerId: 'P-1', username: 'first', email: 'first@example.com', parentId: 3003 },
          { playerId: 'P-2', username: 'second' },
          { username: 'no-id' },
        ]),
      );

      const page = await adapter.listAgentPlayers({ start: 100, limit: 100 });

      expect(page).toEqual({
        kind: 'ok',
        data: {
          records: [
            { ichancyPlayerId: 'P-1', login: 'first', email: 'first@example.com', parentId: '3003' },
            { ichancyPlayerId: 'P-2', login: 'second', email: null, parentId: null },
          ],
          received: 3,
        },
      });
      expect(http.calls[0]?.body).toEqual({ start: 100, limit: 100, filter: {} });
    });
  });

  describe('token expiry', () => {
    it('refreshes once and replays the call exactly once', async () => {
      http.on('getPlayerBalanceById', unauthorized, ok([{ balance: 10.5, currencyCode: 'NSP' }]));

      const result = await adapter.getPlayerBalance('P-1');

      expect(result).toEqual({ kind: 'ok', data: { balanceMinor: 1050n } });
      expect(session.refreshCalls).toBe(1);
      expect(http.countFor('getPlayerBalanceById')).toBe(2);
      expect(http.calls.map((call) => call.attempt)).toEqual([1, 2]);
      expect(http.calls[1]?.accessToken).toBe('access-2');
    });

    it('gives up as AMBIGUOUS after a second unauthorized — it never sends a third time', async () => {
      http.on('depositToPlayer', unauthorized, unauthorized);

      const result = await adapter.creditPlayer({
        ichancyPlayerId: 'P-1',
        amountMinor: 5_000n,
        comment: 'DEP-123',
      });

      expect(result.kind).toBe('ambiguous');
      expect(http.countFor('depositToPlayer')).toBe(2);
    });

    it('rejects without sending anything when there is no session at all', async () => {
      session.failGetAccessToken = true;

      const result = await adapter.creditPlayer({
        ichancyPlayerId: 'P-1',
        amountMinor: 5_000n,
        comment: 'DEP-123',
      });

      expect(result).toMatchObject({ kind: 'rejected', code: 'ICHANCY_SESSION_MISSING' });
      expect(http.calls).toHaveLength(0);
    });
  });

  describe('creditPlayer', () => {
    it('sends a positive float with moneyStatus 5 and the comment we can trace', async () => {
      http.on('depositToPlayer', ok({ balance: '150.25', currencyCode: 'NSP' }));

      const result = await adapter.creditPlayer({
        ichancyPlayerId: 'P-1',
        amountMinor: 12_345n,
        comment: 'ABCDEF0123',
      });

      expect(result).toEqual({ kind: 'ok', data: { balanceMinor: 15_025n } });
      expect(http.calls[0]?.body).toEqual({
        amount: 123.45,
        comment: 'ABCDEF0123',
        playerId: 'P-1',
        currencyCode: 'NSP',
        currency: 'NSP',
        moneyStatus: 5,
      });
    });

    it('treats the documented `result: []` as success with an unknown balance', async () => {
      http.on('depositToPlayer', ok([]));

      const result = await adapter.creditPlayer({
        ichancyPlayerId: 'P-1',
        amountMinor: 100n,
        comment: 'X',
      });

      expect(result).toEqual({ kind: 'ok', data: { balanceMinor: null } });
    });

    it('maps an empty agent float to a definite rejection', async () => {
      http.on(
        'depositToPlayer',
        businessError('The amount is greater than you have in Total Available(FROM)'),
      );

      const result = await adapter.creditPlayer({
        ichancyPlayerId: 'P-1',
        amountMinor: 100n,
        comment: 'X',
      });

      expect(result).toMatchObject({
        kind: 'rejected',
        code: IchancyRejectionCodes.INSUFFICIENT_AGENT_FLOAT,
      });
    });

    it('refuses a non-positive amount before touching the network', async () => {
      const result = await adapter.creditPlayer({
        ichancyPlayerId: 'P-1',
        amountMinor: 0n,
        comment: 'X',
      });

      expect(result.kind).toBe('rejected');
      expect(http.calls).toHaveLength(0);
    });
  });

  describe('debitPlayer', () => {
    it('negates the amount exactly once', async () => {
      http.on('withdrawFromPlayer', ok({ balance: '0.00' }));

      await adapter.debitPlayer({ ichancyPlayerId: 'P-1', amountMinor: 2_500n, comment: 'X' });

      expect(http.calls[0]?.body).toMatchObject({ amount: -25, moneyStatus: 5 });
    });

    it('maps "Amount is greater than account balance" to the player-balance code', async () => {
      http.on('withdrawFromPlayer', businessError('Amount is greater than account balance'));

      const result = await adapter.debitPlayer({
        ichancyPlayerId: 'P-1',
        amountMinor: 2_500n,
        comment: 'X',
      });

      expect(result).toMatchObject({
        kind: 'rejected',
        code: IchancyRejectionCodes.INSUFFICIENT_PLAYER_BALANCE,
      });
    });
  });

  describe('getPlayerBalance', () => {
    it('reads the wallet for our currency', async () => {
      http.on(
        'getPlayerBalanceById',
        ok([
          { balance: 5, currencyCode: 'USD', main: false },
          { balance: 1234.56, currencyCode: 'NSP', main: true },
        ]),
      );

      expect(await adapter.getPlayerBalance('P-1')).toEqual({
        kind: 'ok',
        data: { balanceMinor: 123_456n },
      });
    });

    it('never turns an empty result into a zero balance', async () => {
      http.on('getPlayerBalanceById', ok([]));

      const result = await adapter.getPlayerBalance('P-1');

      // A zero here would make balance-delta verification lie about a failed credit.
      expect(result.kind).toBe('ambiguous');
    });
  });

  describe('ensurePlayer', () => {
    const input = { login: 'player_42', email: 'p42@example.com', password: 'hunter22' };

    it('registers, then resolves the id (registerPlayer only answers the number 1)', async () => {
      http.on('registerPlayer', ok(1));
      http.on(
        'getPlayersForCurrentAgent',
        playersPage([{ playerId: 'P-9', username: 'player_42' }]),
      );

      const result = await adapter.ensurePlayer(input);

      expect(result).toEqual({ kind: 'ok', data: { ichancyPlayerId: 'P-9', created: true } });
      expect(http.calls[0]?.body).toEqual({
        player: {
          email: 'p42@example.com',
          password: 'hunter22',
          parentId: 'AGENT-1',
          login: 'player_42',
        },
      });
    });

    it('turns "Duplicate login" into a successful, idempotent resolution', async () => {
      http.on('registerPlayer', businessError('Duplicate login'));
      http.on(
        'getPlayersForCurrentAgent',
        playersPage([{ playerId: 'P-9', username: 'player_42' }]),
      );

      expect(await adapter.ensurePlayer(input)).toEqual({
        kind: 'ok',
        data: { ichancyPlayerId: 'P-9', created: false },
      });
    });

    it('settles an ambiguous registration by looking the login up', async () => {
      http.on('registerPlayer', { httpStatus: 500, body: { status: true } });
      http.on(
        'getPlayersForCurrentAgent',
        playersPage([{ playerId: 'P-9', username: 'player_42' }]),
      );

      expect(await adapter.ensurePlayer(input)).toEqual({
        kind: 'ok',
        data: { ichancyPlayerId: 'P-9', created: false },
      });
    });

    it('stays ambiguous when the lookup cannot confirm the registration', async () => {
      http.on('registerPlayer', { httpStatus: 500, body: { status: true } });
      http.on('getPlayersForCurrentAgent', playersPage([]));

      expect((await adapter.ensurePlayer(input)).kind).toBe('ambiguous');
    });

    it('propagates a real validation rejection untouched', async () => {
      http.on('registerPlayer', businessError('ParentId property is required'));

      expect(await adapter.ensurePlayer(input)).toMatchObject({
        kind: 'rejected',
        code: IchancyRejectionCodes.VALIDATION_FAILED,
      });
      expect(http.countFor('getPlayersForCurrentAgent')).toBe(0);
    });
  });

  describe('findPlayerByLogin', () => {
    it('returns null (not an error) when nobody matches', async () => {
      http.on('getPlayersForCurrentAgent', playersPage([]));
      expect(await adapter.findPlayerByLogin('nobody')).toEqual({ kind: 'ok', data: null });
    });

    it('handles the bare-array empty shape documented for getChildren', async () => {
      http.on('getPlayersForCurrentAgent', ok([]));
      expect(await adapter.findPlayerByLogin('nobody')).toEqual({ kind: 'ok', data: null });
    });

    it('refuses to guess when the login is not the one we asked for', async () => {
      http.on(
        'getPlayersForCurrentAgent',
        playersPage([{ playerId: 'P-1', username: 'someoneelse' }]),
      );
      expect(await adapter.findPlayerByLogin('player_42')).toEqual({ kind: 'ok', data: null });
    });

    it('refuses to guess when two players share a login', async () => {
      http.on(
        'getPlayersForCurrentAgent',
        playersPage([
          { playerId: 'P-1', username: 'player_42' },
          { playerId: 'P-2', username: 'PLAYER_42' },
        ]),
      );
      expect((await adapter.findPlayerByLogin('player_42')).kind).toBe('ambiguous');
    });
  });

  describe('getAgentWallet', () => {
    it('decodes the STRING money fields and prefers availableWallet', async () => {
      http.on(
        'getAgentAllWallets',
        ok([
          {
            currencyName: 'New Syrian Pound',
            currencyCode: 'NSP',
            availableWallet: '5000.00',
            mainCurrency: true,
            balance: '5200.50',
            bonus: '0',
            frozenBalance: '200.50',
          },
        ]),
      );

      expect(await adapter.getAgentWallet()).toEqual({
        kind: 'ok',
        data: { balanceMinor: 520_050n, availableMinor: 500_000n },
      });
    });

    it('is ambiguous when the agent has no wallet row at all', async () => {
      http.on('getAgentAllWallets', ok([]));
      expect((await adapter.getAgentWallet()).kind).toBe('ambiguous');
    });

    it('maps "You don\'t have AMD wallet" to a definite rejection', async () => {
      http.on('getAgentAllWallets', businessError("You don't have AMD wallet"));
      expect(await adapter.getAgentWallet()).toMatchObject({
        kind: 'rejected',
        code: IchancyRejectionCodes.NO_WALLET,
      });
    });
  });
});
