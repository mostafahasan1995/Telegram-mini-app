import { deriveIchancyCredentials } from './ichancy-credentials.util';
import { ICHANCY_PLAYER_EMAIL_DOMAIN } from '../player.constants';

const SECRET = 'test-root-secret-please-do-not-use-in-production';
const PLAYER_A = '0f4a1c2e-1111-4aaa-8bbb-000000000001';
const PLAYER_B = '0f4a1c2e-2222-4aaa-8bbb-000000000002';

describe('deriveIchancyCredentials', () => {
  it('is deterministic — the whole recovery story depends on this', () => {
    // If this ever stops holding, a registration that timed out can never be reconnected to the
    // account it may have created, because the login is the only handle we have.
    const first = deriveIchancyCredentials(SECRET, PLAYER_A);
    const second = deriveIchancyCredentials(SECRET, PLAYER_A);
    expect(second).toEqual(first);
  });

  it('gives different players different credentials', () => {
    const a = deriveIchancyCredentials(SECRET, PLAYER_A);
    const b = deriveIchancyCredentials(SECRET, PLAYER_B);
    expect(a.login).not.toEqual(b.login);
    expect(a.password).not.toEqual(b.password);
    expect(a.email).not.toEqual(b.email);
  });

  it('depends on the root secret, so a player id alone does not reveal credentials', () => {
    const a = deriveIchancyCredentials(SECRET, PLAYER_A);
    const b = deriveIchancyCredentials(`${SECRET}-rotated`, PLAYER_A);
    expect(a.login).not.toEqual(b.login);
    expect(a.password).not.toEqual(b.password);
  });

  it('derives login and password independently (no shared digest)', () => {
    const { login, password } = deriveIchancyCredentials(SECRET, PLAYER_A);
    // A naive implementation that slices one digest for both would leak the password from the
    // login, which is stored in plaintext and shown to staff.
    expect(password).not.toContain(login.slice(1));
    expect(login).not.toContain(password.slice(0, 8));
  });

  it('produces a login that starts with a letter and is lowercase alphanumeric', () => {
    for (const playerId of [PLAYER_A, PLAYER_B, '99999999-9999-4999-8999-999999999999']) {
      const { login } = deriveIchancyCredentials(SECRET, playerId);
      expect(login).toMatch(/^[a-z][a-z0-9]{15}$/);
    }
  });

  it('builds the email from the login on the reserved .invalid domain', () => {
    const { login, email } = deriveIchancyCredentials(SECRET, PLAYER_A);
    expect(email).toBe(`${login}@${ICHANCY_PLAYER_EMAIL_DOMAIN}`);
    // RFC 2606 reserves .invalid precisely so it can never resolve — no mail can reach a real
    // person from these synthetic addresses.
    expect(email.endsWith('.invalid')).toBe(true);
  });

  it('produces a password satisfying every common character-class policy', () => {
    const { password } = deriveIchancyCredentials(SECRET, PLAYER_A);
    expect(password.length).toBeGreaterThanOrEqual(24);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/\d/);
    expect(password).toMatch(/[^A-Za-z0-9]/);
  });

  it('never collides across a large batch of ids', () => {
    const logins = new Set<string>();
    for (let index = 0; index < 5_000; index += 1) {
      const playerId = `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
      logins.add(deriveIchancyCredentials(SECRET, playerId).login);
    }
    expect(logins.size).toBe(5_000);
  });
});
