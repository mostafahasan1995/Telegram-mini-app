/**
 * The hasher is the only thing standing between a leaked `admin_users` dump and every console
 * password, so these tests pin the properties rather than the implementation: a round trip works,
 * nothing else does, a hostile stored string cannot make us allocate, and "no such user" does the
 * same work as "wrong password".
 *
 * A cheap cost (N=2^10) is injected for almost every test: the production cost is deliberately
 * slow, and one test at that cost is enough to prove it works.
 */
import { Logger } from '@nestjs/common';

import {
  DEFAULT_SCRYPT_COST,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PasswordHasherService,
  type ScryptCost,
} from './password-hasher.service';

const CHEAP: ScryptCost = { ln: 10, r: 8, p: 1 };
const PASSWORD = 'correct horse battery';

/** Records every derivation, so the dummy path can be proven to do real work at the real cost. */
class CountingHasher extends PasswordHasherService {
  readonly derivations: ScryptCost[] = [];

  protected override derive(
    password: Buffer,
    salt: Buffer,
    keyLength: number,
    cost: ScryptCost,
  ): Promise<Buffer> {
    this.derivations.push({ ...cost });
    return super.derive(password, salt, keyLength, cost);
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Swaps one base64 character for a different one, keeping the text canonical. */
function flipFirstChar(text: string): string {
  const first = text[0] ?? 'A';
  return (first === 'A' ? 'B' : 'A') + text.slice(1);
}

/**
 * Changes only the unused low bits of the final character: the bytes decode identically, but the
 * text is no longer the canonical encoding.
 */
function nonCanonical(text: string): string {
  const last = text[text.length - 1] ?? 'A';
  const index = B64.indexOf(last);
  return text.slice(0, -1) + (B64[index ^ 1] ?? 'A');
}

function segments(stored: string): { params: string; salt: string; key: string } {
  const [, , params, salt, key] = stored.split('$');
  if (params === undefined || salt === undefined || key === undefined) {
    throw new Error('unexpected hash layout');
  }
  return { params, salt, key };
}

describe('PasswordHasherService', () => {
  let hasher: CountingHasher;

  beforeEach(() => {
    hasher = new CountingHasher(CHEAP);
  });

  describe('round trip', () => {
    it('verifies the password it hashed, without asking for a rehash', async () => {
      const stored = await hasher.hash(PASSWORD);

      await expect(hasher.verify(PASSWORD, stored)).resolves.toEqual({
        ok: true,
        needsRehash: false,
      });
    });

    it('encodes the cost in the stored string, PHC style, with no padding', async () => {
      const stored = await hasher.hash(PASSWORD);

      expect(stored).toMatch(/^\$scrypt\$ln=10,r=8,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    });

    it('salts every hash, so the same password never produces the same string', async () => {
      const first = await hasher.hash(PASSWORD);
      const second = await hasher.hash(PASSWORD);

      expect(first).not.toBe(second);
      await expect(hasher.verify(PASSWORD, first)).resolves.toMatchObject({ ok: true });
      await expect(hasher.verify(PASSWORD, second)).resolves.toMatchObject({ ok: true });
    });

    it('works at the production cost', async () => {
      const production = new PasswordHasherService();
      const stored = await production.hash(PASSWORD);

      const { ln, r, p } = DEFAULT_SCRYPT_COST;
      expect(stored.startsWith(`$scrypt$ln=${ln},r=${r},p=${p}$`)).toBe(true);
      await expect(production.verify(PASSWORD, stored)).resolves.toEqual({
        ok: true,
        needsRehash: false,
      });
    }, 30_000);

    it('treats composed and decomposed Unicode as the same password (NFC)', async () => {
      const stored = await hasher.hash('café-password');

      await expect(hasher.verify('café-password', stored)).resolves.toMatchObject({
        ok: true,
      });
    });

    it('never trims: a trailing space is part of the password', async () => {
      const stored = await hasher.hash(`${PASSWORD} `);

      await expect(hasher.verify(PASSWORD, stored)).resolves.toMatchObject({ ok: false });
      await expect(hasher.verify(`${PASSWORD} `, stored)).resolves.toMatchObject({ ok: true });
    });
  });

  describe('refusals', () => {
    it('refuses a wrong password', async () => {
      const stored = await hasher.hash(PASSWORD);

      await expect(hasher.verify('correct horse battery!', stored)).resolves.toEqual({
        ok: false,
        needsRehash: false,
      });
    });

    it('refuses a tampered key, salt or cost', async () => {
      const stored = await hasher.hash(PASSWORD);
      const { params, salt, key } = segments(stored);

      const tampered = [
        `$scrypt$${params}$${salt}$${flipFirstChar(key)}`,
        `$scrypt$${params}$${flipFirstChar(salt)}$${key}`,
        `$scrypt$ln=11,r=8,p=1$${salt}$${key}`,
        `$scrypt$ln=10,r=8,p=2$${salt}$${key}`,
      ];

      for (const candidate of tampered) {
        await expect(hasher.verify(PASSWORD, candidate)).resolves.toEqual({
          ok: false,
          needsRehash: false,
        });
      }
    });

    it('refuses malformed stored strings without throwing', async () => {
      const stored = await hasher.hash(PASSWORD);
      const { params, salt, key } = segments(stored);

      const malformed = [
        '',
        PASSWORD,
        '$scrypt$',
        `$scrypt$${params}$${salt}`,
        `$scrypt$${params}$${salt}$${key}$extra`,
        `$argon2id$v=19$m=65536,t=3,p=4$${salt}$${key}`,
        `$scrypt$ln=ten,r=8,p=1$${salt}$${key}`,
        `$scrypt$${params}$${salt}=$${key}`,
        `$scrypt$${params}$${nonCanonical(salt)}$${key}`,
        `$scrypt$${params}$${salt}$${nonCanonical(key)}`,
        // An 8-byte salt and a 16-byte key: well-formed base64, below the minimums.
        `$scrypt$${params}$${Buffer.alloc(8, 1).toString('base64').replace(/=+$/, '')}$${key}`,
        `$scrypt$${params}$${salt}$${Buffer.alloc(16, 1).toString('base64').replace(/=+$/, '')}`,
      ];

      for (const candidate of malformed) {
        await expect(hasher.verify(PASSWORD, candidate)).resolves.toEqual({
          ok: false,
          needsRehash: false,
        });
      }
    });

    it('never derives at a cost read from a hostile stored string', async () => {
      const stored = await hasher.hash(PASSWORD);
      const { salt, key } = segments(stored);
      hasher.derivations.length = 0;

      // 128 * 2^20 * 32 bytes would be 4 GiB of working memory for one sign-in attempt.
      const hostile = [
        `$scrypt$ln=20,r=32,p=1$${salt}$${key}`,
        `$scrypt$ln=30,r=8,p=1$${salt}$${key}`,
        `$scrypt$ln=16,r=8,p=99$${salt}$${key}`,
        `$scrypt$ln=1,r=1,p=1$${salt}$${key}`,
      ];

      for (const candidate of hostile) {
        await expect(hasher.verify(PASSWORD, candidate)).resolves.toMatchObject({ ok: false });
      }

      // Each was answered by the dummy derivation at OUR cost, never at the stored one.
      expect(hasher.derivations).toEqual(hostile.map(() => CHEAP));
    });
  });

  describe('timing equalisation', () => {
    it('does a full derivation at the current cost when there is no stored hash', async () => {
      await expect(hasher.verify(PASSWORD, null)).resolves.toEqual({
        ok: false,
        needsRehash: false,
      });

      expect(hasher.derivations).toEqual([CHEAP]);
    });

    it('does exactly as much work for "no such user" as for "wrong password"', async () => {
      const stored = await hasher.hash(PASSWORD);
      hasher.derivations.length = 0;

      await hasher.verify('not the password', stored);
      const wrongPassword = [...hasher.derivations];
      hasher.derivations.length = 0;

      await hasher.verify('not the password', null);
      const noSuchUser = [...hasher.derivations];

      expect(noSuchUser).toEqual(wrongPassword);
    });
  });

  describe('cost upgrades', () => {
    it('verifies an older, cheaper hash and asks for it to be re-stored', async () => {
      const legacy = await new PasswordHasherService(CHEAP).hash(PASSWORD);
      const upgraded = new PasswordHasherService({ ln: 11, r: 8, p: 1 });

      await expect(upgraded.verify(PASSWORD, legacy)).resolves.toEqual({
        ok: true,
        needsRehash: true,
      });

      const restored = await upgraded.hash(PASSWORD);
      expect(restored.startsWith('$scrypt$ln=11,r=8,p=1$')).toBe(true);
      await expect(upgraded.verify(PASSWORD, restored)).resolves.toEqual({
        ok: true,
        needsRehash: false,
      });
    });

    it('never asks to rehash after a failed verification', async () => {
      const legacy = await new PasswordHasherService(CHEAP).hash(PASSWORD);
      const upgraded = new PasswordHasherService({ ln: 11, r: 8, p: 1 });

      await expect(upgraded.verify('wrong password', legacy)).resolves.toEqual({
        ok: false,
        needsRehash: false,
      });
    });

    it('refuses to be constructed with an out-of-bounds cost', () => {
      expect(() => new PasswordHasherService({ ln: 30, r: 8, p: 1 })).toThrow(RangeError);
      expect(() => new PasswordHasherService({ ln: 4, r: 8, p: 1 })).toThrow(RangeError);
      expect(() => new PasswordHasherService({ ln: 10, r: 0, p: 1 })).toThrow(RangeError);
      expect(() => new PasswordHasherService({ ln: 10, r: 8, p: 1.5 })).toThrow(RangeError);
    });
  });

  describe('input bounds', () => {
    it(`accepts ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters`, async () => {
      await expect(hasher.hash('a'.repeat(PASSWORD_MIN_LENGTH))).resolves.toMatch(/^\$scrypt\$/);
      await expect(hasher.hash('a'.repeat(PASSWORD_MAX_LENGTH))).resolves.toMatch(/^\$scrypt\$/);
    });

    it('counts characters, not UTF-16 units', async () => {
      // 72 emoji are 144 UTF-16 units and 288 UTF-8 bytes, and still 72 characters.
      const stored = await hasher.hash('😀'.repeat(PASSWORD_MAX_LENGTH));
      await expect(hasher.verify('😀'.repeat(PASSWORD_MAX_LENGTH), stored)).resolves.toMatchObject({
        ok: true,
      });
      await expect(hasher.hash('😀'.repeat(PASSWORD_MAX_LENGTH + 1))).rejects.toThrow(RangeError);
    });

    it('refuses to hash a password outside the bounds, without echoing it', async () => {
      const tooShort = 'Sh0rt!!';
      const tooLong = 'L'.repeat(PASSWORD_MAX_LENGTH + 1);

      for (const candidate of [tooShort, tooLong]) {
        const error: unknown = await hasher.hash(candidate).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(RangeError);
        expect((error as RangeError).message).not.toContain(candidate);
      }
    });

    it('answers an absurdly long password with a refusal and no derivation at all', async () => {
      const stored = await hasher.hash(PASSWORD);
      hasher.derivations.length = 0;

      await expect(hasher.verify('x'.repeat(1_000_000), stored)).resolves.toEqual({
        ok: false,
        needsRehash: false,
      });
      expect(hasher.derivations).toHaveLength(0);
    });
  });

  it('logs nothing, on any path', async () => {
    const spies = [
      jest.spyOn(console, 'log').mockImplementation(() => undefined),
      jest.spyOn(console, 'warn').mockImplementation(() => undefined),
      jest.spyOn(console, 'error').mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined),
    ];

    try {
      const stored = await hasher.hash(PASSWORD);
      await hasher.verify(PASSWORD, stored);
      await hasher.verify('wrong password', stored);
      await hasher.verify(PASSWORD, null);
      await hasher.verify(PASSWORD, 'garbage');
      await hasher.hash('short').catch(() => undefined);

      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
