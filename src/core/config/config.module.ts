/**
 * WHY global: every layer needs config and threading a ConfigModule import through 15 feature
 * modules buys nothing. Validation runs twice on purpose — once as @nestjs/config's `validate` hook
 * (so a bad .env fails before any provider is constructed) and once in the ENV_TOKEN factory, which
 * is the value the typed service actually wraps.
 */
import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppConfigService, ENV_TOKEN } from './config.service';
import { validateEnv, type Env } from './env.schema';

/**
 * The validated env, captured from @nestjs/config's `validate` hook.
 *
 * WHY this exists instead of simply re-running validateEnv(process.env):
 * @nestjs/config reads .env with `dotenv.parse()`, which deliberately does NOT mutate process.env.
 * It copies the values across afterwards — but only the ones that are still string | number |
 * boolean. Every var our schema TRANSFORMS into another type is therefore absent from process.env:
 * MINI_APP_ORIGIN (-> string[]), TELEGRAM_ADMIN_CHAT_ID, DUAL_APPROVAL_THRESHOLD_MINOR and
 * AGENT_FLOAT_LOW_WATERMARK_MINOR (-> bigint). Validating process.env a second time reported those
 * four as "expected string, received undefined" and refused to boot, even though .env defined all
 * of them correctly.
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
        return captured;
      },
    }),
  ],
  providers: [
    {
      provide: ENV_TOKEN,
      useFactory: (): Env => captured ?? validateEnv(process.env),
    },
    AppConfigService,
  ],
  exports: [AppConfigService],
})
export class AppConfigModule {}
