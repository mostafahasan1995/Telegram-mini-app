/**
 * WHY global: every layer needs config and threading a ConfigModule import through 15 feature
 * modules buys nothing. Validation runs twice on purpose — once as @nestjs/config's `validate` hook
 * (so a bad .env fails before any provider is constructed) and once in the ENV_TOKEN factory, which
 * is the value the typed service actually wraps.
 */
import { Global, Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppConfigService, ENV_TOKEN } from './config.service';
import { legacyTelegramEnvKeys, validateEnv, type Env } from './env.schema';

/**
 * Says, once per process, which retired Telegram variables the environment still carries.
 *
 * WHY A WARNING AND NOT SILENCE: those lines are ignored (see LEGACY_TELEGRAM_ENV_KEYS), but a bot
 * token in an env file looks like it is doing something, and the next person to debug a silent bot
 * would edit it. Key NAMES only: the values are credentials, and this line is shipped to the logs.
 */
let legacyKeysReported = false;
function reportLegacyTelegramKeys(raw: Record<string, unknown>): void {
  if (legacyKeysReported) return;
  const present = legacyTelegramEnvKeys(raw);
  if (present.length === 0) return;
  legacyKeysReported = true;
  new Logger('AppConfig').warn(
    `Ignoring retired environment variables: ${present.join(', ')}. Every operator's bot token, ` +
      'webhook and chats are set per tenant from the dashboard; delete these lines.',
  );
}

/**
 * The validated env, captured from @nestjs/config's `validate` hook.
 *
 * WHY this exists instead of simply re-running validateEnv(process.env):
 * @nestjs/config reads .env with `dotenv.parse()`, which deliberately does NOT mutate process.env.
 * It copies the values across afterwards — but only the ones that are still string | number |
 * boolean. Every var our schema TRANSFORMS into another type is therefore absent from process.env:
 * MINI_APP_ORIGIN (-> string[]),
 * DUAL_APPROVAL_THRESHOLD_MINOR and AGENT_FLOAT_LOW_WATERMARK_MINOR (-> bigint), ICHANCY_FAKE and
 * TELEGRAM_FEED_FULL_DETAIL (-> boolean). Validating process.env a second time reported the
 * required ones as "expected string, received undefined" and refused to boot, even though .env
 * defined all of them correctly — and silently read the optional ones as unset, which is worse,
 * because a feature configured in .env would simply not happen and nothing would say why.
 *
 * The fallback still covers containers, where the vars are real environment variables and
 * `ignoreEnvFile` is true, so the hook never runs with file contents.
 */
let captured: Env | undefined;

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // .env is for local development only; in containers the vars come from the environment.
      envFilePath: ['.env'],
      ignoreEnvFile: process.env.NODE_ENV === 'production',
      validate: (raw: Record<string, unknown>): Env => {
        // Capture the parsed result. See `captured` below for why re-reading process.env is wrong.
        captured = validateEnv(raw);
        reportLegacyTelegramKeys(raw);
        return captured;
      },
    }),
  ],
  providers: [
    {
      provide: ENV_TOKEN,
      useFactory: (): Env => {
        if (captured !== undefined) return captured;
        reportLegacyTelegramKeys(process.env);
        return validateEnv(process.env);
      },
    },
    AppConfigService,
  ],
  exports: [AppConfigService],
})
export class AppConfigModule {}
