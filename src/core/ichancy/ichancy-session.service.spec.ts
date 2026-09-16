/**
 * The property under test is the expensive one: Ichancy keeps ONE token pair per agent, so N
 * concurrent 401s must produce exactly ONE refresh — in this process (shared promise) and across
 * processes (the Redis lock, simulated here by two services sharing one store).
 *
 * And the multi-operator half: sessions are keyed by AGENT, so operators sharing a login share one
 * session and one sign-in, operators on different agents never touch each other's pair, and a stored
 * pair obtained with other credentials for the same login is never lent to a caller whose own
 * credentials could not have obtained it.
 */
import { type AppConfigService } from '@core/config/config.service';
import { ichancyAgentKey, type IchancyAgent } from './ichancy-agent';
import { type IchancyAuthClient } from './ichancy-http.client';
import {
  IchancySessionError,
  IchancySessionService,
  ichancyTokensKey,
} from './ichancy-session.service';
import { InMemoryIchancySessionStore } from './ichancy-session.store';
import { ichancyAmbiguous, ichancyOk, ichancyRejected, type IchancyResult } from './ichancy.types';
import { type IchancyTokenPair } from './ichancy.wire';

type StubOutcome = 'ok' | 'rejected' | 'ambiguous';

function agentFor(
  options: { baseUrl?: string; username?: string; password?: string; tenantId?: string } = {},
): IchancyAgent {
  const baseUrl = options.baseUrl ?? 'https://agents.example.com';
  const username = options.username ?? 'agent_a';
  const password = options.password ?? 'secret-a';
  return {
    tenantId: options.tenantId ?? 'tenant-a',
    baseUrl,
    username,
    password,
    agentId: '1001',
    currency: 'NSP',
    agentKey: ichancyAgentKey(baseUrl, username),
    // The real digest is an HMAC (see the resolver spec); any value derived from both suffices here.
    // Built from the same exact username as the key, as the resolver's is.
    credentialDigest: `digest:${username.trim()}:${password}`,
  };
}

class StubAuthClient implements IchancyAuthClient {
  readonly signins: { agentKey: string; username: string; password: string }[] = [];
  refreshCalls = 0;
  signinOutcome: StubOutcome = 'ok';
  refreshOutcome: StubOutcome = 'ok';
  latencyMs = 5;
  private sequence = 0;

  get signinCalls(): number {
    return this.signins.length;
  }

  signin(agent: IchancyAgent): Promise<IchancyResult<IchancyTokenPair>> {
    this.signins.push({ agentKey: agent.agentKey, username: agent.username, password: agent.password });
    return this.answer(this.signinOutcome, 'signin');
  }

  refresh(_agent: IchancyAgent, _refreshToken: string): Promise<IchancyResult<IchancyTokenPair>> {
    this.refreshCalls += 1;
    return this.answer(this.refreshOutcome, 'refresh');
  }

  private async answer(
    outcome: StubOutcome,
    kind: string,
  ): Promise<IchancyResult<IchancyTokenPair>> {
    await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    if (outcome === 'rejected') return ichancyRejected('INVALID_CREDENTIALS', 'nope');
    if (outcome === 'ambiguous') return ichancyAmbiguous('signin timed out');
    this.sequence += 1;
    return ichancyOk({
      accessToken: `access-${kind}-${String(this.sequence)}`,
      refreshToken: `refresh-${kind}-${String(this.sequence)}`,
    });
  }
}

function configFor(role: 'api' | 'worker'): AppConfigService {
  return {
    app: { isWorker: role === 'worker', isApi: role === 'api', role },
  } as unknown as AppConfigService;
}

