/**
 * !!! READ THIS BEFORE TOUCHING ANYTHING IN HERE !!!
 *
 * ICHANCY ALLOWS EXACTLY ONE LIVE TOKEN PAIR PER AGENT ACCOUNT. Not one per process, not one per
 * pod, not one per operator — ONE per agent login, ever. Four consequences, and every line below
 * exists to satisfy them:
 *
 *   1. A second signIn silently kills the first process's tokens. So only APP_ROLE=worker signs in on
 *      demand, and only while holding a distributed lock. The one exception is signInNow(): an
 *      explicit verification a human asked for (activation, a credential edit, a health check),
 *      serialised under the same lock. The rotation it causes is absorbed by rule 3 below: an
 *      in-flight call holding the old token gets one unauthorized answer, finds the new pair in
 *      Redis, and replays once.
 *   2. refreshToken ROTATES: the moment the new pair comes back, the old refresh token is dead. Two
 *      concurrent refreshes therefore guarantee that at least one process is left holding garbage —
 *      and if the answer is ambiguous (timeout), the pair we were holding may already be dead while
 *      the winner's pair is unknown to us.
 *   3. N concurrent 401s must cause exactly ONE refresh. That needs single-flight in this process
 *      (a shared promise) AND across processes (SET NX PX). Both are implemented here.
 *   4. The session belongs to the AGENT, not to the operator. Every key below is built from the
 *      agent key (normalised base URL + username, see ichancy-agent.ts), so operators that share an
 *      agent share one session and one lock instead of signing each other out, and operators with
 *      different agents stay isolated.
 *
 * A stored pair also records the digest of the exact credentials that obtained it. An operator whose
 * digest differs (same login, different stored password) never uses that pair: it must prove its own
 * credentials with a sign-in, which fails when they are wrong. Sharing a session therefore never
 * lends one operator tokens its own credentials could not have obtained.
 *
 * The api role never signs in on demand. It reads the pair the worker put in Redis; if there is none
 * it throws a clear, actionable error instead of quietly authenticating and invalidating the worker's
 * session. It MAY refresh, because a refresh under the lock is still single-writer — but a dead
 * refresh token is only recoverable by the worker.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '@core/config/config.service';
import { type IchancyAgent } from './ichancy-agent';
import { ICHANCY_AUTH_CLIENT, type IchancyAuthClient } from './ichancy-http.client';
import { ICHANCY_SESSION_STORE, type IchancySessionStore } from './ichancy-session.store';
import {
  ichancyAmbiguous,
  ichancyOk,
  isIchancyOk,
  isIchancyRejected,
  type IchancyResult,
} from './ichancy.types';
import { type IchancyTokenPair } from './ichancy.wire';

/**
 * One key holds the whole pair for one agent: reading half a session must be impossible. `v2`
 * because the v1 key was one global pair with no agent in it; nothing reads v1 any more, so the
 * first worker call after a deploy signs in once per agent and the old key expires on its own.
 */
export const ichancyTokensKey = (agentKey: string): string => `ichancy:session:v2:${agentKey}:tokens`;
/** Follows the LockService.key('ichancy','session',...) convention from @core/cache. */
export const ichancySessionLockKey = (agentKey: string): string =>
  `lock:ichancy:session:${agentKey}`;

