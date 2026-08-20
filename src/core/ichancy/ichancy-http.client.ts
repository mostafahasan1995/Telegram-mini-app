/**
 * WHY: one place performs the actual POST, and it is the same one that writes the ichancy_calls row.
 * Splitting transport from the adapter also breaks a cycle: the session service must call
 * signin/refreshToken, but signin/refreshToken must NOT go through the token-injecting adapter.
 *
 * Nothing here decides business meaning — it hands the raw envelope plus a classification back and
 * lets the adapter map it to an IchancyResult. Nothing here retries either: a retry is a policy
 * decision about money and belongs one layer up, where "at most once more" is enforced.
 */
import { Injectable, Logger, Inject } from '@nestjs/common';
import { IchancyOutcome, type IchancyOperation } from '@prisma/client';
import { AppConfigService } from '@core/config/config.service';
import {
  classifyEnvelope,
  classifyTransportFailure,
  cloudflareClassification,
  isCloudflareChallenge,
  isTimeoutError,
  type IchancyClassification,
} from './error-map';
import {
  ICHANCY_CALL_LOG,
  type IchancyCallLogPort,
  type IchancyCallRecord,
} from './ichancy-call-log.service';
import { IchancyHealthService } from './ichancy-health.service';
import { type IchancyCallContext } from './ichancy.port';
import {
  ichancyAmbiguous,
  ichancyOk,
  ichancyRejected,
  IchancyRejectionCodes,
  type IchancyResult,
} from './ichancy.types';
import {
  ICHANCY_API_PREFIX,
  IchancyEndpoint,
  readTokenPair,
  toEnvelope,
  type IchancyEndpointName,
  type IchancyEnvelope,
  type IchancyTokenPair,
} from './ichancy.wire';
import { ICHANCY_TRANSPORT, type IchancyTransport } from './transport/ichancy-transport';

export interface IchancyCallParams {
  readonly operation: IchancyOperation;
  readonly endpoint: IchancyEndpointName;
  readonly body: Record<string, unknown>;
  /** Omitted for signin/refreshToken; required for everything else. */
  readonly accessToken?: string | null;
  /** 1-based. The adapter passes 2 for the post-refresh replay. */
  readonly attempt: number;
  readonly context?: IchancyCallContext;
}

export interface IchancyAttempt {
  readonly classification: IchancyClassification;
  readonly httpStatus: number | null;
  readonly envelope: IchancyEnvelope | null;
  readonly durationMs: number;
}

/** Narrow surface the session service needs, so it can be unit-tested without a socket. */
export const ICHANCY_AUTH_CLIENT = 'ICHANCY_AUTH_CLIENT';

export interface IchancyAuthClient {
  /** Uses the agent credentials from config. Worker-only by policy — enforced by the session. */
  signin(): Promise<IchancyResult<IchancyTokenPair>>;
  refresh(refreshToken: string): Promise<IchancyResult<IchancyTokenPair>>;
}

function outcomeFor(classification: IchancyClassification): IchancyOutcome {
  switch (classification.outcome) {
    case 'ok':
      return IchancyOutcome.OK;
    case 'rejected':
    case 'already_exists':
      return IchancyOutcome.REJECTED;
    case 'token_expired':
      return IchancyOutcome.TOKEN_EXPIRED;
    case 'ambiguous':
      if (classification.rule === 'TIMEOUT') return IchancyOutcome.TIMEOUT;
      if (classification.rule === 'TRANSPORT_ERROR') return IchancyOutcome.TRANSPORT_ERROR;
      return IchancyOutcome.AMBIGUOUS;
  }
}

@Injectable()
export class IchancyHttpClient implements IchancyAuthClient {
  private readonly logger = new Logger(IchancyHttpClient.name);

  constructor(
    private readonly config: AppConfigService,
    @Inject(ICHANCY_CALL_LOG) private readonly callLog: IchancyCallLogPort,
    // HOW the bytes leave this process — Node's fetch, or a real Chromium when Cloudflare is in the
    // way. Everything in this class is identical either way; see transport/ichancy-transport.ts.
    @Inject(ICHANCY_TRANSPORT) private readonly transport: IchancyTransport,
    // The one choke point every agent-API call passes through, in both roles — which is exactly why
    // the outage breaker is fed from here and not from a cron that would only ever see its own
    // endpoint failing.
    private readonly health: IchancyHealthService,
  ) {}

