/**
 * WHY ONE CLASS SEALS AND OPENS EVERY TENANT SECRET: `bot_token_enc`, `webhook_secret_enc` and
 * `ichancy_password_enc` are written by one path (the seed today, the tenant admin endpoints next)
 * and read by several (the webhook ingress, the per-tenant bot, the Ichancy adapter). A label or salt
 * that drifts between a writer and a reader does not fail at boot. It fails the first time an
 * operator's money path opens a secret. Keeping the label, the key derivation and the refusal rules
 * in one class is what stops them drifting.
 *
 * WHY IT CARRIES NO NEST DECORATORS: the seed runs outside Nest and must seal with exactly this
 * code. TenantModule builds it through a factory from the validated JWT secret; the seed builds it
 * from its own environment. Same class, same key, and the seed does not drag in the DI graph.
 *
 * WHY JWT_SECRET IS THE ROOT: TENANT-OPERATIONS.md §1 specifies it ("keyed off JWT_SECRET"), and every
 * row the seed has already sealed was derived from it. HKDF with a dedicated label keeps this key
 * independent of the JWT signing key and of the player-credential key.
 *
 * THE FORMAT is the secret box's `v1.<iv>.<tag>.<ciphertext>`: AES-256-GCM with a random 96-bit nonce
 * per seal and a full 16-byte tag. The util refuses a short tag, so a truncated-tag forgery is
 * impossible. OpenSSL compares the tag in constant time.
 *
 * WHAT IT REFUSES, LOUDLY: the migration and the seed fill the NOT NULL secret columns with visible
 * sentinels (REPLACE-ME-…, SEED-PLACEHOLDER-…, UNUSED-…). Handing one to Telegram or Ichancy turns
 * "never configured" into a 401 that reads like an outage, so opening one throws a typed UNCONFIGURED
 * error instead.
 *
 * NOTHING HERE LOGS, and no error carries a stored, submitted or opened value. The message names the
 * field and the tenant id, which is enough to fix it from the dashboard.
 */
import { createHmac } from 'node:crypto';

import type { Tenant } from '@prisma/client';

import { SecretBoxError, deriveKey, openSecret, sealSecret } from '../../crypto/secret-box.util';

/**
 * HKDF label for the tenant secret columns. It is separate from the player-credential label on
 * purpose, because the two protect different things and must not share a key. NEVER CHANGE IT IN
 * PLACE: every sealed row in every deployment was derived with this exact string. A rotation is a new
 * label plus a re-seal, not an edit.
 */
export const TENANT_SECRET_INFO = 'ichancy-tenant-secret-enc:v1';

/**
 * Prefixes of what the migration (`REPLACE-ME…`, `UNUSED-PLATFORM-TENANT`) and the seeds
 * (`SEED-PLACEHOLDER-…`) write where a secret has never been set. Matched case-insensitively after
 * trimming. A sealed value starts with `v1.` and can never match.
 */
export const TENANT_SECRET_SENTINEL_PREFIXES = [
  'SEED-PLACEHOLDER',
  'REPLACE-ME',
  'UNUSED',
] as const;

/** Stable strings, never messages. Same rule as the rest of the codebase. */
export const TenantSecretErrorCodes = {
  /** No root secret to derive from. A configuration fault, never a per-tenant one. */
  TENANT_SECRET_ROOT_MISSING: 'TENANT_SECRET_ROOT_MISSING',
  /** The column is NULL, empty or a sentinel: nobody has set this secret for this operator yet. */
  TENANT_SECRET_UNCONFIGURED: 'TENANT_SECRET_UNCONFIGURED',
  /**
   * The column holds something that does not open: tampered, sealed under another JWT_SECRET, or
   * not sealed at all. Different from UNCONFIGURED because the fix is different (re-enter the secret
   * vs. find out who changed the row or the key).
   */
  TENANT_SECRET_UNREADABLE: 'TENANT_SECRET_UNREADABLE',
  /** Refused to seal an empty value or a sentinel, which would store "unset" dressed as a secret. */
  TENANT_SECRET_REFUSED: 'TENANT_SECRET_REFUSED',
} as const;

export type TenantSecretErrorCode =
  (typeof TenantSecretErrorCodes)[keyof typeof TenantSecretErrorCodes];

export type TenantSecretField = 'botToken' | 'webhookSecret' | 'ichancyPassword';

const FIELD_LABELS: Readonly<Record<TenantSecretField, string>> = {
  botToken: 'bot token',
  webhookSecret: 'webhook secret',
  ichancyPassword: 'Ichancy password',
};

export class TenantSecretError extends Error {
  constructor(
    readonly code: TenantSecretErrorCode,
    readonly field: TenantSecretField | null,
    readonly tenantId: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'TenantSecretError';
    Error.captureStackTrace?.(this, TenantSecretError);
  }
}

export const isTenantSecretError = (value: unknown): value is TenantSecretError =>
  value instanceof TenantSecretError;

