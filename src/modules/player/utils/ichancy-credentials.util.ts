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
  ICHANCY_PLAYER_EMAIL_DOMAIN,
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
 * 15 encoded characters over a 32-symbol alphabet = 75 bits. Collision probability across even
 * 10^9 players is negligible, and the login stays short enough for any sane form validation.
 */
const LOGIN_BODY_LENGTH = 15;

/**
 * Leading letter: some systems reject a username that starts with a digit, and finding that out
 * costs a failed registration per player.
 */
const LOGIN_PREFIX = 'p';

/** Their documented rule is ">= 3 characters"; we have no reason to be near that floor. */
const PASSWORD_BODY_LENGTH = 24;

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
 * Deterministic for a given (rootSecret, playerId). Changing the root secret changes every
 * derived credential, which is why rotating it requires a migration that re-reads the stored
 * `ichancyLogin` rather than recomputing it — the STORED login always wins over a recomputed one.
 */
export function deriveIchancyCredentials(rootSecret: string, playerId: string): IchancyCredentials {
  const login =
    LOGIN_PREFIX +
    encodeAlphabet(
      derive(rootSecret, CREDENTIAL_INFO_LOGIN, playerId),
      LOGIN_ALPHABET,
      LOGIN_BODY_LENGTH,
    );

  const password =
    derive(rootSecret, CREDENTIAL_INFO_PASSWORD, playerId)
      .toString('base64url')
      .slice(0, PASSWORD_BODY_LENGTH) + PASSWORD_CLASS_SUFFIX;

  return {
    login,
    email: `${login}@${ICHANCY_PLAYER_EMAIL_DOMAIN}`,
    password,
  };
}