async function seedSession(
  store: InMemoryIchancySessionStore,
  agent: IchancyAgent,
  accessToken: string,
  options: { refreshToken?: string; credentialDigest?: string } = {},
): Promise<void> {
  await store.write(
    ichancyTokensKey(agent.agentKey),
    JSON.stringify({
      accessToken,
      refreshToken: options.refreshToken ?? 'stored-refresh',
      source: 'signin',
      obtainedAt: new Date().toISOString(),
      generation: 1,
      credentialDigest: options.credentialDigest ?? agent.credentialDigest,
    }),
  );
}

describe('IchancySessionService', () => {
  let store: InMemoryIchancySessionStore;
  let auth: StubAuthClient;
  const A = agentFor();

  const worker = (): IchancySessionService =>
    new IchancySessionService(configFor('worker'), store, auth);
  const api = (): IchancySessionService => new IchancySessionService(configFor('api'), store, auth);

  beforeEach(() => {
    store = new InMemoryIchancySessionStore();
    auth = new StubAuthClient();
  });

  it('signs in once for N concurrent cold starts', async () => {
    const service = worker();
    const tokens = await Promise.all(Array.from({ length: 10 }, () => service.getAccessToken(A)));

    expect(auth.signinCalls).toBe(1);
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toBe('access-signin-1');
  });

  it('reads the stored token without any auth call', async () => {
    await seedSession(store, A, 'access-existing');
    expect(await worker().getAccessToken(A)).toBe('access-existing');
    expect(auth.signinCalls).toBe(0);
    expect(auth.refreshCalls).toBe(0);
  });

  it('refreshes ONCE for N concurrent unauthorized answers', async () => {
    await seedSession(store, A, 'access-stale');
    const service = worker();

    const renewed = await Promise.all(
      Array.from({ length: 8 }, () => service.refreshAfterUnauthorized(A, 'access-stale')),
    );

    expect(auth.refreshCalls).toBe(1);
    expect(auth.signinCalls).toBe(0);
    expect(new Set(renewed)).toEqual(new Set(['access-refresh-1']));
  });

  it("takes the other process's token instead of refreshing again", async () => {
    // Somebody already rotated: the stored token differs from the one that failed.
    await seedSession(store, A, 'access-fresh');
    expect(await worker().refreshAfterUnauthorized(A, 'access-stale')).toBe('access-fresh');
    expect(auth.refreshCalls).toBe(0);
  });

  it('serialises two processes sharing one Redis: one signin, both get the same token', async () => {
    auth.latencyMs = 30;
    const [first, second] = await Promise.all([
      worker().getAccessToken(A),
      worker().getAccessToken(A),
    ]);

    expect(auth.signinCalls).toBe(1);
    expect(first).toBe(second);
  });

  it('falls back to signin when the refresh token is dead (worker only)', async () => {
    await seedSession(store, A, 'access-stale');
    auth.refreshOutcome = 'rejected';

    const token = await worker().refreshAfterUnauthorized(A, 'access-stale');

    expect(auth.refreshCalls).toBe(1);
    expect(auth.signinCalls).toBe(1);
    expect(token).toBe('access-signin-1');
  });

  it('treats an AMBIGUOUS refresh as a dead pair — refresh rotates, so there is nothing to keep', async () => {
    await seedSession(store, A, 'access-stale');
    auth.refreshOutcome = 'ambiguous';

    await worker().refreshAfterUnauthorized(A, 'access-stale');

    expect(auth.refreshCalls).toBe(1);
    expect(auth.signinCalls).toBe(1);
  });

  describe('APP_ROLE=api', () => {
    it('never signs in and says exactly what is wrong', async () => {
      await expect(api().getAccessToken(A)).rejects.toMatchObject({
        name: 'IchancySessionError',
        code: 'ICHANCY_SESSION_MISSING',
      });
      expect(auth.signinCalls).toBe(0);
    });

    it('may refresh, but cannot recover from a dead refresh token', async () => {
      await seedSession(store, A, 'access-stale');
      auth.refreshOutcome = 'rejected';

      await expect(api().refreshAfterUnauthorized(A, 'access-stale')).rejects.toMatchObject({
        code: 'ICHANCY_SESSION_REAUTH_REQUIRED',
      });
      expect(auth.refreshCalls).toBe(1);
      expect(auth.signinCalls).toBe(0);
    });

    it('refreshes successfully when the pair is still alive', async () => {
      await seedSession(store, A, 'access-stale');
      expect(await api().refreshAfterUnauthorized(A, 'access-stale')).toBe('access-refresh-1');
    });
  });

  it('surfaces a credential rejection as ICHANCY_SIGNIN_REJECTED and stays retryable', async () => {
    auth.signinOutcome = 'rejected';
    const service = worker();

    await expect(service.getAccessToken(A)).rejects.toBeInstanceOf(IchancySessionError);

    // The in-flight promise must be cleared, otherwise every later call replays the same failure.
    auth.signinOutcome = 'ok';
    expect(await service.getAccessToken(A)).toBe('access-signin-1');
    expect(auth.signinCalls).toBe(2);
  });

  it('surfaces an ambiguous signin distinctly (we may or may not now own the agent session)', async () => {
    auth.signinOutcome = 'ambiguous';
    await expect(worker().getAccessToken(A)).rejects.toMatchObject({
      code: 'ICHANCY_SIGNIN_AMBIGUOUS',
    });
  });

  it('describes the session without leaking tokens, and forgets it on invalidate', async () => {
    const service = worker();
    await service.ensureSession(A);

    const info = await service.describe(A);
    expect(info).toMatchObject({ hasSession: true, source: 'signin', matchesCredentials: true });
    expect(JSON.stringify(info)).not.toContain('access-signin-1');

    await service.invalidate(A.agentKey);
    expect(await service.describe(A)).toEqual({ hasSession: false });
  });

  it('treats a corrupt stored session as missing rather than crashing the worker', async () => {
    await store.write(ichancyTokensKey(A.agentKey), '{not json');
    expect(await worker().getAccessToken(A)).toBe('access-signin-1');
  });

  describe('keyed by agent, not by operator', () => {
    it('lets two operators sharing one agent reuse ONE session and ONE sign-in', async () => {
      // Two operators, one Ichancy login with the same password: one account, one token pair.
      const north = agentFor({ tenantId: 'tenant-north' });
      const south = agentFor({ tenantId: 'tenant-south' });
      const service = worker();

      const first = await service.getAccessToken(north);
      const second = await service.getAccessToken(south);

      expect(auth.signinCalls).toBe(1);
      expect(second).toBe(first);
      expect(await store.read(ichancyTokensKey(north.agentKey))).not.toBeNull();
      expect(north.agentKey).toBe(south.agentKey);
    });

    it('normalises the host spelling and login padding, but compares the login itself exactly', () => {
      expect(ichancyAgentKey('HTTPS://Agents.Example.com/', ' agent_a ')).toBe(
        ichancyAgentKey('https://agents.example.com', 'agent_a'),
      );
      expect(ichancyAgentKey('https://agents.example.com', 'agent_a')).not.toBe(
        ichancyAgentKey('https://agents.other.example', 'agent_a'),
      );
      // As the dashboard matches sharesAgentWith; see ichancy-agent.ts for why case is not folded.
      expect(ichancyAgentKey('https://agents.example.com', 'AGENT_A')).not.toBe(
        ichancyAgentKey('https://agents.example.com', 'agent_a'),
      );
    });

    it('never lets two logins differing only in case sign each other out: alternating calls sign in once each', async () => {
      const lower = agentFor({ username: 'agent_a', password: 'same-password', tenantId: 'tenant-lower' });
      const upper = agentFor({ username: 'AGENT_A', password: 'same-password', tenantId: 'tenant-upper' });
      const service = worker();

      const tokens: string[] = [];
      for (let round = 0; round < 3; round += 1) {
        tokens.push(await service.getAccessToken(lower));
        tokens.push(await service.getAccessToken(upper));
      }

      // One key and one digest per spelling, so neither ever finds the other's pair and re-signs in.
      expect(auth.signinCalls).toBe(2);
      expect(new Set(tokens.filter((_, index) => index % 2 === 0)).size).toBe(1);
      expect(new Set(tokens.filter((_, index) => index % 2 === 1)).size).toBe(1);
      expect(lower.agentKey).not.toBe(upper.agentKey);
    });

    it("keeps different agents' pairs apart: each signs in with its own credentials", async () => {
      const a = agentFor({ username: 'agent_a', password: 'secret-a', tenantId: 'tenant-a' });
      const b = agentFor({ username: 'agent_b', password: 'secret-b', tenantId: 'tenant-b' });
      const service = worker();

      const tokenA = await service.getAccessToken(a);
      const tokenB = await service.getAccessToken(b);

      expect(tokenA).not.toBe(tokenB);
      expect(auth.signins).toEqual([
        { agentKey: a.agentKey, username: 'agent_a', password: 'secret-a' },
        { agentKey: b.agentKey, username: 'agent_b', password: 'secret-b' },
      ]);
      // Rotating one agent's pair leaves the other's exactly as it was.
      await service.refreshAfterUnauthorized(a, tokenA);
      expect(await service.getAccessToken(b)).toBe(tokenB);
    });

    it('never lends a pair obtained with another password for the same login', async () => {
      const serving = agentFor({ password: 'right-password', tenantId: 'tenant-serving' });
      const stale = agentFor({ password: 'old-password', tenantId: 'tenant-stale' });
      await seedSession(store, serving, 'access-serving');

      // The api role cannot sign in, so it says precisely why it has no token.
      await expect(api().getAccessToken(stale)).rejects.toMatchObject({
        code: 'ICHANCY_SESSION_CREDENTIALS_CHANGED',
      });

      // The worker proves the stale operator's OWN credentials; a refusal leaves the serving pair intact.
      auth.signinOutcome = 'rejected';
      await expect(worker().getAccessToken(stale)).rejects.toMatchObject({
        code: 'ICHANCY_SIGNIN_REJECTED',
      });
      expect(auth.signins).toEqual([
        { agentKey: stale.agentKey, username: stale.username, password: 'old-password' },
      ]);
      expect(await worker().getAccessToken(serving)).toBe('access-serving');
    });
  });

  describe('signInNow', () => {
    it('always makes a real sign-in, even over a stored pair, and replaces it — in the api role too', async () => {
      await seedSession(store, A, 'access-old');

      const result = await api().signInNow(A);

      expect(result).toEqual({ kind: 'ok', data: { agentKey: A.agentKey, generation: 2 } });
      expect(auth.signinCalls).toBe(1);
      expect(await api().getAccessToken(A)).toBe('access-signin-1');
    });

    it('leaves the stored pair untouched when Ichancy refuses or does not answer', async () => {
      await seedSession(store, A, 'access-old');
      const wrong = agentFor({ password: 'wrong' });

      auth.signinOutcome = 'rejected';
      expect((await api().signInNow(wrong)).kind).toBe('rejected');
      auth.signinOutcome = 'ambiguous';
      expect((await api().signInNow(wrong)).kind).toBe('ambiguous');

      expect(await api().getAccessToken(A)).toBe('access-old');
    });

    it('stores the new pair under the proven credentials, so a changed password takes over the login', async () => {
      const before = agentFor({ password: 'before' });
      const after = agentFor({ password: 'after' });
      await seedSession(store, before, 'access-before');

      await worker().signInNow(after);

      expect(await api().getAccessToken(after)).toBe('access-signin-1');
      await expect(api().getAccessToken(before)).rejects.toMatchObject({
        code: 'ICHANCY_SESSION_CREDENTIALS_CHANGED',
      });
    });
  });
});