  /**
   * POST one endpoint, log the attempt, classify it. Never throws: a transport failure comes back as
   * an `ambiguous` classification with httpStatus null, because "the socket died" tells us nothing
   * about whether the far side moved money.
   */
  async call(params: IchancyCallParams): Promise<IchancyAttempt> {
    const url = `${this.config.ichancy.baseUrl}${ICHANCY_API_PREFIX}/${params.endpoint}`;

    const startedAt = Date.now();
    let httpStatus: number | null = null;
    let envelope: IchancyEnvelope | null = null;
    let responseForLog: unknown = null;
    let classification: IchancyClassification;

    try {
      const response = await this.transport.post({
        url,
        body: params.body,
        accessToken: params.accessToken ?? null,
        timeoutMs: this.config.ichancy.timeoutMs,
      });
      httpStatus = response.status;

      const text = response.text;
      let parsed: unknown = null;
      try {
        parsed = text.length > 0 ? (JSON.parse(text) as unknown) : null;
      } catch {
        parsed = null;
      }
      envelope = toEnvelope(parsed);
      responseForLog = envelope === null ? { rawBody: text.slice(0, 2_000) } : parsed;

      // BEFORE classifyEnvelope, and the order is load-bearing: a Cloudflare challenge is an HTTP
      // 403, 403 is in isUnauthorizedHttpStatus, so classifying it normally would read "token
      // expired" and spend the agent's single refresh token on a problem no token can fix.
      classification = isCloudflareChallenge(httpStatus, text, response.contentType)
        ? cloudflareClassification(httpStatus)
        : classifyEnvelope(httpStatus, envelope);
    } catch (error) {
      classification = classifyTransportFailure(error);
      responseForLog = {
        transportError: error instanceof Error ? error.message : String(error),
        timeout: isTimeoutError(error),
      };
    }

    // Fed before the call-log INSERT so the cluster-wide verdict is current even when the log
    // write is slow. `record` swallows its own failures: instrumentation may never break a call.
    await this.health.record(params.endpoint, classification);

    const durationMs = Date.now() - startedAt;
    await this.persist({
      operation: params.operation,
      attempt: params.attempt,
      httpStatus,
      outcome: outcomeFor(classification),
      requestBody: params.body,
      responseBody: responseForLog,
      errorCode: classification.outcome === 'ok' ? null : classification.code,
      errorMessage: classification.outcome === 'ok' ? null : classification.message,
      durationMs,
      depositRequestId: params.context?.depositRequestId ?? null,
      playerId: params.context?.playerId ?? null,
      correlationId: params.context?.correlationId ?? null,
    });

    if (classification.outcome !== 'ok') {
      this.logger.warn(
        `${params.endpoint} attempt ${String(params.attempt)} -> ${classification.outcome} ` +
          `(${classification.code}) http=${httpStatus === null ? 'none' : String(httpStatus)} ` +
          `in ${String(durationMs)}ms: ${classification.message}`,
      );
    }

    return { classification, httpStatus, envelope, durationMs };
  }

  async signin(): Promise<IchancyResult<IchancyTokenPair>> {
    const attempt = await this.call({
      operation: 'SIGNIN',
      endpoint: IchancyEndpoint.SIGNIN,
      body: {
        username: this.config.ichancy.username,
        password: this.config.ichancy.password,
      },
      attempt: 1,
    });
    // A token_expired classification on signin is meaningless (there is no token to refresh yet):
    // the documented failure is HTTP 201 + "Invalid username or password.", so treat any auth-shaped
    // answer here as a hard credential rejection rather than looping back into a refresh.
    return this.toTokenPair(attempt, IchancyRejectionCodes.INVALID_CREDENTIALS);
  }

  async refresh(refreshToken: string): Promise<IchancyResult<IchancyTokenPair>> {
    const attempt = await this.call({
      operation: 'REFRESH_TOKEN',
      endpoint: IchancyEndpoint.REFRESH_TOKEN,
      body: { refreshToken },
      attempt: 1,
    });
    // "Invalid or expired refresh token" is a definite NO: the stored pair is dead and only a fresh
    // signin can recover. That is why it surfaces as `rejected`, not as `token_expired`.
    return this.toTokenPair(attempt, 'REFRESH_TOKEN_DEAD');
  }

  private toTokenPair(
    attempt: IchancyAttempt,
    authFailureCode: string,
  ): IchancyResult<IchancyTokenPair> {
    const { classification } = attempt;
    if (classification.outcome === 'ok') {
      const pair = readTokenPair(attempt.envelope?.result);
      if (!pair) {
        return ichancyAmbiguous('Auth call reported success but returned no usable token pair');
      }
      return ichancyOk(pair);
    }
    if (classification.outcome === 'rejected' || classification.outcome === 'already_exists') {
      return ichancyRejected(classification.code, classification.message);
    }
    if (classification.outcome === 'token_expired') {
      return ichancyRejected(authFailureCode, classification.message);
    }
    return ichancyAmbiguous(classification.message);
  }

  private async persist(entry: IchancyCallRecord): Promise<void> {
    try {
      await this.callLog.record(entry);
    } catch (error) {
      this.logger.error(
        `ichancy call log threw (this should be impossible): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
