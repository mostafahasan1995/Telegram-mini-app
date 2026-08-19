/**
 * WHY the Ichancy credentials are DERIVED rather than random:
 *
 * `registerPlayer` returns the number 1, not an id. The id is only ever learned by looking the
 * account up by its login. So if a registration times out, the login is the ONLY thing that can
 * reconnect us to the account that may or may not have been created. A random login stored in the
 * same transaction that failed is a login we no longer have — and the account becomes an orphan
 * inside Ichancy that we can neither find nor re-register (duplicate login/email forever).
 *
 * Deriving login/email/password from `Player.id` makes the recovery path total: for any player, at
 * any time, from any process, we can recompute exactly what we would have registered and ask
 * `getPlayersForCurrentAgent(userName=...)` about it. That is what makes PlayerLinkService safe to
 * call twice.
 *
 * The derivation is keyed by a server secret, so the credentials are not guessable from a player id
 * that appears in URLs and logs.
 */
import { createHmac } from 'node:crypto';
import {
  CREDENTIAL_INFO_LOGIN,
  CREDENTIAL_INFO_PASSWORD,
} from '../player.constants';

export interface IchancyCredentials {
  readonly login: string;
  readonly email: string;
  readonly password: string;
}

/**
 * Crockford-ish lowercase base32 without vowels-that-confuse: we only need an alphabet Ichancy
 * will certainly accept in a `login`, so it is restricted to [a-z0-9] and nothing else.
 */
const LOGIN_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/**
 * 8 encoded characters over a 32-symbol alphabet = 40 bits, keyed by the root secret. It is not a
 * uniqueness device — the Telegram id in front of it already guarantees that — it exists so the
 * login cannot be GUESSED from a Telegram id, which is public to anyone in a group chat with the
 * player.
 */
const LOGIN_SUFFIX_LENGTH = 8;

/**
 * Leading letter: some systems reject a username that starts with a digit, and finding that out
 * costs a failed registration per player.
 */
const LOGIN_PREFIX = 'p';

/**
 * Separator between the readable part and the keyed part. Underscore is known-good: the agent's own
 * panel-created players use it (`Ahmad379_79968`), so Ichancy certainly accepts it in a login.
 */
const LOGIN_SEPARATOR = '_';

/**
 * The password is 12 derived characters + the 4-character class suffix = EXACTLY 16.
 *
 * WHY 16 AND NOT MORE: the published docs state only a MINIMUM ("Password should contain at least 3
 * characters"), so this was 24+4=28 — and the live API refused it on 2026-08-19 with
 *
 *     "Password should contain maximum 16 characters."
 *
 * an undocumented ceiling, discovered only by registering for real. 16 is therefore not a
 * preference, it is the hard upper bound; the value below is the largest body that fits with the
 * class suffix. 12 base64url characters is ~72 bits, which is far beyond what matters for a
 * credential no human ever types and that only our backend holds.
 */
const PASSWORD_BODY_LENGTH = 12;

/**
 * Guarantees the password contains an uppercase letter, a lowercase letter, a digit and a symbol.
 * The entropy lives entirely in the 24-character body; this suffix only satisfies character-class
 * policies we cannot see from here and must not fail a registration over.
 */
const PASSWORD_CLASS_SUFFIX = 'Aa1!';

function encodeAlphabet(digest: Buffer, alphabet: string, length: number): string {
  let out = '';
  for (let index = 0; index < length; index += 1) {
    // A 32-byte sha256 digest covers a 15-character body comfortably; the modulo keeps the
    // mapping total even if either length is changed later.
    const byte = digest[index % digest.length] ?? 0;
    out += alphabet[byte % alphabet.length] ?? alphabet[0];
  }
  return out;
}

function derive(rootSecret: string, info: string, playerId: string): Buffer {
  // The label is part of the MESSAGE as well as being a distinct call, so two different infos can
  // never produce the same digest for the same player.
  return createHmac('sha256', rootSecret).update(`${info}|${playerId}`).digest();
}

/**
 * Deterministic for a given (rootSecret, playerId, telegramUserId). Changing the root secret changes
 * every derived credential, which is why rotating it requires a migration that re-reads the stored
 * `ichancyLogin` rather than recomputing it — the STORED login always wins over a recomputed one.
 *
 * ══ WHY THE TELEGRAM ID IS IN THE LOGIN ═══════════════════════════════════════════════════════
 * `p912911246_k3mq9x2v`, not `p7k3mq9x2vn4bcd`. The agent reads their player list in the Ichancy
 * panel, and an opaque login makes every row there unidentifiable — matching one back to a person
 * meant a database query. The Telegram id is the handle every other surface already prints (the
 * arrivals card, the deposit card, /register), so putting it in the login makes the panel joinable
 * to everything else by eye.
 *
 * The keyed suffix stays because the Telegram id is PUBLIC: anyone in a group with the player can
 * read it. Without the suffix the login would be guessable for any known person, leaving only the
 * password between an attacker and a named account. With it, knowing who somebody is tells you
 * nothing you can use.
 *
 * ══ WHY THIS COULD ONLY BE CHANGED BEFORE THE FIRST REAL REGISTRATION ═════════════════════════
 * The derived login is the ONLY handle that can reconnect us to an account whose registration timed
 * out (registerPlayer answers `1`, never an id — see the header). Change the derivation while such
 * an orphan exists and it is stranded forever: we would look up a login that was never registered,
 * find nothing, and register a second account. This was changed on 2026-08-19, when the count of
 * accounts THIS SYSTEM had registered on the real API was exactly zero. Changing it again later is
 * not a refactor; it is a data migration that must first re-read every stored login.
 */
export function deriveIchancyCredentials(
  rootSecret: string,
  playerId: string,
  telegramUserId: bigint,
  emailDomain: string,
): IchancyCredentials {
  const suffix = encodeAlphabet(
    derive(rootSecret, CREDENTIAL_INFO_LOGIN, playerId),
    LOGIN_ALPHABET,
    LOGIN_SUFFIX_LENGTH,
  );
  const login = `${LOGIN_PREFIX}${telegramUserId.toString()}${LOGIN_SEPARATOR}${suffix}`;

  const password =
    derive(rootSecret, CREDENTIAL_INFO_PASSWORD, playerId)
      .toString('base64url')
      .slice(0, PASSWORD_BODY_LENGTH) + PASSWORD_CLASS_SUFFIX;

  return {
    login,
    email: `${login}@${emailDomain}`,
    password,
  };
}
