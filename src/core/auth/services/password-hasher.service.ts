/**
 * Console passwords, stored as scrypt.
 *
 * WHY SCRYPT: it is memory-hard, it ships in `node:crypto` (no native addon to build in the runner
 * image, nothing to keep patched), and the API contract names it. bcrypt would silently truncate
 * at 72 bytes; argon2 would need a compiled dependency for no gain at this scale.
 *
 * THE STORED STRING DESCRIBES ITSELF — `$scrypt$ln=15,r=8,p=3$<salt>$<key>` (PHC style, base64
 * without padding). The cost travels with every hash, so the cost can be raised later without a
 * migration: old hashes still verify with the parameters they were made with, and `verify()` says
 * `needsRehash` so the sign-in route can quietly re-store them at the new cost.
 *
 * FOUR THINGS HERE ARE LOAD-BEARING:
 *
 *  1. THE COMPARISON IS CONSTANT-TIME (`timingSafeEqual`). A byte-by-byte `===` leaks how many
 *     leading bytes of the derived key matched.
 *
 *  2. "NO SUCH USER" COSTS THE SAME AS "WRONG PASSWORD". `verify(password, null)` runs a full
 *     derivation at the current cost and returns false. Without it, a sign-in that answers an
 *     unknown username in 1 ms and a known one in 80 ms is a username oracle, whatever its error
 *     message says. A malformed stored hash takes the same path, for the same reason.
 *
 *  3. A STORED STRING IS UNTRUSTED INPUT. Its cost parameters are bounded before anything is
 *     allocated: a row edited to `ln=30` must not make one sign-in request allocate gigabytes.
 *
 *  4. NOTHING HERE LOGS, and no error message contains a password or a hash. There is not even a
 *     Logger in this class, so a future "helpful" debug line has to be added on purpose.
 *
 * Passwords are NFC-normalised before hashing: the same visible password typed on two keyboards
 * can arrive as composed or decomposed Unicode, and a person must not be locked out by that.
 * They are never trimmed — a space is a legitimate character.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/** Contract: `password` is 8–72 characters (API-CONTRACT.md, staff accounts). */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;

/** scrypt cost. `ln` is log2(N), which is how the PHC string spells it. */
export interface ScryptCost {
  ln: number;
  r: number;
  p: number;
}

/**
 * One of OWASP's equivalent scrypt settings (N=2^15, r=8, p=3). Chosen over N=2^17/p=1 because
 * memory is ~128·N·r bytes PER CONCURRENT SIGN-IN: 32 MiB here instead of 128 MiB, which matters on
 * a small VPS when several people sign in at once. CPU work is comparable.
 */
export const DEFAULT_SCRYPT_COST: Readonly<ScryptCost> = Object.freeze({ ln: 15, r: 8, p: 3 });

/**
 * Optional DI override for the cost. Nothing binds it in production; tests bind a cheap cost so
 * the unit suite does not spend seconds deriving keys.
 */
export const SCRYPT_COST = Symbol('SCRYPT_COST');

export interface PasswordVerification {
  ok: boolean;
  /**
   * True when the password matched but the stored hash was made with different parameters than
   * this service now uses. The caller should hash the password again and store the new string.
   */
  needsRehash: boolean;
}

const SALT_BYTES = 16;
const KEY_BYTES = 32;

/** Bounds applied to a PARSED hash (and to an injected cost) before any memory is committed. */
const MIN_LN = 10;
const MAX_LN = 20;
const MAX_R = 32;
const MAX_P = 16;
/** 128·N·r — scrypt's working memory. 256 MiB is 8x the default and still survivable. */
const MAX_MEMORY_BYTES = 256 * 1024 * 1024;
/** N·r·p — proportional to CPU time. 2^24 is ~20x the default. */
const MAX_WORK = 2 ** 24;
const MIN_STORED_SALT_BYTES = 16;
const MIN_STORED_KEY_BYTES = 32;
const MAX_STORED_KEY_BYTES = 64;

const HASH_PATTERN =
  /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{1,128})\$([A-Za-z0-9+/]{1,128})$/;

interface ParsedHash {
  cost: ScryptCost;
  salt: Buffer;
  key: Buffer;
}

const toB64 = (bytes: Buffer): string => bytes.toString('base64').replace(/=+$/, '');

/**
 * Decodes unpadded base64 and insists the text was the CANONICAL encoding. Node's decoder is
 * lenient (it ignores trailing bits), so without the round-trip check two different strings could
 * decode to the same bytes — harmless for security, but it would make "tampered" undetectable.
 */
function fromB64(text: string): Buffer | null {
  const bytes = Buffer.from(text, 'base64');
  return toB64(bytes) === text ? bytes : null;
}

function costIsWithinBounds(cost: ScryptCost): boolean {
  const { ln, r, p } = cost;
  if (![ln, r, p].every((value) => Number.isSafeInteger(value) && value >= 1)) return false;
  if (ln < MIN_LN || ln > MAX_LN || r > MAX_R || p > MAX_P) return false;
  const n = 2 ** ln;
  return 128 * n * r <= MAX_MEMORY_BYTES && n * r * p <= MAX_WORK;
}

function sameCost(a: ScryptCost, b: ScryptCost): boolean {
  return a.ln === b.ln && a.r === b.r && a.p === b.p;
}

