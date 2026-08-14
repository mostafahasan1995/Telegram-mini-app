/**
 * WHY: nobody outside this file reads process.env. Consumers get grouped, already-typed,
 * already-converted values (bigint minor units, bigint chat ids, string[] origins) so no call site
 * re-parses a limit and gets the units wrong. Groups mirror the .env.example sections.
 */
import { Inject, Injectable } from '@nestjs/common';
import { type Env } from './env.schema';

export const ENV_TOKEN = 'ICHANCY_VALIDATED_ENV';

export type AppRole = 'api' | 'worker';
export type NodeEnv = 'development' | 'test' | 'production';

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

export interface TelegramSettings {
  readonly botToken: string;
  /** Compared against the X-Telegram-Bot-Api-Secret-Token header on every update. */
  readonly webhookSecret: string;
  /** Unguessable path segment for the webhook endpoint. */
  readonly webhookPathToken: string;
  /** Full webhook path, e.g. /telegram/webhook/<token>. */
  readonly webhookPath: string;
  /** Absolute URL to hand to setWebhook. */
  readonly webhookUrl: string;
  readonly adminChatId: bigint;
}

export interface IchancySettings {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  /** Our agent's affiliateId — parentId on registerPlayer, filter value on getChildren. */
  readonly agentId: string;
  readonly currency: string;
  readonly timeoutMs: number;
  /** True => every Ichancy call is served by the in-memory fake. No real money can move. */
  readonly fake: boolean;
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

    const webhookPath = `/telegram/webhook/${env.TELEGRAM_WEBHOOK_PATH_TOKEN}`;
    this._telegram = Object.freeze({
      botToken: env.TELEGRAM_BOT_TOKEN,
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
      webhookPathToken: env.TELEGRAM_WEBHOOK_PATH_TOKEN,
      webhookPath,
      webhookUrl: `${env.API_BASE_URL}${webhookPath}`,
      adminChatId: env.TELEGRAM_ADMIN_CHAT_ID,
    });

    this._ichancy = Object.freeze({
      baseUrl: env.ICHANCY_BASE_URL,
      username: env.ICHANCY_USERNAME,
      password: env.ICHANCY_PASSWORD,
      agentId: env.ICHANCY_AGENT_ID,
      currency: env.ICHANCY_CURRENCY,
      timeoutMs: env.ICHANCY_TIMEOUT_MS,
      // Unset => fake only under test, so CI can never reach the real agent API by omission.
      fake: env.ICHANCY_FAKE ?? env.NODE_ENV === 'test',
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
