/**
 * WHOSE AGENT ACCOUNT IS THIS CALL MADE WITH? — the one question every Ichancy call now answers first.
 *
 * ══ AN OPERATOR IS AN AGENT ══════════════════════════════════════════════════════════════════════
 * Each operator (tenant) holds its own Ichancy agent: `ichancy_base_url`, `ichancy_username`, the
 * sealed `ichancy_password_enc`, `ichancy_agent_id` and the `currency_code` it trades in. Every call
 * made for that operator's players and money uses exactly those, and never another operator's or a
 * deployment-wide env account (dashboard docs/API-CONTRACT.md §2b; TENANT-OPERATIONS.md §3). The
 * operator comes from the tenant context, so a call made with no operator in context has no agent and
 * fails loudly instead of borrowing one.
 *
 * ══ THE AGENT KEY: WHY THE SESSION BELONGS TO THE LOGIN AND NOT TO THE OPERATOR ═══════════════════
 * Ichancy issues ONE token pair per agent account, and a sign-in kills the previous pair. Two
 * operators configured with the same base URL and username are therefore one session whether anyone
 * meant them to be or not. Keying sessions by operator made them knock each other's tokens out on
 * every refresh; keying them by agent identity makes them share one session and one lock, which is
 * what Ichancy actually has. The agent id is deliberately NOT part of the key: it is the parent new
 * players hang off, not part of the login (TENANT-OPERATIONS.md §6, detail 1).
 *
 * The base URL is normalised (scheme and host lower-cased, trailing slashes dropped: a host is
 * case-insensitive by definition, so that spelling can never name two accounts). The username is only
 * TRIMMED, never case-folded, which is exactly how the dashboard matches `sharesAgentWith`
 * (`ichancyBaseUrl + '|' + ichancyUsername`, TENANT-OPERATIONS.md §6 detail 1). PLAYER logins are
 * looked up case-insensitively elsewhere, where a false match only finds an account we then verify;
 * this key instead decides whose tokens a call carries, and nothing we hold says AGENT logins fold
 * case. Folding `Agent1` into `agent1` would, if they do not, let one operator draw on tokens another
 * account obtained: a money leak, where the opposite mistake (two spellings of one real login kept
 * apart) costs sign-ins but never crosses accounts. The key and the
 * credential digest below must agree on this, or two operators land on one key with two digests and
 * sign each other out on every call. The password never appears in a key.
 *
 * ══ THE CREDENTIAL DIGEST: WHY SHARING A LOGIN DOES NOT MEAN SHARING A PASSWORD ════════════════════
 * Two operators can name the same login with different stored passwords, for example after the
 * password was changed on one of them. Sharing the session there would let an operator whose stored
 * password is wrong keep working on tokens somebody else proved. So a stored session records a keyed
 * digest of the exact username and password that obtained it, and a caller whose digest differs does
 * not use it: it has to sign in with its own credentials, which fail if they are wrong. The digest is
 * an HMAC under a key derived from the root secret, so a Redis dump does not hand anyone a cheap
 * offline guess at an agent password.
 */
import { createHash } from 'node:crypto';

/** The non-secret half of an agent: enough to key a session and to address a request. */
export interface IchancyAgentIdentity {
  /** Normalised: `https://agents.example.com`, no trailing slash. */
  readonly baseUrl: string;
  /** As stored on the operator's row (trimmed). This exact string is what signin receives. */
  readonly username: string;
  /** sha256(normalised base URL | trimmed username), 32 hex characters. Never contains a secret. */
  readonly agentKey: string;
}

/** Everything a call needs to act as one operator's agent. The password is plaintext: never log it. */
export interface IchancyAgent extends IchancyAgentIdentity {
  /** The operator these credentials were read from. */
  readonly tenantId: string;
  readonly password: string;
  /** `parentId` on registerPlayer. */
  readonly agentId: string;
  /** The operator's currency: the wallet row read and the currency sent on money moves. */
  readonly currency: string;
  /** Keyed digest of the exact username and password. See the header. */
  readonly credentialDigest: string;
}

/** Credentials that are not stored yet, for example a PATCH being verified before it is saved. */
export interface IchancyAgentCandidate {
  readonly tenantId: string;
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly agentId: string;
  readonly currency: string;
}

/** DI token. `@Inject(ICHANCY_AGENT_RESOLVER) private readonly agents: IchancyAgentResolver`. */
export const ICHANCY_AGENT_RESOLVER = 'ICHANCY_AGENT_RESOLVER';

export interface IchancyAgentResolver {
  /**
   * The agent of the operator in the tenant context. Throws IchancyAgentUnavailableError: with
   * NO_TENANT_CONTEXT when there is no operator (a programming error), and with one of the other
   * codes when the operator has no usable agent.
   */
  forCurrentTenant(): Promise<IchancyAgent>;
  /** The agent of a named operator, read fresh from its row. Same errors as forCurrentTenant. */
  forTenant(tenantId: string): Promise<IchancyAgent>;
  /** Unsaved credentials shaped as an agent, with its key and digest. Reads nothing. */
  fromCandidate(candidate: IchancyAgentCandidate): IchancyAgent;
}

export const IchancyAgentErrorCodes = {
  /** No operator in the tenant context. A worker, cron or CLI path that never entered runWithTenant. */
  NO_TENANT_CONTEXT: 'ICHANCY_NO_TENANT_CONTEXT',
  /** Tenant zero is the platform: it has no agent and no players. */
  PLATFORM_HAS_NO_AGENT: 'ICHANCY_PLATFORM_HAS_NO_AGENT',
  /** The operator in context has no row (deleted, or a stale id). */
  TENANT_NOT_FOUND: 'ICHANCY_TENANT_NOT_FOUND',
  /** The row's username, agent id or password is missing, a placeholder, or does not open. */
  AGENT_UNCONFIGURED: 'ICHANCY_AGENT_UNCONFIGURED',
} as const;

export type IchancyAgentErrorCode =
  (typeof IchancyAgentErrorCodes)[keyof typeof IchancyAgentErrorCodes];

/** Never carries a credential: messages name the operator and the missing piece only. */
export class IchancyAgentUnavailableError extends Error {
  constructor(
    readonly code: IchancyAgentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IchancyAgentUnavailableError';
  }
}

export const isIchancyAgentUnavailableError = (
  value: unknown,
): value is IchancyAgentUnavailableError => value instanceof IchancyAgentUnavailableError;

/**
 * `HTTPS://Agents.Example.com/` -> `https://agents.example.com`. A path is kept (with its case) because
 * a deployment behind a prefix is a different address; query and fragment are dropped because a base
 * URL has neither. Something that will not parse is returned trimmed, so it still keys consistently
 * and fails at the first request with a transport error rather than here.
 */
export function normaliseIchancyBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${path}`;
  } catch {
    return trimmed;
  }
}

/**
 * The key two operators share exactly when they name one agent account. The username is compared
 * exactly (trimmed only); see the header for why it is not case-folded.
 */
export function ichancyAgentKey(baseUrl: string, username: string): string {
  const identity = `${normaliseIchancyBaseUrl(baseUrl)}|${username.trim()}`;
  return createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 32);
}

/** `https://agents.example.com` for any URL on that host, or null when it does not parse. */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