/** Long enough for a signin round trip on a bad day, short enough that a crashed holder unblocks. */
const LOCK_TTL_MS = 15_000;
/** How long a loser waits for the winner's rotation before giving up. */
const LOCK_WAIT_TOTAL_MS = 15_000;
const LOCK_POLL_DELAY_MS = 150;
/** Refresh tokens live 7 days; a pair older than that is worthless, so let Redis drop it. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type IchancySessionErrorCode =
  | 'ICHANCY_SESSION_MISSING'
  | 'ICHANCY_SESSION_REAUTH_REQUIRED'
  | 'ICHANCY_SESSION_CREDENTIALS_CHANGED'
  | 'ICHANCY_SIGNIN_REJECTED'
  | 'ICHANCY_SIGNIN_AMBIGUOUS'
  | 'ICHANCY_SESSION_LOCK_TIMEOUT';

export class IchancySessionError extends Error {
  constructor(
    readonly code: IchancySessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IchancySessionError';
  }
}

interface StoredSession {
  accessToken: string;
  refreshToken: string;
  source: 'signin' | 'refresh';
  obtainedAt: string;
  /** Monotonic per rotation. Purely diagnostic, but it makes "who rotated last" answerable. */
  generation: number;
  /** Digest of the credentials that obtained this pair; see the header. Empty when unreadable. */
  credentialDigest: string;
}

/** Never exposes the tokens themselves — for /health and admin screens. */
export interface IchancySessionInfo {
  hasSession: boolean;
  /** True when the stored pair was obtained with exactly this agent's credentials. */
  matchesCredentials?: boolean;
  source?: 'signin' | 'refresh';
  obtainedAt?: string;
  generation?: number;
}

/** What a successful explicit sign-in reports. No token, ever. */
export interface IchancySignedIn {
  readonly agentKey: string;
  readonly generation: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseStored(raw: string | null): StoredSession | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Partial<StoredSession>;
  if (typeof candidate.accessToken !== 'string' || candidate.accessToken.length === 0) return null;
  if (typeof candidate.refreshToken !== 'string' || candidate.refreshToken.length === 0)
    return null;
  return {
    accessToken: candidate.accessToken,
    refreshToken: candidate.refreshToken,
    source: candidate.source === 'signin' ? 'signin' : 'refresh',
    obtainedAt: typeof candidate.obtainedAt === 'string' ? candidate.obtainedAt : '',
    generation: typeof candidate.generation === 'number' ? candidate.generation : 0,
    credentialDigest:
      typeof candidate.credentialDigest === 'string' ? candidate.credentialDigest : '',
  };
}

