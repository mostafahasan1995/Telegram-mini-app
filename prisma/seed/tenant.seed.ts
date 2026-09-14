/**
 * The two rows every other seed now hangs off, plus the single PlatformDefaults row. A DEVELOPMENT
 * fixture (see prisma/seed.ts): production gets these rows from the multi-tenant migration.
 *
 * TENANT ZERO is the platform itself. It is not an operator and never takes a deposit; it exists so
 * that platform staff have somewhere to live that is not a customer's tenant. Its Telegram and
 * Ichancy columns are NOT NULL in the schema and there is nothing truthful to put in them, so they
 * get openly-labelled placeholders rather than a copy of an operator's real credentials — a
 * platform row holding a working bot token is a second, unaudited way to speak as that operator.
 *
 * THE BOOTSTRAP OPERATOR is the tenant that was taking deposits before multi-tenancy, and the one
 * every fixture below (rails, ledger accounts) belongs to.
 *
 * NOTHING HERE READS A TELEGRAM VARIABLE. Each operator's bot token, webhook and chat ids are pasted
 * into the dashboard by a platform admin; a seed that copied one deployment-wide TELEGRAM_BOT_TOKEN
 * into a tenant row would recreate exactly the global bot the platform no longer has. Those columns
 * get placeholders (NOT NULL ones) or NULL. The Ichancy agent credentials are still repaired from
 * .env below, because per-operator Ichancy settings do not exist yet.
 *
 * WHY BOTH ARE CREATED `ACTIVE` and not the schema's SUSPENDED default: this path only runs on a
 * database with no migration rows (the integration harness builds its schema with `db push`), and
 * every fixture and test assumes it can sign into and serve through these two. Landing either
 * SUSPENDED would lock a developer's install out of itself on first boot.
 *
 * WHY EVERY UPSERT HERE HAS AN EMPTY `update` (bar the narrow sentinel repair): the columns are
 * secrets, webhook routing and serving status. An operator who rotated a credential or suspended a
 * tenant did it deliberately and through an audited path; running the seed again must not silently
 * revert any of it. Same rule, and the same reason, as the payment destinations.
 */
import { TenantStatus, type Prisma, type PrismaClient } from '@prisma/client';

// Imported from the constants FILE, not from the '@core/tenant' barrel: the barrel also exports the
// Nest module, middleware and interceptor, which would drag the whole DI graph into a script that
// only wants two uuids. (The barrel does export these constants; this is about not importing Nest.)
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
 * different things and must not share a key. WHATEVER READS THESE COLUMNS MUST DERIVE WITH THIS
 * EXACT STRING — a mismatch does not fail loudly at boot, it fails the first time a secret is opened.
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

/**
 * What `20260911090000_multi_tenant_core` writes into the bootstrap operator's NOT NULL credential
 * columns. A migration cannot read the deployment's environment, so it writes these and the seed —
 * which can — repairs the Ichancy ones.
 *
 * The repair is deliberately narrow: a column is overwritten ONLY while it still holds the
 * sentinel. Anything a human has since set is left exactly as they left it.
 */
const MIGRATION_SENTINEL_PREFIX = 'REPLACE-ME';

const isMigrationSentinel = (value: string | null): boolean =>
  value !== null && value.startsWith(MIGRATION_SENTINEL_PREFIX);

/** Matches the .env.example defaults; see the BUSINESS LIMITS block there for what each one gates. */
const DEFAULT_DUAL_APPROVAL_THRESHOLD_MINOR = 100_000_000n;
const DEFAULT_AGENT_FLOAT_LOW_WATERMARK_MINOR = 50_000_000n;
const DEFAULT_DEPOSIT_EXPIRY_MINUTES = 120;

/**
 * Chat id 0 is what the migration writes for "not configured": Telegram never issues it. The real
 * chat ids arrive with the operator's bot, from the dashboard.
 */
const UNCONFIGURED_CHAT_ID = 0n;

export interface SeededTenant {
  id: string;
  slug: string;
  created: boolean;
}

export interface SeededTenancy {
  platform: SeededTenant;
  bootstrap: SeededTenant;
  defaultsCreated: boolean;
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
 * `config.app.baseUrl` and omits the button entirely below https, so that is what this column holds
 * for a fixture operator. Null means "no button", which is already the behaviour on a developer's
 * http://localhost.
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

  // ---- Tenant zero -----------------------------------------------------------------------------
  // Every credential here is a placeholder by design; see the header.
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
      adminChatId: UNCONFIGURED_CHAT_ID,
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
  const ichancyPassword = sealOrPlaceholder(seal, env.ICHANCY_PASSWORD, 'ICHANCY-PASSWORD');

