import { deriveIchancyCredentials } from './ichancy-credentials.util';
const EMAIL_DOMAIN = 'players.example.com';

const SECRET = 'test-root-secret-please-do-not-use-in-production';
const PLAYER_A = '0f4a1c2e-1111-4aaa-8bbb-000000000001';
const PLAYER_B = '0f4a1c2e-2222-4aaa-8bbb-000000000002';
const TG_A = 912911246n;
const TG_B = 456789123n;

describe('deriveIchancyCredentials', () => {
  it('is deterministic — the whole recovery story depends on this', () => {
    // If this ever stops holding, a registration that timed out can never be reconnected to the
    // account it may have created, because the login is the only handle we have.
    const first = deriveIchancyCredentials(SECRET, PLAYER_A, TG_A, EMAIL_DOMAIN);
    const second = deriveIchancyCredentials(SECRET, PLAYER_A, TG_A, EMAIL_DOMAIN);
    expect(second).toEqual(first);
  });

  it('gives different players different credentials', () => {
    const a = deriveIchancyCredentials(SECRET, PLAYER_A, TG_A, EMAIL_DOMAIN);
    const b = deriveIchancyCredentials(SECRET, PLAYER_B, TG_B, EMAIL_DOMAIN);
    expect(a.login).not.toEqual(b.login);
    expect(a.password).not.toEqual(b.password);
    expect(a.email).not.toEqual(b.email);
  });

  it('depends on the root secret, so a player id alone does not reveal credentials', () => {
    const a = deriveIchancyCredentials(SECRET, PLAYER_A, TG_A, EMAIL_DOMAIN);
    const b = deriveIchancyCredentials(`${SECRET}-rotated`, PLAYER_A, TG_A, EMAIL_DOMAIN);
    expect(a.login).not.toEqual(b.login);
    expect(a.password).not.toEqual(b.password);
  });

  it('derives login and password independently (no shared digest)', () => {
    const { login, password } = deriveIchancyCredentials(SECRET, PLAYER_A, TG_A, EMAIL_DOMAIN);
    // A naive implementation that sliced one digest for both would leak the password from the
    // login, which is stored in plaintext and shown to staff.
    expect(password).not.toContain(login.slice(1));
    expect(login).not.toContain(password.slice(0, 8));
  });

  // ── the readable format ────────────────────────────────────────────────────────────────────

  it('puts the Telegram id in the login so the agent can identify the row in their panel', () => {
    const { login } = deriveIchancyCredentials(SECRET, PLAYER_A, TG_A, EMAIL_DOMAIN);
    expect(login).toMatch(/^p912911246_[a-z0-9]{8}$/);
  });

  it('starts with a letter and stays lowercase alphanumeric plus one underscore', () => {
    for (const [playerId, telegramUserId] of [
      [PLAYER_A, TG_A],
      [PLAYER_B, TG_B],
      // The largest id Telegram can currently issue, and a small legacy one.
      ['99999999-9999-4999-8999-999999999999', 9999999999999999999n],
      ['11111111-1111-4111-8111-111111111111', 7n],
    ] as const) {
      const { login } = deriveIchancyCredentials(SECRET, playerId, telegramUserId, EMAIL_DOMAIN);
      expect(login).toMatch(/^p\d{1,19}_[a-z0-9]{8}$/);
    }
  });

  it('does NOT let a known Telegram id reveal the login', () => {
    // The Telegram id is public — anyone in a group with the player can read it. The keyed suffix
    // is what stops "I know who you are" from becoming "I know your account name".
    const real = deriveIchancyCredentials(SECRET, PLAYER_A, TG_A, EMAIL_DOMAIN).login;
    const guessed = `p${TG_A.toString()}_`;
    expect(real.startsWith(guessed)).toBe(true);
    expect(real).not.toBe(guessed);
    // A different secret over the same public id produces a different login.
    const other = deriveIchancyCredentials(`${SECRET}-x`, PLAYER_A, TG_A, EMAIL_DOMAIN).login;
    expect(other).not.toBe(real);
  });

  it('builds the email from the login on the configured domain', () => {
    const { login, email } = deriveIchancyCredentials(SECRET, PLAYER_A, TG_A, EMAIL_DOMAIN);
    expect(email).toBe(`${login}@${EMAIL_DOMAIN}`);
  });

  /**
   * REGRESSION — the first real registerPlayer, 2026-08-19, was refused with "Email field contains
   * invalid characters." because the domain was `players.ichancy-cashier.invalid`. RFC 2606's
   * `.invalid` is the correct choice for an address that must never deliver, and Ichancy's validator
   * rejects it: it checks the TLD against a list. Probing proved the TLD was the sole cause — the
   * same local part on `.com` was accepted, and the underscore, digits and hyphen were all fine.
   */
  it('never produces a reserved TLD Ichancy refuses', () => {
    const { email } = deriveIchancyCredentials(SECRET, PLAYER_A, TG_A, EMAIL_DOMAIN);
    for (const rejected of ['.invalid', '.test', '.localhost', '.example']) {
      expect(email.endsWith(rejected)).toBe(false);
    }
  });

  it('accepts the local part Ichancy proved it allows', () => {
    // `p912911246_7fszgwgh` was accepted by the live API (it failed on the DOMAIN, not the local
    // part), so underscores and digits are known-good and must not be "fixed" later.
    const { login } = deriveIchancyCredentials(SECRET, PLAYER_A, TG_A, EMAIL_DOMAIN);
    expect(login).toMatch(/^p\d+_[a-z0-9]{8}$/);
  });

  it('produces a password satisfying every common character-class policy', () => {
    const { password } = deriveIchancyCredentials(SECRET, PLAYER_A, TG_A, EMAIL_DOMAIN);
    // EXACTLY 16: the live API refuses anything longer ("Password should contain maximum 16
    // characters."), and the four class characters must still fit inside that ceiling.
    expect(password.length).toBe(16);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/\d/);
    expect(password).toMatch(/[^A-Za-z0-9]/);
  });

  it('never collides across a large batch of ids', () => {
    const logins = new Set<string>();
    for (let index = 0; index < 5_000; index += 1) {
      const playerId = `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
      logins.add(deriveIchancyCredentials(SECRET, playerId, BigInt(1_000_000 + index), EMAIL_DOMAIN).login);
    }
    expect(logins.size).toBe(5_000);
  });

  it('cannot collide even if two players somehow shared a derived suffix', () => {
    // `players.telegram_user_id` is UNIQUE, so the readable half alone guarantees distinct logins.
    // This is strictly stronger than the old format, which relied on 75 bits of derivation alone.
    const a = deriveIchancyCredentials(SECRET, PLAYER_A, TG_A, EMAIL_DOMAIN);
    const b = deriveIchancyCredentials(SECRET, PLAYER_A, TG_B, EMAIL_DOMAIN);
    expect(a.login).not.toBe(b.login);
  });
});