/** Characters as a person counts them (code points), matching class-validator's length rules. */
function lengthIsAcceptable(password: string): boolean {
  // Cheap reject first: a code point is at most two UTF-16 units, so anything longer than twice
  // the limit cannot fit, and a megabyte body never reaches Array.from.
  if (password.length > PASSWORD_MAX_LENGTH * 2) return false;
  const codePoints = Array.from(password).length;
  return codePoints >= PASSWORD_MIN_LENGTH && codePoints <= PASSWORD_MAX_LENGTH;
}

@Injectable()
export class PasswordHasherService {
  private readonly cost: Readonly<ScryptCost>;

  constructor(@Optional() @Inject(SCRYPT_COST) cost?: ScryptCost) {
    const chosen = cost ?? DEFAULT_SCRYPT_COST;
    if (!costIsWithinBounds(chosen)) {
      // Thrown at boot, so a bad override can never produce hashes nothing can verify.
      throw new RangeError('scrypt cost parameters are out of bounds');
    }
    this.cost = Object.freeze({ ...chosen });
  }

  /**
   * Hashes a password for storage. Throws RangeError for a password outside the contract's length
   * bounds: the DTO is meant to have refused it already, so reaching here is a programming error,
   * not a user error. The message never includes the value.
   */
  async hash(password: string): Promise<string> {
    if (typeof password !== 'string' || !lengthIsAcceptable(password)) {
      throw new RangeError(
        `password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters`,
      );
    }

    const salt = randomBytes(SALT_BYTES);
    const key = await this.derive(this.encode(password), salt, KEY_BYTES, this.cost);
    const { ln, r, p } = this.cost;
    return `$scrypt$ln=${ln},r=${r},p=${p}$${toB64(salt)}$${toB64(key)}`;
  }

  /**
   * Checks a password against a stored hash. Never throws for a wrong password, an absent hash or a
   * malformed one — all three are `{ ok: false }`, and the first two take the same time.
   *
   * Pass `null` when there is no account (or the account has no password): the derivation still
   * runs, which is the whole point.
   */
  async verify(password: string, stored: string | null): Promise<PasswordVerification> {
    const refused: PasswordVerification = { ok: false, needsRehash: false };

    // An out-of-bounds password is refused without deriving anything. That timing difference only
    // reveals the length of the password the CALLER typed, which the caller already knows; it says
    // nothing about whether the account exists.
    if (typeof password !== 'string' || !lengthIsAcceptable(password)) return refused;

    const parsed = stored === null ? null : this.parse(stored);
    if (parsed === null) {
      await this.burn(password);
      return refused;
    }

    const candidate = await this.derive(
      this.encode(password),
      parsed.salt,
      parsed.key.length,
      parsed.cost,
    );
    // Lengths are equal by construction (keylen = stored key length), which timingSafeEqual
    // requires; the explicit check keeps that true if the code above ever changes.
    const ok = candidate.length === parsed.key.length && timingSafeEqual(candidate, parsed.key);

    return {
      ok,
      needsRehash:
        ok &&
        (!sameCost(parsed.cost, this.cost) ||
          parsed.salt.length !== SALT_BYTES ||
          parsed.key.length !== KEY_BYTES),
    };
  }

  /**
   * The scrypt call itself. `protected` so a test can count derivations and prove the dummy path
   * really does the work; nothing else should override it.
   */
  protected derive(
    password: Buffer,
    salt: Buffer,
    keyLength: number,
    cost: ScryptCost,
  ): Promise<Buffer> {
    const n = 2 ** cost.ln;
    const options: ScryptOptions = {
      N: n,
      r: cost.r,
      p: cost.p,
      // Node refuses when 128·N·r exceeds maxmem (default 32 MiB, which the default cost sits
      // right at). This is a ceiling, not an allocation; bounds were checked before we got here.
      maxmem: 2 * 128 * n * cost.r,
    };
    return new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, keyLength, options, (error, key) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(key);
      });
    });
  }

  /** Same work as a real verification at the current cost, against nothing. Result discarded. */
  private async burn(password: string): Promise<void> {
    const decoy = await this.derive(
      this.encode(password),
      randomBytes(SALT_BYTES),
      KEY_BYTES,
      this.cost,
    );
    timingSafeEqual(decoy, Buffer.alloc(KEY_BYTES));
  }

  private encode(password: string): Buffer {
    return Buffer.from(password.normalize('NFC'), 'utf8');
  }

  private parse(stored: string): ParsedHash | null {
    if (typeof stored !== 'string') return null;
    const match = HASH_PATTERN.exec(stored);
    if (match === null) return null;

    const [, ln, r, p, saltText, keyText] = match;
    if (
      ln === undefined ||
      r === undefined ||
      p === undefined ||
      saltText === undefined ||
      keyText === undefined
    ) {
      return null;
    }

    const cost: ScryptCost = { ln: Number(ln), r: Number(r), p: Number(p) };
    if (!costIsWithinBounds(cost)) return null;

    const salt = fromB64(saltText);
    const key = fromB64(keyText);
    if (salt === null || key === null) return null;
    if (salt.length < MIN_STORED_SALT_BYTES) return null;
    if (key.length < MIN_STORED_KEY_BYTES || key.length > MAX_STORED_KEY_BYTES) return null;

    return { cost, salt, key };
  }
}
