/**
 * The two rows every other seed now hangs off, plus the single PlatformDefaults row.
 *
 * TENANT ZERO is the platform itself. It is not an operator and never takes a deposit; it exists so
 * that platform staff have somewhere to live that is not a customer's tenant. Its Telegram and
 * Ichancy columns are NOT NULL in the schema and there is nothing truthful to put in them, so they
 * get openly-labelled placeholders rather than a copy of the operator's real credentials — a
 * platform row holding a working bot token is a second, unaudited way to speak as that operator.
 *
 * THE BOOTSTRAP OPERATOR is the tenant that was actually taking deposits before multi-tenancy. Its
 * columns are filled from the deployment's own environment, because until phase 6 gives each
 * operator its own bot there is exactly one bot, one agent panel and one set of money settings —
 * the ones in .env. Seeding it from anywhere else would produce a tenant row that disagrees with
 * the process reading those same variables.
 *
 * WHY BOTH LAND `ACTIVE` and not the schema's SUSPENDED default: that default protects an operator
 * created through the admin panel, where nothing has verified the agent id yet. These two are the
 * opposite case — tenant zero holds the logins that would do the verifying, and the bootstrap
 * operator's credentials are the ones this deployment has been running on. Landing either
 * SUSPENDED would lock the install out of itself on first boot.
 *
 * WHY EVERY UPSERT HERE HAS AN EMPTY `update`: the columns are secrets, webhook routing and
 * serving status. An operator who rotated a bot token, re-pointed a webhook or suspended a tenant
 * did it deliberately and through an audited path; a redeploy running the seed again must not
 * silently revert any of it. Same rule, and the same reason, as the payment destinations.
 */
import { TenantStatus, type PrismaClient } from '@prisma/client';

// Imported from the constants FILE, not from the '@core/tenant' barrel: the barrel also exports the
// Nest module, middleware and interceptor, which would drag the whole DI graph into a script that
// only wants two uuids — and it deliberately does not re-export the bootstrap constants at all.
import {
  TENANT_BOOTSTRAP_ID,
  TENANT_BOOTSTRAP_SLUG,
  TENANT_ZERO_ID,
  TENANT_ZERO_SLUG,
} from '@core/tenant/tenant.constants';
import { deriveKey, sealSecret } from '@modules/player/utils/secret-box.util';

/**
 * HKDF label for the tenant-scoped secret columns (bot token, webhook secret, Ichancy password,
 * Sham Cash key). It is separate from the player-credential label on purpose: the two protect
 * different things and must not share a key. WHATEVER READS THESE COLUMNS IN PHASE 6 MUST DERIVE
 * WITH THIS EXACT STRING — a mismatch does not fail loudly at boot, it fails the first time a bot
 * token is opened.
 */
const TENANT_SECRET_INFO = 'ichancy-tenant-secret-enc:v1';

/**
 * The root the rest of the codebase already derives from (PlayerLinkService uses `config.jwt.secret`
 * for exactly this). There is no dedicated credential secret in the env schema, and the seed is not
 * the place to introduce one.
 */
const ROOT_SECRET_VAR = 'JWT_SECRET';

/** Same prefix the payment-method seed uses, so one grep finds everything a fresh install must fix. */
const PLACEHOLDER_PREFIX = 'SEED-PLACEHOLDER';

/** Matches the .env.example defaults; see the BUSINESS LIMITS block there for what each one gates. */
const DEFAULT_DUAL_APPROVAL_THRESHOLD_MINOR = 100_000_000n;
const DEFAULT_AGENT_FLOAT_LOW_WATERMARK_MINOR = 50_000_000n;
const DEFAULT_DEPOSIT_EXPIRY_MINUTES = 120;

export interface SeededTenant {
  id: string;
  slug: string;
  created: boolean;
}

export interface SeededTenancy {
  platform: SeededTenant;
  bootstrap: SeededTenant;
  defaultsCreated: boolean;
  /**
   * True when at least one sealed column on the bootstrap operator holds a placeholder instead of a
   * real secret — the bot cannot answer and Ichancy cannot be signed into until they are replaced.
   */
  secretsArePlaceholders: boolean;
}

interface SealedValue {
  value: string;
  isPlaceholder: boolean;
}

function readBigintMinor(raw: string | undefined, fallback: bigint, label: string): bigint {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be a non-negative integer in MINOR units, got "${raw ?? ''}"`);
  }
  return BigInt(value);
}

/** Chat ids are signed: a supergroup's is negative (-1001234567890). */
function readChatId(raw: string | undefined, label: string): bigint | null {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return null;
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${label} must be an integer Telegram chat id, got "${raw ?? ''}"`);
  }
  return BigInt(value);
}

