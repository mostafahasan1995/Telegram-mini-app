/**
 * !!! READ THIS BEFORE TOUCHING ANYTHING IN HERE !!!
 *
 * ICHANCY ALLOWS EXACTLY ONE LIVE TOKEN PAIR PER AGENT ACCOUNT. Not one per process, not one per
 * pod — ONE, ever. Three consequences, and every line below exists to satisfy them:
 *
 *   1. A second signIn silently kills the first process's tokens. So only APP_ROLE=worker may sign
 *      in, and only while holding a distributed lock.
 *   2. refreshToken ROTATES: the moment the new pair comes back, the old refresh token is dead. Two
 *      concurrent refreshes therefore guarantee that at least one process is left holding garbage —
 *      and if the answer is ambiguous (timeout), the pair we were holding may already be dead while
 *      the winner's pair is unknown to us.
 *   3. N concurrent 401s must cause exactly ONE refresh. That needs single-flight in this process
 *      (a shared promise) AND across processes (SET NX PX). Both are implemented here.
 *
 * The api role never signs in. It reads the pair the worker put in Redis; if there is none it throws
 * a clear, actionable error instead of quietly authenticating and invalidating the worker's session.
 * It MAY refresh, because a refresh under the lock is still single-writer — but a dead refresh token
 * is only recoverable by the worker.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '@core/config/config.service';
import { ICHANCY_AUTH_CLIENT, type IchancyAuthClient } from './ichancy-http.client';
import { ICHANCY_SESSION_STORE, type IchancySessionStore } from './ichancy-session.store';
import { isIchancyOk, isIchancyRejected } from './ichancy.types';
import { type IchancyTokenPair } from './ichancy.wire';

/** One key holds the whole pair: reading half a session must be impossible. */
export const ICHANCY_TOKENS_KEY = 'ichancy:session:v1:tokens';
/** Follows the LockService.key('ichancy','session') convention from @core/cache. */
export const ICHANCY_SESSION_LOCK_KEY = 'lock:ichancy:session';

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
}

/** Never exposes the tokens themselves — for /health and admin screens. */
export interface IchancySessionInfo {
  hasSession: boolean;
  source?: 'signin' | 'refresh';
  obtainedAt?: string;
  generation?: number;
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
  };
}

