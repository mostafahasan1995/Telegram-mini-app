/**
 * WHY: nobody outside this file reads process.env. Consumers get grouped, already-typed,
 * already-converted values (bigint minor units, bigint chat ids, string[] origins) so no call site
 * re-parses a limit and gets the units wrong. Groups mirror the .env.example sections.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Inject, Injectable } from '@nestjs/common';
import { DEFAULT_ICHANCY_USER_AGENT, type Env } from './env.schema';

export const ENV_TOKEN = 'ICHANCY_VALIDATED_ENV';

export type AppRole = 'api' | 'worker';
export type NodeEnv = 'development' | 'test' | 'production';

/**
 * `host:port` of a validated proxy URL (`scheme://host:port`, no credentials, no path — see
 * env.schema.ts's optionalProxyUrl). For the launch banner, describeTransport and ichancy:check,
 * none of which may ever print the proxy password. It does NOT use `new URL()`, whose port parsing
 * is unreliable for non-special schemes like `socks5:`.
 */
export function proxyHostPort(server: string): string {
  return server.replace(/^[a-z0-9]+:\/\//i, '').replace(/\/.*$/, '');
}

export interface AppSettings {
  readonly role: AppRole;
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  readonly baseUrl: string;
  readonly miniAppOrigins: readonly string[];
  readonly isProduction: boolean;
  readonly isDevelopment: boolean;
  readonly isTest: boolean;
  /** Only the api role serves HTTP. */
  readonly isApi: boolean;
  /** Only the worker role may run schedules, queue processors, the outbox relay and Ichancy signin. */
  readonly isWorker: boolean;
}

export interface DbSettings {
  readonly url: string;
  readonly poolMax: number;
}

export interface RedisSettings {
  readonly url: string;
}

export interface JwtSettings {
  readonly secret: string;
  readonly accessTtl: string;
  readonly refreshTtlDays: number;
  readonly refreshTtlMs: number;
}

/**
 * Deployment-wide Telegram BEHAVIOUR. There is deliberately no bot identity here: no token, no
 * webhook path or secret, no chat id. Each operator's are columns on its tenant row, set from the
 * dashboard, and are read per tenant by TenantBotRegistry, BotService and the webhook controller.
 * A webhook URL is `<app.baseUrl>/telegram/webhook/<that tenant's path token>`.
 */
export interface TelegramSettings {
  /**
   * True => an operator's feed group (`tenants.feed_chat_id`) gets the FULL card (cashier float +
   * player identifiers) instead of the masked one. Defaults to false: masked is the only safe
   * default for a group we do not control the membership of.
   */
  readonly feedFullDetail: boolean;
  /**
   * Hours between automatic postings of the activity report. 0 = the schedule is OFF (the /report
   * command is unaffected).
   *
   * Each ACTIVE operator gets its own report through its own bot: in its feed group when that is
   * declared staff-only by `feedFullDetail`, in its admin group otherwise. See
   * modules/admin/services/report-schedule.cron.ts.
   */
  readonly reportScheduleHours: number;
}

export interface IchancySettings {
  /** The deployment's Ichancy host: PlatformDefaults' seed and the transports' cookie host. */
  readonly baseUrl: string;
  /**
   * ICHANCY_AGENT_ID, or null. It only seeds PlatformDefaults' agent id. There is deliberately no
   * username or password here: every Ichancy call is made with the credentials on the tenant row of
   * the operator that owns the work, so no deployment-wide agent account can be reached from code.
   */
  readonly agentId: string | null;
  readonly currency: string;
  readonly timeoutMs: number;
  /** True => every Ichancy call is served by the in-memory fake. No real money can move. */
  readonly fake: boolean;
  /**
   * Raw `Cookie:` header sent with every agent-API call. Null = send none.
   *
   * WHY THIS IS NEEDED AT ALL: agents.ichancy.com sits behind Cloudflare's bot protection, which
   * answers a plain server-to-server POST with a challenge page instead of JSON. The `cf_clearance`
   * cookie a human earned in a browser is what gets past it — see ICHANCY_USER_AGENT, which must
   * MATCH the browser that earned it, and the deployment note in .env.example about the IP.
   */
  readonly cookie: string | null;
  /** Where PLAYERS sign in with the credentials we registered — never the agent panel. */
  readonly playerSiteUrl: string;
  /** Refresh the Cloudflare clearance in a real browser every ~25 min. See ICHANCY_COOKIE_HARVEST. */
  readonly cookieHarvest: boolean;
  /** Persistent Chrome profile directory for that harvester. */
  readonly cookieProfileDir: string;
  /** How requests leave this process: Node fetch, or a real Chromium. See ICHANCY_TRANSPORT. */
  readonly transport: 'fetch' | 'browser';
  /** Run the browser transport headless. Ignored by the fetch transport. */
  readonly browserHeadless: boolean;
  /** Domain of the synthetic player mailboxes. See ICHANCY_PLAYER_EMAIL_DOMAIN in env.schema.ts. */
  readonly playerEmailDomain: string;
  /** Sent as `User-Agent` by the FETCH transport. cf_clearance is bound to it, so it is
   * configuration, not decoration. Browser mode ignores it — Chromium supplies its own. */
  readonly userAgent: string;
  /**
   * Did the operator leave ICHANCY_USER_AGENT alone? The schema defaults a blank value, so by the
   * time anything reads `userAgent` an explicit override is indistinguishable from the fallback —
   * and the preflight needs to tell them apart to warn that a UA set in browser mode is ignored.
   *
   * Blind spot, stated rather than hidden: an operator who sets it to exactly the default string
   * gets no warning. That is harmless, because the value they chose is the value in use.
   */
  readonly userAgentIsDefault: boolean;
  /**
   * Forward proxy for Ichancy egress, or null for DIRECT. `server` is `scheme://host:port` with NO
   * credentials; `username`/`password` are carried separately and MUST NEVER reach a log or
   * describeTransport() — host:port only. Built from ICHANCY_PROXY_URL / _USERNAME / _PASSWORD; null
   * whenever ICHANCY_PROXY_URL is blank, which is the unchanged direct-egress behaviour.
   */
  readonly proxy: {
    readonly server: string;
    readonly username: string | null;
    readonly password: string | null;
  } | null;
  /**
   * Optional in-browser FORM login (ICHANCY_LOGIN_URL + credentials). The browser transport fills
   * these into the panel's login form after solving the challenge, then persists the session. All
   * fields are null unless ICHANCY_LOGIN_URL is set. The credentials are used ONLY for that form and
   * must never reach a log or the egress status endpoint.
   */
  readonly loginUrl: string | null;
  readonly loginUsername: string | null;
  readonly loginPassword: string | null;
  readonly loginUserSelector: string | null;
  readonly loginPasswordSelector: string | null;
  readonly loginSubmitSelector: string | null;
}

export interface S3Settings {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly region: string;
  /** MinIO and most self-hosted gateways need path-style addressing. */
  readonly forcePathStyle: boolean;
}

export interface LimitsSettings {
  /** At or above this amount a deposit requires a second, different admin. */
  readonly dualApprovalThresholdMinor: bigint;
  readonly depositExpiryMinutes: number;
  /** Warn/refuse approvals when the Ichancy agent float falls below this. */
  readonly agentFloatLowWatermarkMinor: bigint;
}

@Injectable()
export class AppConfigService {
  private readonly _app: AppSettings;
  private readonly _db: DbSettings;
  private readonly _redis: RedisSettings;
  private readonly _jwt: JwtSettings;
  private readonly _telegram: TelegramSettings;
  private readonly _ichancy: IchancySettings;
  private readonly _s3: S3Settings;
  private readonly _limits: LimitsSettings;

  constructor(@Inject(ENV_TOKEN) env: Env) {
    this._app = Object.freeze({
      role: env.APP_ROLE,
      nodeEnv: env.NODE_ENV,
      port: env.PORT,
      baseUrl: env.API_BASE_URL,
      miniAppOrigins: Object.freeze([...env.MINI_APP_ORIGIN]),
      isProduction: env.NODE_ENV === 'production',
      isDevelopment: env.NODE_ENV === 'development',
      isTest: env.NODE_ENV === 'test',
      isApi: env.APP_ROLE === 'api',
      isWorker: env.APP_ROLE === 'worker',
    });

    this._db = Object.freeze({ url: env.DATABASE_URL, poolMax: env.DB_POOL_MAX });

    this._redis = Object.freeze({ url: env.REDIS_URL });

    this._jwt = Object.freeze({
      secret: env.JWT_SECRET,
      accessTtl: env.JWT_ACCESS_TTL,
      refreshTtlDays: env.REFRESH_TTL_DAYS,
      refreshTtlMs: env.REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
    });

    this._telegram = Object.freeze({
      // Unset => masked. The unsafe variant must always be an explicit choice.
      feedFullDetail: env.TELEGRAM_FEED_FULL_DETAIL ?? false,
      // Already defaulted (6) and range-checked by the schema; 0 means the operator turned it off.
      reportScheduleHours: env.REPORT_SCHEDULE_HOURS,
    });

    this._ichancy = Object.freeze({
      baseUrl: env.ICHANCY_BASE_URL,
      agentId: env.ICHANCY_AGENT_ID ?? null,
      currency: env.ICHANCY_CURRENCY,
      timeoutMs: env.ICHANCY_TIMEOUT_MS,
      // Unset => fake only under test, so CI can never reach the real agent API by omission.
      fake: env.ICHANCY_FAKE ?? env.NODE_ENV === 'test',
      // Trimmed and emptied-to-null so a blank line in .env is the same as "no cookie" rather than
      // an empty header Cloudflare would treat as a malformed request.
      cookie: env.ICHANCY_COOKIE?.trim() ? env.ICHANCY_COOKIE.trim() : null,
      userAgent: env.ICHANCY_USER_AGENT,
      userAgentIsDefault: env.ICHANCY_USER_AGENT === DEFAULT_ICHANCY_USER_AGENT,
      // Already defaulted and shape-checked by the schema — a blank line there means "the default",
      // so this is never empty and never needs a fallback of its own.
      playerEmailDomain: env.ICHANCY_PLAYER_EMAIL_DOMAIN,
      playerSiteUrl: env.ICHANCY_PLAYER_SITE_URL,
      cookieHarvest: env.ICHANCY_COOKIE_HARVEST ?? false,
      cookieProfileDir:
        env.ICHANCY_COOKIE_PROFILE_DIR !== undefined &&
        env.ICHANCY_COOKIE_PROFILE_DIR.trim().length > 0
          ? env.ICHANCY_COOKIE_PROFILE_DIR.trim()
          : join(tmpdir(), 'ichancy-agent-profile'),
      transport: env.ICHANCY_TRANSPORT,
      browserHeadless: env.ICHANCY_BROWSER_HEADLESS,
      // Blank URL => null => direct egress, byte-for-byte the old behaviour. The URL carries no
      // credentials (env.schema refuses them there); username/password are optional even when a URL
      // is set (an open proxy, or IP-authenticated).
      proxy:
        env.ICHANCY_PROXY_URL === undefined
          ? null
          : Object.freeze({
              server: env.ICHANCY_PROXY_URL,
              username: env.ICHANCY_PROXY_USERNAME ?? null,
              password: env.ICHANCY_PROXY_PASSWORD ?? null,
            }),
      // The OPTIONAL in-browser form login. All null exactly when ICHANCY_LOGIN_URL is blank —
      // which is the shipped default, so this feature changes nothing for an env file that never
      // set it. Credentials are used ONLY for the form submission and must never reach a log.
      loginUrl: env.ICHANCY_LOGIN_URL ?? null,
      loginUsername: env.ICHANCY_LOGIN_USERNAME ?? null,
      loginPassword: env.ICHANCY_LOGIN_PASSWORD ?? null,
      loginUserSelector: env.ICHANCY_LOGIN_USER_SELECTOR ?? null,
      loginPasswordSelector: env.ICHANCY_LOGIN_PASSWORD_SELECTOR ?? null,
      loginSubmitSelector: env.ICHANCY_LOGIN_SUBMIT_SELECTOR ?? null,
    });

    this._s3 = Object.freeze({
      endpoint: env.S3_ENDPOINT,
      bucket: env.S3_BUCKET,
      accessKey: env.S3_ACCESS_KEY,
      secretKey: env.S3_SECRET_KEY,
      region: env.S3_REGION,
      forcePathStyle: true,
    });

    this._limits = Object.freeze({
      dualApprovalThresholdMinor: env.DUAL_APPROVAL_THRESHOLD_MINOR,
      depositExpiryMinutes: env.DEPOSIT_EXPIRY_MINUTES,
      agentFloatLowWatermarkMinor: env.AGENT_FLOAT_LOW_WATERMARK_MINOR,
    });
  }

  get app(): AppSettings {
    return this._app;
  }

  get db(): DbSettings {
    return this._db;
  }

  get redis(): RedisSettings {
    return this._redis;
  }

  get jwt(): JwtSettings {
    return this._jwt;
  }

  get telegram(): TelegramSettings {
    return this._telegram;
  }

  get ichancy(): IchancySettings {
    return this._ichancy;
  }

  get s3(): S3Settings {
    return this._s3;
  }

  get limits(): LimitsSettings {
    return this._limits;
  }
}