function readMinutes(raw: string | undefined, fallback: number, label: string): number {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be a positive whole number of minutes, got "${raw ?? ''}"`);
  }
  return Number(value);
}

function readText(raw: string | undefined, placeholder: string): string {
  const value = raw?.trim();
  return value === undefined || value.length === 0 ? `${PLACEHOLDER_PREFIX}-${placeholder}` : value;
}

function readOptionalText(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

/**
 * Sealing needs the root secret. When it is absent — a CI database, a fresh clone with no .env —
 * the column gets a visible placeholder rather than ciphertext under a throwaway key: a value
 * nobody can ever open is strictly worse than one that says out loud that it is not a secret.
 */
function buildSealer(env: NodeJS.ProcessEnv): ((plaintext: string) => string) | null {
  const rootSecret = env[ROOT_SECRET_VAR]?.trim();
  if (rootSecret === undefined || rootSecret.length === 0) return null;

  const key = deriveKey(rootSecret, TENANT_SECRET_INFO);
  return (plaintext: string): string => sealSecret(key, plaintext);
}

function sealOrPlaceholder(
  seal: ((plaintext: string) => string) | null,
  raw: string | undefined,
  placeholder: string,
): SealedValue {
  const plaintext = raw?.trim();
  if (seal === null || plaintext === undefined || plaintext.length === 0) {
    return { value: `${PLACEHOLDER_PREFIX}-${placeholder}`, isPlaceholder: true };
  }
  return { value: seal(plaintext), isPlaceholder: false };
}

/**
 * The bot's "open the app" button. Today `PlayerHandlers.miniAppKeyboard()` opens
 * `config.app.baseUrl` and omits the button entirely below https, so that is what this column has to
 * hold for phase 6 to change nothing an existing player can see. Null means "no button", which is
 * already the behaviour on a developer's http://localhost.
 */
function readMiniAppUrl(env: NodeJS.ProcessEnv): string | null {
  const url = env.API_BASE_URL?.trim();
  if (url === undefined || !url.startsWith('https://')) return null;
  return url;
}

export async function seedTenancy(
  prisma: PrismaClient,
  currencyCode: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SeededTenancy> {
  const seal = buildSealer(env);

  const dualApprovalThresholdMinor = readBigintMinor(
    env.DUAL_APPROVAL_THRESHOLD_MINOR,
    DEFAULT_DUAL_APPROVAL_THRESHOLD_MINOR,
    'DUAL_APPROVAL_THRESHOLD_MINOR',
  );
  const agentFloatLowWatermarkMinor = readBigintMinor(
    env.AGENT_FLOAT_LOW_WATERMARK_MINOR,
    DEFAULT_AGENT_FLOAT_LOW_WATERMARK_MINOR,
    'AGENT_FLOAT_LOW_WATERMARK_MINOR',
  );
  const depositExpiryMinutes = readMinutes(
    env.DEPOSIT_EXPIRY_MINUTES,
    DEFAULT_DEPOSIT_EXPIRY_MINUTES,
    'DEPOSIT_EXPIRY_MINUTES',
  );

  const ichancyBaseUrl = readText(env.ICHANCY_BASE_URL, 'ICHANCY-BASE-URL');
  const adminChatId = readChatId(env.TELEGRAM_ADMIN_CHAT_ID, 'TELEGRAM_ADMIN_CHAT_ID');

  // ---- Tenant zero -----------------------------------------------------------------------------
  // Every credential here is a placeholder by design; see the header. `adminChatId` is the one
  // exception worth filling when we know it, because platform-level alerts have to reach a human,
  // and 0 is a chat id Telegram will never issue, so it reads unambiguously as "not configured".
  const existingPlatform = await prisma.tenant.findUnique({
    where: { id: TENANT_ZERO_ID },
    select: { id: true },
  });

  await prisma.tenant.upsert({
    where: { id: TENANT_ZERO_ID },
    create: {
      id: TENANT_ZERO_ID,
      slug: TENANT_ZERO_SLUG,
      displayName: 'Platform',
      status: TenantStatus.ACTIVE,
      botTokenEnc: `${PLACEHOLDER_PREFIX}-PLATFORM-HAS-NO-BOT`,
      adminChatId: adminChatId ?? 0n,
      ichancyBaseUrl,
      ichancyUsername: `${PLACEHOLDER_PREFIX}-PLATFORM-HAS-NO-AGENT`,
      ichancyPasswordEnc: `${PLACEHOLDER_PREFIX}-PLATFORM-HAS-NO-AGENT`,
      ichancyAgentId: `${PLACEHOLDER_PREFIX}-PLATFORM-HAS-NO-AGENT`,
      currencyCode,
      dualApprovalThresholdMinor,
      agentFloatLowWatermarkMinor,
      depositExpiryMinutes,
    },
    update: {},
    select: { id: true },
  });

  // ---- The bootstrap operator ------------------------------------------------------------------
  const botToken = sealOrPlaceholder(seal, env.TELEGRAM_BOT_TOKEN, 'TELEGRAM-BOT-TOKEN');
  const ichancyPassword = sealOrPlaceholder(seal, env.ICHANCY_PASSWORD, 'ICHANCY-PASSWORD');
  const webhookSecret = sealOrPlaceholder(seal, env.TELEGRAM_WEBHOOK_SECRET, 'WEBHOOK-SECRET');

  const existingBootstrap = await prisma.tenant.findUnique({
    where: { id: TENANT_BOOTSTRAP_ID },
    select: { id: true },
  });

  await prisma.tenant.upsert({
    where: { id: TENANT_BOOTSTRAP_ID },
    create: {
      id: TENANT_BOOTSTRAP_ID,
      slug: TENANT_BOOTSTRAP_SLUG,
      // Cosmetic, and the one field here an operator is likely to want their own name in.
      displayName: readOptionalText(env.SEED_TENANT_DISPLAY_NAME) ?? 'Default operator',
      status: TenantStatus.ACTIVE,
      botTokenEnc: botToken.value,
      // Left null rather than guessed: it is filled from getMe the first time the bot answers, and
      // a wrong @username in a support ticket is worse than an absent one.
      botUsername: null,
      webhookPathToken: readOptionalText(env.TELEGRAM_WEBHOOK_PATH_TOKEN),
      webhookSecretEnc: webhookSecret.isPlaceholder ? null : webhookSecret.value,
      adminChatId: adminChatId ?? 0n,
      feedChatId: readChatId(env.TELEGRAM_FEED_CHAT_ID, 'TELEGRAM_FEED_CHAT_ID'),
      ichancyBaseUrl,
      ichancyUsername: readText(env.ICHANCY_USERNAME, 'ICHANCY-USERNAME'),
      ichancyPasswordEnc: ichancyPassword.value,
      ichancyAgentId: readText(env.ICHANCY_AGENT_ID, 'ICHANCY-AGENT-ID'),
      currencyCode,
      dualApprovalThresholdMinor,
      agentFloatLowWatermarkMinor,
      depositExpiryMinutes,
      miniAppUrl: readMiniAppUrl(env),
      // depositMode / withdrawalMode keep the schema's MANUAL default. A seed must never be the
      // reason money starts moving without a human.
    },
    update: {},
    select: { id: true },
  });

  // ---- PlatformDefaults ------------------------------------------------------------------------
  // What the NEXT operator inherits. Seeded from the same environment as the bootstrap operator
  // because those numbers are the only ones this deployment has ever been reviewed against; a
  // platform admin changes them from the console afterwards, and that change is what `update: {}`
  // protects. `ichancyAgentId` stays nullable here — the house agent is a deliberate naming, and an
  // absent one has to stay absent rather than inherit the bootstrap operator's.
  const existingDefaults = await prisma.platformDefaults.findUnique({
    where: { id: 1 },
    select: { id: true },
  });

  await prisma.platformDefaults.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      ichancyBaseUrl,
      ichancyAgentId: readOptionalText(env.ICHANCY_AGENT_ID),
      currencyCode,
      dualApprovalThresholdMinor,
      agentFloatLowWatermarkMinor,
      depositExpiryMinutes,
    },
    update: {},
  });

  return {
    platform: {
      id: TENANT_ZERO_ID,
      slug: TENANT_ZERO_SLUG,
      created: existingPlatform === null,
    },
    bootstrap: {
      id: TENANT_BOOTSTRAP_ID,
      slug: TENANT_BOOTSTRAP_SLUG,
      created: existingBootstrap === null,
    },
    defaultsCreated: existingDefaults === null,
    secretsArePlaceholders:
      botToken.isPlaceholder || ichancyPassword.isPlaceholder || webhookSecret.isPlaceholder,
  };
}