/** True for a migration or seed sentinel. Exported so writers can refuse the same values readers do. */
export function isTenantSecretSentinel(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  return TENANT_SECRET_SENTINEL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * HKDF label of the staff Telegram link-code digest key. Changing it only voids the codes live at that
 * moment (each lives minutes), but it must still never be edited by accident.
 */
export const STAFF_LINK_CODE_DIGEST_INFO = 'staff-telegram-link-code-digest:v1';

export class TenantSecretService {
  /** Derived once: it depends only on the root secret, and HKDF is not free. */
  private readonly key: Buffer;
  /** A separate key for the link-code digest, so it shares nothing with the sealing key. */
  private readonly linkCodeKey: Buffer;

  constructor(rootSecret: string) {
    // Trimmed because the seed has always derived from the trimmed JWT_SECRET, and rows it sealed
    // exist. A root that differed by a trailing newline would open none of them, and GCM cannot tell
    // that apart from tampering.
    const root = rootSecret.trim();
    if (root.length === 0) {
      throw new TenantSecretError(
        TenantSecretErrorCodes.TENANT_SECRET_ROOT_MISSING,
        null,
        null,
        'Tenant secrets cannot be sealed or opened without a root secret (JWT_SECRET)',
      );
    }
    this.key = deriveKey(root, TENANT_SECRET_INFO);
    this.linkCodeKey = deriveKey(root, STAFF_LINK_CODE_DIGEST_INFO);
  }

  /**
   * The stored and queued form of a staff Telegram link code: HMAC-SHA256 hex over the operator and
   * the normalized code. Keyed because the code is short enough to type: a plain hash in a database
   * dump or a queued update could be walked back to a live code within its lifetime. The operator is
   * part of the message, so the same code typed at another operator's bot is a different digest.
   * Lives here because this class owns the keys derived from the deployment's root secret, and the
   * webhook, which redacts the code before storing anything, already holds it.
   */
  staffLinkCodeDigest(tenantId: string, normalizedCode: string): string {
    return createHmac('sha256', this.linkCodeKey)
      .update(`${tenantId}:${normalizedCode}`, 'utf8')
      .digest('hex');
  }

  sealBotToken(plaintext: string): string {
    return this.seal('botToken', plaintext);
  }

  sealWebhookSecret(plaintext: string): string {
    return this.seal('webhookSecret', plaintext);
  }

  sealIchancyPassword(plaintext: string): string {
    return this.seal('ichancyPassword', plaintext);
  }

  openBotToken(tenant: Pick<Tenant, 'id' | 'botTokenEnc'>): string {
    return this.open('botToken', tenant.id, tenant.botTokenEnc);
  }

  openWebhookSecret(tenant: Pick<Tenant, 'id' | 'webhookSecretEnc'>): string {
    return this.open('webhookSecret', tenant.id, tenant.webhookSecretEnc);
  }

  openIchancyPassword(tenant: Pick<Tenant, 'id' | 'ichancyPasswordEnc'>): string {
    return this.open('ichancyPassword', tenant.id, tenant.ichancyPasswordEnc);
  }

  private seal(field: TenantSecretField, plaintext: string): string {
    if (plaintext.trim().length === 0 || isTenantSecretSentinel(plaintext)) {
      throw new TenantSecretError(
        TenantSecretErrorCodes.TENANT_SECRET_REFUSED,
        field,
        null,
        `Refused to seal an empty or placeholder ${FIELD_LABELS[field]}`,
      );
    }
    return sealSecret(this.key, plaintext);
  }

  private open(field: TenantSecretField, tenantId: string, stored: string | null): string {
    if (stored === null || stored.trim().length === 0 || isTenantSecretSentinel(stored)) {
      throw this.unconfigured(field, tenantId);
    }

    let plaintext: string;
    try {
      plaintext = openSecret(this.key, stored);
    } catch (error: unknown) {
      // SecretBoxError messages describe the envelope (segments, nonce, tag, version), never its
      // content, so they are safe to carry. Anything else is a bug and must surface unchanged.
      if (!(error instanceof SecretBoxError)) throw error;
      throw new TenantSecretError(
        TenantSecretErrorCodes.TENANT_SECRET_UNREADABLE,
        field,
        tenantId,
        `The ${FIELD_LABELS[field]} of tenant ${tenantId} cannot be opened: ${error.message}`,
      );
    }

    // A sentinel that was sealed is still a sentinel. Nothing writes one through seal(), which
    // refuses it, but a row sealed by an older writer must not be the one way a placeholder reaches
    // Telegram or Ichancy.
    if (plaintext.trim().length === 0 || isTenantSecretSentinel(plaintext)) {
      throw this.unconfigured(field, tenantId);
    }
    return plaintext;
  }

  private unconfigured(field: TenantSecretField, tenantId: string): TenantSecretError {
    return new TenantSecretError(
      TenantSecretErrorCodes.TENANT_SECRET_UNCONFIGURED,
      field,
      tenantId,
      `The ${FIELD_LABELS[field]} of tenant ${tenantId} has not been set; set it from the dashboard`,
    );
  }
}
