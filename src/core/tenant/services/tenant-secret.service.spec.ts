import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';

import { deriveKey, sealSecret } from '../../crypto/secret-box.util';

import {
  TENANT_SECRET_INFO,
  TenantSecretError,
  TenantSecretErrorCodes,
  TenantSecretService,
  isTenantSecretSentinel,
  type TenantSecretErrorCode,
} from './tenant-secret.service';

const ROOT = 'unit-spec-root-secret-0123456789abcdef';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BOT_TOKEN = '123456789:AAspec-bot-token_value-XYZ';

/**
 * Sealed by the seed code as it stood before this service existed: `deriveKey(root,
 * 'ichancy-tenant-secret-enc:v1')` then `sealSecret`, from the player module's secret box. A frozen
 * literal, so a future change to the label, the salt or the envelope breaks this test rather than
 * every deployment's stored secrets.
 */
const LEGACY_ROOT = 'legacy-vector-root-secret-not-a-real-jwt-secret';
const LEGACY_SEALED =
  'v1.mp7chprteldBmmDW.cvWecGSvXc3QJpE37ef0ww.FYqInHWUf-5f8jSiqKYb3WlwVijssXfmr8KKuAgnSmb6PnLrwsOZHd4A7LSX5Q';
const LEGACY_PLAINTEXT = '123456789:AAlegacy-seed-sealed-bot-token_value';

/**
 * The old seed's sealing written out against node:crypto directly, so the compatibility test does
 * not depend on the very helper it is checking.
 */
function sealLikeTheOldSeed(rootSecret: string, plaintext: string): string {
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(rootSecret.trim(), 'utf8'),
      Buffer.from('ichancy-cashier/hkdf/v1'),
      Buffer.from('ichancy-tenant-secret-enc:v1', 'utf8'),
      32,
    ),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/** Runs the action and returns the TenantSecretError it threw, failing the test otherwise. */
function failure(action: () => unknown): TenantSecretError {
  try {
    action();
  } catch (error: unknown) {
    if (error instanceof TenantSecretError) return error;
    throw error;
  }
  throw new Error('expected a TenantSecretError');
}

function expectCode(action: () => unknown, code: TenantSecretErrorCode): TenantSecretError {
  const error = failure(action);
  expect(error.code).toBe(code);
  return error;
}

/** Flips every bit of the first byte of one envelope segment (1 = nonce, 2 = tag, 3 = ciphertext). */
function tamper(sealed: string, segment: 1 | 2 | 3): string {
  const parts = sealed.split('.');
  const bytes = Buffer.from(parts[segment] as string, 'base64url');
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  parts[segment] = bytes.toString('base64url');
  return parts.join('.');
}

const botRow = (botTokenEnc: string) => ({ id: TENANT_ID, botTokenEnc });

