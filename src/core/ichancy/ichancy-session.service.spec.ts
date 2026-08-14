/**
 * The property under test is the expensive one: Ichancy keeps ONE token pair per agent, so N
 * concurrent 401s must produce exactly ONE refresh — in this process (shared promise) and across
 * processes (the Redis lock, simulated here by two services sharing one store).
 */
import { type AppConfigService } from '@core/config/config.service';
import { type IchancyAuthClient } from './ichancy-http.client';
import {
  ICHANCY_TOKENS_KEY,
  IchancySessionError,
  IchancySessionService,
} from './ichancy-session.service';
import { InMemoryIchancySessionStore } from './ichancy-session.store';
import { ichancyAmbiguous, ichancyOk, ichancyRejected, type IchancyResult } from './ichancy.types';
import { type IchancyTokenPair } from './ichancy.wire';

type StubOutcome = 'ok' | 'rejected' | 'ambiguous';

class StubAuthClient implements IchancyAuthClient {
  signinCalls = 0;
  refreshCalls = 0;
  signinOutcome: StubOutcome = 'ok';
  refreshOutcome: StubOutcome = 'ok';
  latencyMs = 5;
  private sequence = 0;

  signin(): Promise<IchancyResult<IchancyTokenPair>> {
    this.signinCalls += 1;
    return this.answer(this.signinOutcome, 'signin');
  }

  refresh(_refreshToken: string): Promise<IchancyResult<IchancyTokenPair>> {
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
  accessToken: string,
  refreshToken = 'stored-refresh',
): Promise<void> {
  await store.write(
    ICHANCY_TOKENS_KEY,
    JSON.stringify({
      accessToken,
      refreshToken,
      source: 'signin',
      obtainedAt: new Date().toISOString(),
      generation: 1,
    }),
  );
}

describe('IchancySessionService', () => {
  let store: InMemoryIchancySessionStore;
  let auth: StubAuthClient;

  const worker = (): IchancySessionService =>
    new IchancySessionService(configFor('worker'), store, auth);
  const api = (): IchancySessionService => new IchancySessionService(configFor('api'), store, auth);

  beforeEach(() => {
    store = new InMemoryIchancySessionStore();
    auth = new StubAuthClient();
  });

  it('signs in once for N concurrent cold starts', async () => {
    const service = worker();
    const tokens = await Promise.all(Array.from({ length: 10 }, () => service.getAccessToken()));

    expect(auth.signinCalls).toBe(1);
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toBe('access-signin-1');
  });

  it('reads the stored token without any auth call', async () => {
    await seedSession(store, 'access-existing');
    expect(await worker().getAccessToken()).toBe('access-existing');
    expect(auth.signinCalls).toBe(0);
    expect(auth.refreshCalls).toBe(0);
  });

  it('refreshes ONCE for N concurrent unauthorized answers', async () => {
    await seedSession(store, 'access-stale');
    const service = worker();

    const renewed = await Promise.all(
      Array.from({ length: 8 }, () => service.refreshAfterUnauthorized('access-stale')),
    );

    expect(auth.refreshCalls).toBe(1);
    expect(auth.signinCalls).toBe(0);
    expect(new Set(renewed)).toEqual(new Set(['access-refresh-1']));
  });

  it("takes the other process's token instead of refreshing again", async () => {
    // Somebody already rotated: the stored token differs from the one that failed.
    await seedSession(store, 'access-fresh');
    expect(await worker().refreshAfterUnauthorized('access-stale')).toBe('access-fresh');
    expect(auth.refreshCalls).toBe(0);
  });

  it('serialises two processes sharing one Redis: one signin, both get the same token', async () => {
    auth.latencyMs = 30;
    const [first, second] = await Promise.all([
      worker().getAccessToken(),
      worker().getAccessToken(),
    ]);

    expect(auth.signinCalls).toBe(1);
    expect(first).toBe(second);
  });

  it('falls back to signin when the refresh token is dead (worker only)', async () => {
    await seedSession(store, 'access-stale');
    auth.refreshOutcome = 'rejected';

    const token = await worker().refreshAfterUnauthorized('access-stale');

    expect(auth.refreshCalls).toBe(1);
    expect(auth.signinCalls).toBe(1);
    expect(token).toBe('access-signin-1');
  });

  it('treats an AMBIGUOUS refresh as a dead pair — refresh rotates, so there is nothing to keep', async () => {
    await seedSession(store, 'access-stale');
    auth.refreshOutcome = 'ambiguous';

    await worker().refreshAfterUnauthorized('access-stale');

    expect(auth.refreshCalls).toBe(1);
    expect(auth.signinCalls).toBe(1);
  });

  describe('APP_ROLE=api', () => {
    it('never signs in and says exactly what is wrong', async () => {
      await expect(api().getAccessToken()).rejects.toMatchObject({
        name: 'IchancySessionError',
        code: 'ICHANCY_SESSION_MISSING',
      });
      expect(auth.signinCalls).toBe(0);
    });

    it('may refresh, but cannot recover from a dead refresh token', async () => {
      await seedSession(store, 'access-stale');
      auth.refreshOutcome = 'rejected';

      await expect(api().refreshAfterUnauthorized('access-stale')).rejects.toMatchObject({
        code: 'ICHANCY_SESSION_REAUTH_REQUIRED',
      });
      expect(auth.refreshCalls).toBe(1);
      expect(auth.signinCalls).toBe(0);
    });

    it('refreshes successfully when the pair is still alive', async () => {
      await seedSession(store, 'access-stale');
      expect(await api().refreshAfterUnauthorized('access-stale')).toBe('access-refresh-1');
    });
  });

  it('surfaces a credential rejection as ICHANCY_SIGNIN_REJECTED and stays retryable', async () => {
    auth.signinOutcome = 'rejected';
    const service = worker();

    await expect(service.getAccessToken()).rejects.toBeInstanceOf(IchancySessionError);

    // The in-flight promise must be cleared, otherwise every later call replays the same failure.
    auth.signinOutcome = 'ok';
    expect(await service.getAccessToken()).toBe('access-signin-1');
    expect(auth.signinCalls).toBe(2);
  });

  it('surfaces an ambiguous signin distinctly (we may or may not now own the agent session)', async () => {
    auth.signinOutcome = 'ambiguous';
    await expect(worker().getAccessToken()).rejects.toMatchObject({
      code: 'ICHANCY_SIGNIN_AMBIGUOUS',
    });
  });

  it('describes the session without leaking tokens, and forgets it on invalidate', async () => {
    const service = worker();
    await service.ensureSession();

    const info = await service.describe();
    expect(info).toMatchObject({ hasSession: true, source: 'signin' });
    expect(JSON.stringify(info)).not.toContain('access-signin-1');

    await service.invalidate();
    expect(await service.describe()).toEqual({ hasSession: false });
  });

  it('treats a corrupt stored session as missing rather than crashing the worker', async () => {
    await store.write(ICHANCY_TOKENS_KEY, '{not json');
    expect(await worker().getAccessToken()).toBe('access-signin-1');
  });
});