  const existingBootstrap = await prisma.tenant.findUnique({
    where: { id: TENANT_BOOTSTRAP_ID },
    select: {
      id: true,
      status: true,
      ichancyUsername: true,
      ichancyPasswordEnc: true,
      ichancyAgentId: true,
    },
  });

  // See MIGRATION_SENTINEL_PREFIX. Each field is repaired independently, because a half-configured
  // environment is the normal case, and a second seed run must not undo the first.
  const repair: Prisma.TenantUpdateInput = {};
  if (existingBootstrap !== null) {
    // Each field resolves to what the row WILL hold after this run: the repaired value when we are
    // replacing a sentinel, otherwise whatever is already there.
    const nextIchancyPassword =
      isMigrationSentinel(existingBootstrap.ichancyPasswordEnc) && !ichancyPassword.isPlaceholder
        ? ichancyPassword.value
        : existingBootstrap.ichancyPasswordEnc;

    const nextIchancyUsername = isMigrationSentinel(existingBootstrap.ichancyUsername)
      ? (readOptionalText(env.ICHANCY_USERNAME) ?? existingBootstrap.ichancyUsername)
      : existingBootstrap.ichancyUsername;

    const nextIchancyAgentId = isMigrationSentinel(existingBootstrap.ichancyAgentId)
      ? (readOptionalText(env.ICHANCY_AGENT_ID) ?? existingBootstrap.ichancyAgentId)
      : existingBootstrap.ichancyAgentId;

    if (nextIchancyPassword !== existingBootstrap.ichancyPasswordEnc) {
      repair.ichancyPasswordEnc = nextIchancyPassword;
    }
    if (nextIchancyUsername !== existingBootstrap.ichancyUsername) {
      repair.ichancyUsername = nextIchancyUsername;
    }
    if (nextIchancyAgentId !== existingBootstrap.ichancyAgentId) {
      repair.ichancyAgentId = nextIchancyAgentId;
    }

    /**
     * The migration writes the row SUSPENDED because its credentials were sentinels. Once this run
     * has replaced the Ichancy ones, a developer's fixture operator is switched on — the bot token
     * is not part of the test any more, because it arrives from the dashboard and the runtime does
     * not read it from this row yet.
     *
     * Narrow on purpose, so a human's suspension is never reverted:
     *   - only FROM SUSPENDED, the value the migration wrote;
     *   - only when this run actually repaired something;
     *   - only when the Ichancy credentials are no longer unconfigured.
     * On a row whose credentials a human already set, no repair happens, so this cannot fire.
     */
    const ichancyConfigured =
      !isMigrationSentinel(nextIchancyPassword) &&
      !nextIchancyPassword.startsWith(PLACEHOLDER_PREFIX) &&
      !isMigrationSentinel(nextIchancyUsername);

    if (
      Object.keys(repair).length > 0 &&
      ichancyConfigured &&
      existingBootstrap.status === TenantStatus.SUSPENDED
    ) {
      repair.status = TenantStatus.ACTIVE;
    }
  }

  await prisma.tenant.upsert({
    where: { id: TENANT_BOOTSTRAP_ID },
    create: {
      id: TENANT_BOOTSTRAP_ID,
      slug: TENANT_BOOTSTRAP_SLUG,
      // Cosmetic, and the one field here an operator is likely to want their own name in.
      displayName: readOptionalText(env.SEED_TENANT_DISPLAY_NAME) ?? 'Default operator',
      status: TenantStatus.ACTIVE,
      // Telegram columns: nothing from the environment — see the header. The NOT NULL ones say out
      // loud that they are unset; the nullable ones are simply absent.
      botTokenEnc: `${PLACEHOLDER_PREFIX}-TELEGRAM-BOT-TOKEN`,
      botUsername: null,
      webhookPathToken: null,
      webhookSecretEnc: null,
      adminChatId: UNCONFIGURED_CHAT_ID,
      feedChatId: null,
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
    // Empty except for a sentinel repair — see MIGRATION_SENTINEL_PREFIX. Never a blanket overwrite.
    update: repair,
    select: { id: true },
  });

  // ---- PlatformDefaults ------------------------------------------------------------------------
  // Only for a database the migration never ran on (the migration inserts id=1 itself, so on any
  // migrated database this create is a no-op). Filling the migration's literals from .env is the
  // PlatformDefaults service's job on first read, not this script's.
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
  };
}