describe('TenantSecretService', () => {
  const secrets = new TenantSecretService(ROOT);

  describe('round trip', () => {
    it('opens each secret it sealed', () => {
      expect(secrets.openBotToken(botRow(secrets.sealBotToken(BOT_TOKEN)))).toBe(BOT_TOKEN);
      expect(
        secrets.openWebhookSecret({
          id: TENANT_ID,
          webhookSecretEnc: secrets.sealWebhookSecret('webhook-secret-value'),
        }),
      ).toBe('webhook-secret-value');
      expect(
        secrets.openIchancyPassword({
          id: TENANT_ID,
          ichancyPasswordEnc: secrets.sealIchancyPassword('  p@ss with spaces  '),
        }),
      ).toBe('  p@ss with spaces  ');
    });

    it('seals to the versioned envelope with a fresh nonce every time', () => {
      const first = secrets.sealBotToken(BOT_TOKEN);
      const second = secrets.sealBotToken(BOT_TOKEN);

      expect(first).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(first).not.toBe(second);
      expect(first.split('.')[1]).not.toBe(second.split('.')[1]);
      expect(first).not.toContain(BOT_TOKEN);
    });

    it('opens with a separately constructed instance from the same root', () => {
      const sealed = secrets.sealBotToken(BOT_TOKEN);
      expect(new TenantSecretService(ROOT).openBotToken(botRow(sealed))).toBe(BOT_TOKEN);
    });
  });

  describe('rows sealed by the old seed code', () => {
    it('opens the frozen vector the pre-service seed produced', () => {
      const legacy = new TenantSecretService(LEGACY_ROOT);
      expect(legacy.openBotToken(botRow(LEGACY_SEALED))).toBe(LEGACY_PLAINTEXT);
    });

    it('opens a value sealed with the old derivation written out by hand', () => {
      const sealed = sealLikeTheOldSeed(ROOT, 'agent-password');
      expect(secrets.openIchancyPassword({ id: TENANT_ID, ichancyPasswordEnc: sealed })).toBe(
        'agent-password',
      );
    });

    it('derives from the trimmed root, exactly as the seed did with JWT_SECRET', () => {
      const sealedBySeed = sealLikeTheOldSeed(`  ${ROOT}\n`, BOT_TOKEN);
      expect(new TenantSecretService(`${ROOT}\n`).openBotToken(botRow(sealedBySeed))).toBe(
        BOT_TOKEN,
      );
    });

    it('keeps the label the seed used', () => {
      expect(TENANT_SECRET_INFO).toBe('ichancy-tenant-secret-enc:v1');
    });
  });

  describe('tamper detection', () => {
    it.each([
      ['nonce', 1],
      ['tag', 2],
      ['ciphertext', 3],
    ] as const)('refuses a value whose %s was altered', (_name, segment) => {
      const sealed = secrets.sealBotToken(BOT_TOKEN);
      expectCode(
        () => secrets.openBotToken(botRow(tamper(sealed, segment))),
        TenantSecretErrorCodes.TENANT_SECRET_UNREADABLE,
      );
    });

    it('refuses a truncated tag instead of accepting a shorter one', () => {
      const parts = secrets.sealBotToken(BOT_TOKEN).split('.');
      parts[2] = Buffer.from(parts[2] as string, 'base64url')
        .subarray(0, 4)
        .toString('base64url');
      expectCode(
        () => secrets.openBotToken(botRow(parts.join('.'))),
        TenantSecretErrorCodes.TENANT_SECRET_UNREADABLE,
      );
    });

    it('refuses an unknown version and a value that was never sealed', () => {
      const [, ...rest] = secrets.sealBotToken(BOT_TOKEN).split('.');
      expectCode(
        () => secrets.openBotToken(botRow(['v2', ...rest].join('.'))),
        TenantSecretErrorCodes.TENANT_SECRET_UNREADABLE,
      );
      expectCode(
        () => secrets.openBotToken(botRow(BOT_TOKEN)),
        TenantSecretErrorCodes.TENANT_SECRET_UNREADABLE,
      );
    });
  });

  describe('wrong key', () => {
    it('refuses a value sealed under another JWT_SECRET', () => {
      const other = new TenantSecretService('another-root-secret-0123456789abcdef');
      expectCode(
        () => other.openBotToken(botRow(secrets.sealBotToken(BOT_TOKEN))),
        TenantSecretErrorCodes.TENANT_SECRET_UNREADABLE,
      );
    });

    it('refuses a value sealed under the same root with a different label', () => {
      // Domain separation: a player credential sealed under its own label must not open here.
      const sealed = sealSecret(deriveKey(ROOT, 'ichancy-credential-enc:v1'), BOT_TOKEN);
      expectCode(
        () => secrets.openBotToken(botRow(sealed)),
        TenantSecretErrorCodes.TENANT_SECRET_UNREADABLE,
      );
    });

    it('refuses to exist without a root secret', () => {
      expectCode(
        () => new TenantSecretService('   '),
        TenantSecretErrorCodes.TENANT_SECRET_ROOT_MISSING,
      );
    });
  });

  describe('sentinels and placeholders', () => {
    it.each([
      'REPLACE-ME-BOT-TOKEN',
      'REPLACE-ME',
      'SEED-PLACEHOLDER-TELEGRAM-BOT-TOKEN',
      'SEED-PLACEHOLDER-PLATFORM-HAS-NO-BOT',
      'UNUSED-PLATFORM-TENANT',
      '  replace-me-bot-token ',
      '',
      '   ',
    ])('refuses to open %j as a bot token', (stored) => {
      const error = expectCode(
        () => secrets.openBotToken(botRow(stored)),
        TenantSecretErrorCodes.TENANT_SECRET_UNCONFIGURED,
      );
      expect(error.field).toBe('botToken');
      expect(error.tenantId).toBe(TENANT_ID);
    });

    it('treats a missing webhook secret as unconfigured, not as an empty secret', () => {
      expectCode(
        () => secrets.openWebhookSecret({ id: TENANT_ID, webhookSecretEnc: null }),
        TenantSecretErrorCodes.TENANT_SECRET_UNCONFIGURED,
      );
    });

    it('refuses the migration sentinel in the Ichancy password column', () => {
      expectCode(
        () =>
          secrets.openIchancyPassword({
            id: TENANT_ID,
            ichancyPasswordEnc: 'REPLACE-ME-ICHANCY-PASSWORD',
          }),
        TenantSecretErrorCodes.TENANT_SECRET_UNCONFIGURED,
      );
    });

    it('refuses a sentinel even when it was sealed', () => {
      const sealedSentinel = sealLikeTheOldSeed(ROOT, 'SEED-PLACEHOLDER-ICHANCY-PASSWORD');
      expectCode(
        () => secrets.openIchancyPassword({ id: TENANT_ID, ichancyPasswordEnc: sealedSentinel }),
        TenantSecretErrorCodes.TENANT_SECRET_UNCONFIGURED,
      );
    });

    it('refuses to seal a sentinel or an empty value', () => {
      expectCode(
        () => secrets.sealBotToken('REPLACE-ME-BOT-TOKEN'),
        TenantSecretErrorCodes.TENANT_SECRET_REFUSED,
      );
      expectCode(
        () => secrets.sealWebhookSecret(' '),
        TenantSecretErrorCodes.TENANT_SECRET_REFUSED,
      );
      expectCode(
        () => secrets.sealIchancyPassword('unused-anything'),
        TenantSecretErrorCodes.TENANT_SECRET_REFUSED,
      );
    });

    it('recognises sentinels and never a sealed value', () => {
      expect(isTenantSecretSentinel('SEED-PLACEHOLDER-X')).toBe(true);
      expect(isTenantSecretSentinel(secrets.sealBotToken(BOT_TOKEN))).toBe(false);
      expect(isTenantSecretSentinel(BOT_TOKEN)).toBe(false);
    });
  });

  describe('errors never carry a secret', () => {
    it('keeps the stored and the opened value out of every refusal', () => {
      const sealed = secrets.sealBotToken(BOT_TOKEN);
      const errors = [
        failure(() => secrets.openBotToken(botRow(tamper(sealed, 3)))),
        failure(() => secrets.openBotToken(botRow(BOT_TOKEN))),
        failure(() =>
          new TenantSecretService('other-root-0123456789abcdef').openBotToken(botRow(sealed)),
        ),
        failure(() => secrets.sealBotToken('REPLACE-ME-with-a-real-looking-tail')),
      ];

      for (const error of errors) {
        const rendered = `${String(error)} ${error.stack ?? ''} ${JSON.stringify(error)}`;
        expect(rendered).not.toContain(BOT_TOKEN);
        expect(rendered).not.toContain(sealed);
        expect(rendered).not.toContain('real-looking-tail');
      }
    });
  });
});