@Injectable()
export class IchancySessionService {
  private readonly logger = new Logger(IchancySessionService.name);
  /**
   * In-process single flight, per agent AND per credential digest: N concurrent 401s for one agent
   * share ONE rotation, and a caller with other credentials never joins a rotation it could not have
   * performed itself.
   */
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly config: AppConfigService,
    @Inject(ICHANCY_SESSION_STORE) private readonly store: IchancySessionStore,
    @Inject(ICHANCY_AUTH_CLIENT) private readonly auth: IchancyAuthClient,
  ) {}

  /** The token to put in the Authorization header for this agent. Signs in on demand (worker only). */
  async getAccessToken(agent: IchancyAgent): Promise<string> {
    const current = this.ours(agent, await this.readSession(agent));
    if (current) return current.accessToken;
    return this.singleFlight(agent, () => this.rotateUnderLock(agent, null));
  }

  /**
   * Called by the adapter when a call came back token_expired. `usedAccessToken` is the token that
   * failed: if Redis already holds a different one, somebody rotated while we were in flight and we
   * simply take theirs — no second refresh, no invalidated pair.
   */
  async refreshAfterUnauthorized(agent: IchancyAgent, usedAccessToken: string | null): Promise<string> {
    const first = await this.singleFlight(agent, () => this.rotateUnderLock(agent, usedAccessToken));
    if (usedAccessToken === null || first !== usedAccessToken) return first;
    // We joined an in-flight rotation that handed back the very token we know is dead (it was
    // started for a different reason). Run one more — still single-flight, so still one refresh.
    return this.singleFlight(agent, () => this.rotateUnderLock(agent, usedAccessToken));
  }

  /** Warm-up hook for the worker (bootstrap). Safe to call repeatedly. */
  async ensureSession(agent: IchancyAgent): Promise<void> {
    await this.getAccessToken(agent);
  }

  /**
   * A REAL sign-in with this agent's credentials, now, in any role — the proof activation and a
   * credential edit rest on. It never trusts a stored pair: a pair proves that someone once signed
   * in, not that these credentials still work.
   *
   * On success the new pair replaces the stored one (the old pair is dead at Ichancy the moment the
   * sign-in succeeds, so keeping it would only hand out dead tokens). On a rejection or an unknown
   * answer the stored pair is left exactly as it was: a refused sign-in does not end the account's
   * existing session.
   */
  async signInNow(agent: IchancyAgent): Promise<IchancyResult<IchancySignedIn>> {
    const deadline = Date.now() + LOCK_WAIT_TOTAL_MS;
    const lockKey = ichancySessionLockKey(agent.agentKey);

    for (;;) {
      const lockToken = await this.store.acquireLock(lockKey, LOCK_TTL_MS);
      if (lockToken !== null) {
        try {
          const before = await this.readSession(agent);
          const signedIn = await this.auth.signin(agent);
          if (!isIchancyOk(signedIn)) return signedIn;
          const generation = (before?.generation ?? 0) + 1;
          await this.persist(agent, signedIn.data, 'signin', before?.generation ?? 0);
          this.logger.log(
            `Signed in to Ichancy for agent ${agent.agentKey} on request (previous pair, if any, is now invalid)`,
          );
          return ichancyOk({ agentKey: agent.agentKey, generation });
        } finally {
          await this.store.releaseLock(lockKey, lockToken);
        }
      }

      if (Date.now() >= deadline) {
        return ichancyAmbiguous(
          `Another process has held the Ichancy session lock of agent ${agent.agentKey} for ` +
            `${String(LOCK_WAIT_TOTAL_MS)}ms; the sign-in was not attempted`,
        );
      }
      await delay(LOCK_POLL_DELAY_MS);
    }
  }

  /**
   * Drops the stored pair of one agent. The next caller signs in (worker) or fails loudly (api). Used
   * when an operator's Ichancy settings move away from this agent.
   */
  async invalidate(agentKey: string): Promise<void> {
    await this.store.remove(ichancyTokensKey(agentKey));
    this.logger.warn(`Ichancy session of agent ${agentKey} cleared from Redis`);
  }

  async describe(agent: IchancyAgent): Promise<IchancySessionInfo> {
    const current = await this.readSession(agent);
    if (!current) return { hasSession: false };
    return {
      hasSession: true,
      matchesCredentials: current.credentialDigest === agent.credentialDigest,
      source: current.source,
      obtainedAt: current.obtainedAt,
      generation: current.generation,
    };
  }

  private ours(agent: IchancyAgent, stored: StoredSession | null): StoredSession | null {
    return stored !== null && stored.credentialDigest === agent.credentialDigest ? stored : null;
  }

  private async singleFlight(agent: IchancyAgent, work: () => Promise<string>): Promise<string> {
    const key = `${agent.agentKey}:${agent.credentialDigest}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const started = work().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, started);
    return started;
  }

  private async readSession(agent: IchancyAgent): Promise<StoredSession | null> {
    const raw = await this.store.read(ichancyTokensKey(agent.agentKey));
    const parsed = parseStored(raw);
    if (raw !== null && parsed === null) {
      this.logger.error(
        `Stored Ichancy session of agent ${agent.agentKey} is corrupt; treating it as missing`,
      );
    }
    return parsed;
  }

  /**
   * Cross-process single flight. Losers do NOT queue up behind the lock to refresh again — they wait
   * for the winner's pair to appear and use it, because a second refresh would kill the first.
   */
  private async rotateUnderLock(agent: IchancyAgent, staleAccessToken: string | null): Promise<string> {
    const deadline = Date.now() + LOCK_WAIT_TOTAL_MS;
    const lockKey = ichancySessionLockKey(agent.agentKey);

    for (;;) {
      const current = this.ours(agent, await this.readSession(agent));
      if (current && staleAccessToken !== null && current.accessToken !== staleAccessToken) {
        return current.accessToken;
      }

      const lockToken = await this.store.acquireLock(lockKey, LOCK_TTL_MS);
      if (lockToken !== null) {
        try {
          // Re-read inside the lock: the previous holder probably just rotated.
          const stored = await this.readSession(agent);
          const fresh = this.ours(agent, stored);
          if (fresh && staleAccessToken === null) return fresh.accessToken;
          if (fresh && staleAccessToken !== null && fresh.accessToken !== staleAccessToken) {
            return fresh.accessToken;
          }
          return await this.authenticate(agent, fresh, stored);
        } finally {
          await this.store.releaseLock(lockKey, lockToken);
        }
      }

      if (Date.now() >= deadline) {
        throw new IchancySessionError(
          'ICHANCY_SESSION_LOCK_TIMEOUT',
          `Another process has held the Ichancy session lock of agent ${agent.agentKey} for ` +
            `${String(LOCK_WAIT_TOTAL_MS)}ms without publishing a token`,
        );
      }
      await delay(LOCK_POLL_DELAY_MS);
    }
  }

  /**
   * MUST only be called while holding the lock. `current` is the stored pair when it was obtained
   * with this agent's credentials; `stored` is whatever is stored, which may belong to other
   * credentials for the same login.
   */
  private async authenticate(
    agent: IchancyAgent,
    current: StoredSession | null,
    stored: StoredSession | null,
  ): Promise<string> {
    if (current) {
      const refreshed = await this.auth.refresh(agent, current.refreshToken);
      if (isIchancyOk(refreshed)) {
        return this.persist(agent, refreshed.data, 'refresh', current.generation);
      }
      this.logger.warn(
        `Ichancy refreshToken failed for agent ${agent.agentKey} ` +
          `(${isIchancyRejected(refreshed) ? refreshed.code : 'ambiguous'}); ` +
          'the stored pair must be assumed dead because refresh rotates',
      );
    }

    if (!this.config.app.isWorker) {
      if (current) {
        throw new IchancySessionError(
          'ICHANCY_SESSION_REAUTH_REQUIRED',
          'The stored Ichancy refresh token is dead. Only APP_ROLE=worker may sign in again.',
        );
      }
      if (stored) {
        throw new IchancySessionError(
          'ICHANCY_SESSION_CREDENTIALS_CHANGED',
          "The stored Ichancy session was obtained with different credentials for this agent's " +
            "login. APP_ROLE=api never signs in — the worker, or a verification from the dashboard, must prove this operator's credentials.",
        );
      }
      throw new IchancySessionError(
        'ICHANCY_SESSION_MISSING',
        'No Ichancy session in Redis for this agent. APP_ROLE=api never signs in — start APP_ROLE=worker first.',
      );
    }

    const signedIn = await this.auth.signin(agent);
    if (isIchancyOk(signedIn)) {
      this.logger.log(
        `Signed in to Ichancy for agent ${agent.agentKey} (previous token pair, if any, is now invalid)`,
      );
      return this.persist(agent, signedIn.data, 'signin', stored?.generation ?? 0);
    }
    if (isIchancyRejected(signedIn)) {
      throw new IchancySessionError(
        'ICHANCY_SIGNIN_REJECTED',
        `Ichancy refused the agent credentials (${signedIn.code}): ${signedIn.message}`,
      );
    }
    throw new IchancySessionError(
      'ICHANCY_SIGNIN_AMBIGUOUS',
      `Ichancy signin did not complete: ${signedIn.cause}`,
    );
  }

  private async persist(
    agent: IchancyAgent,
    pair: IchancyTokenPair,
    source: 'signin' | 'refresh',
    previousGeneration: number,
  ): Promise<string> {
    const session: StoredSession = {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      source,
      obtainedAt: new Date().toISOString(),
      generation: previousGeneration + 1,
      credentialDigest: agent.credentialDigest,
    };
    await this.store.write(ichancyTokensKey(agent.agentKey), JSON.stringify(session), SESSION_TTL_MS);
    return session.accessToken;
  }
}