@Injectable()
export class IchancySessionService {
  private readonly logger = new Logger(IchancySessionService.name);
  /** In-process single flight: N concurrent 401s share ONE rotation. */
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly config: AppConfigService,
    @Inject(ICHANCY_SESSION_STORE) private readonly store: IchancySessionStore,
    @Inject(ICHANCY_AUTH_CLIENT) private readonly auth: IchancyAuthClient,
  ) {}

  /** The token to put in the Authorization header. Signs in on demand (worker only). */
  async getAccessToken(): Promise<string> {
    const current = await this.readSession();
    if (current) return current.accessToken;
    return this.singleFlight(() => this.rotateUnderLock(null));
  }

  /**
   * Called by the adapter when a call came back token_expired. `usedAccessToken` is the token that
   * failed: if Redis already holds a different one, somebody rotated while we were in flight and we
   * simply take theirs — no second refresh, no invalidated pair.
   */
  async refreshAfterUnauthorized(usedAccessToken: string | null): Promise<string> {
    const first = await this.singleFlight(() => this.rotateUnderLock(usedAccessToken));
    if (usedAccessToken === null || first !== usedAccessToken) return first;
    // We joined an in-flight rotation that handed back the very token we know is dead (it was
    // started for a different reason). Run one more — still single-flight, so still one refresh.
    return this.singleFlight(() => this.rotateUnderLock(usedAccessToken));
  }

  /** Warm-up hook for the worker (cron/bootstrap). Safe to call repeatedly. */
  async ensureSession(): Promise<void> {
    await this.getAccessToken();
  }

  /** Drops the stored pair. The next caller signs in (worker) or fails loudly (api). */
  async invalidate(): Promise<void> {
    await this.store.remove(ICHANCY_TOKENS_KEY);
    this.logger.warn('Ichancy session cleared from Redis');
  }

  async describe(): Promise<IchancySessionInfo> {
    const current = await this.readSession();
    if (!current) return { hasSession: false };
    return {
      hasSession: true,
      source: current.source,
      obtainedAt: current.obtainedAt,
      generation: current.generation,
    };
  }

  private async singleFlight(work: () => Promise<string>): Promise<string> {
    const existing = this.inflight;
    if (existing) return existing;
    const started = work().finally(() => {
      this.inflight = null;
    });
    this.inflight = started;
    return started;
  }

  private async readSession(): Promise<StoredSession | null> {
    const raw = await this.store.read(ICHANCY_TOKENS_KEY);
    const parsed = parseStored(raw);
    if (raw !== null && parsed === null) {
      this.logger.error('Stored Ichancy session is corrupt; treating it as missing');
    }
    return parsed;
  }

  /**
   * Cross-process single flight. Losers do NOT queue up behind the lock to refresh again — they wait
   * for the winner's pair to appear and use it, because a second refresh would kill the first.
   */
  private async rotateUnderLock(staleAccessToken: string | null): Promise<string> {
    const deadline = Date.now() + LOCK_WAIT_TOTAL_MS;

    for (;;) {
      const current = await this.readSession();
      if (current && staleAccessToken !== null && current.accessToken !== staleAccessToken) {
        return current.accessToken;
      }

      const lockToken = await this.store.acquireLock(ICHANCY_SESSION_LOCK_KEY, LOCK_TTL_MS);
      if (lockToken !== null) {
        try {
          // Re-read inside the lock: the previous holder probably just rotated.
          const fresh = await this.readSession();
          if (fresh && staleAccessToken === null) return fresh.accessToken;
          if (fresh && staleAccessToken !== null && fresh.accessToken !== staleAccessToken) {
            return fresh.accessToken;
          }
          return await this.authenticate(fresh);
        } finally {
          await this.store.releaseLock(ICHANCY_SESSION_LOCK_KEY, lockToken);
        }
      }

      if (Date.now() >= deadline) {
        throw new IchancySessionError(
          'ICHANCY_SESSION_LOCK_TIMEOUT',
          `Another process has held the Ichancy session lock for ${String(LOCK_WAIT_TOTAL_MS)}ms without publishing a token`,
        );
      }
      await delay(LOCK_POLL_DELAY_MS);
    }
  }

  /** MUST only be called while holding the lock. */
  private async authenticate(current: StoredSession | null): Promise<string> {
    if (current) {
      const refreshed = await this.auth.refresh(current.refreshToken);
      if (isIchancyOk(refreshed)) {
        return this.persist(refreshed.data, 'refresh', current.generation);
      }
      this.logger.warn(
        `Ichancy refreshToken failed (${isIchancyRejected(refreshed) ? refreshed.code : 'ambiguous'}); ` +
          'the stored pair must be assumed dead because refresh rotates',
      );
    }

    if (!this.config.app.isWorker) {
      throw new IchancySessionError(
        current ? 'ICHANCY_SESSION_REAUTH_REQUIRED' : 'ICHANCY_SESSION_MISSING',
        current
          ? 'The stored Ichancy refresh token is dead. Only APP_ROLE=worker may sign in again.'
          : 'No Ichancy session in Redis. APP_ROLE=api never signs in — start APP_ROLE=worker first.',
      );
    }

    const signedIn = await this.auth.signin();
    if (isIchancyOk(signedIn)) {
      this.logger.log('Signed in to Ichancy (previous token pair, if any, is now invalid)');
      return this.persist(signedIn.data, 'signin', current?.generation ?? 0);
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
    };
    await this.store.write(ICHANCY_TOKENS_KEY, JSON.stringify(session), SESSION_TTL_MS);
    return session.accessToken;
  }
}
