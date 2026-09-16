import type { Message, Update } from 'grammy/types';

import {
  STAFF_LINK_CODE_ALPHABET,
  STAFF_LINK_CODE_LENGTH,
  formatStaffLinkCode,
  isStaffLinkUpdate,
  newStaffLinkCode,
  normalizeStaffLinkCode,
  redactStaffLinkCode,
  staffLinkCommandOf,
} from './staff-link-code.util';

const DIGEST = 'a'.repeat(64);

const message = (text: string, chatType = 'private'): Message =>
  ({
    message_id: 1,
    date: 0,
    chat: { id: 42, type: chatType },
    from: { id: 42, is_bot: false, first_name: 'Staff' },
    text,
    entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]?.length ?? 0 }],
  }) as unknown as Message;

const updateOf = (text: string, chatType = 'private'): Update =>
  ({ update_id: 7, message: message(text, chatType) }) as unknown as Update;

/** A stand-in digest that shows what it was given, so a test can see the normalized code arrive. */
const fakeDigest = (code: string): string => `d${code.toLowerCase().padEnd(63, '0')}`;

describe('staff link code', () => {
  it('generates eight symbols of the unambiguous alphabet, differently each time', () => {
    const codes = new Set(Array.from({ length: 50 }, () => newStaffLinkCode()));
    expect(codes.size).toBe(50);
    for (const code of codes) {
      expect(code).toHaveLength(STAFF_LINK_CODE_LENGTH);
      expect([...code].every((symbol) => STAFF_LINK_CODE_ALPHABET.includes(symbol))).toBe(true);
    }
    expect(STAFF_LINK_CODE_ALPHABET).not.toMatch(/[IO01]/);
  });

  it('formats a code in two groups of four', () => {
    expect(formatStaffLinkCode('ABCDEFGH')).toBe('ABCD-EFGH');
  });

  it.each([
    ['ABCD-EFGH', 'ABCDEFGH'],
    ['abcd-efgh', 'ABCDEFGH'],
    [' ABCD EFGH ', 'ABCDEFGH'],
    ['abcdefgh', 'ABCDEFGH'],
  ])('forgives case, spaces and hyphens in %j', (raw, normalized) => {
    expect(normalizeStaffLinkCode(raw)).toBe(normalized);
  });

  it.each(['ABCD-EFG', 'ABCD-EFGHJ', 'ABCD_EFGH', 'ABCD-EFG1', 'OBCD-EFGH', '', 'digest:abc'])(
    'refuses %j as a code',
    (raw) => {
      expect(normalizeStaffLinkCode(raw)).toBeNull();
    },
  );
});

describe('staffLinkCommandOf (the worker side)', () => {
  it('reads the digest form, with or without the bot named, in any chat', () => {
    expect(staffLinkCommandOf(message(`/link digest:${DIGEST}`))).toEqual({ mention: null, digest: DIGEST });
    expect(staffLinkCommandOf(message(`/link@cashier_bot digest:${DIGEST}`, 'supergroup'))).toEqual({
      mention: 'cashier_bot',
      digest: DIGEST,
    });
  });

  it('treats a raw code as no code: only the webhook may produce what links', () => {
    expect(staffLinkCommandOf(message('/link ABCD-EFGH'))).toEqual({ mention: null, digest: null });
  });

  it('reads a bare /link as a command with no code', () => {
    expect(staffLinkCommandOf(message('/link'))).toEqual({ mention: null, digest: null });
  });

  it.each(['/linked ABCD-EFGH', '/start ABCD-EFGH', 'link ABCD-EFGH', 'hello /link ABCD-EFGH'])(
    'is not fooled by %j',
    (text) => {
      expect(staffLinkCommandOf(message(text))).toBeNull();
    },
  );

  it('ignores a message with no text and a missing message', () => {
    expect(staffLinkCommandOf({ chat: { id: 1, type: 'private' } } as unknown as Message)).toBeNull();
    expect(staffLinkCommandOf(undefined)).toBeNull();
  });
});

describe('redactStaffLinkCode (the webhook side)', () => {
  it('replaces the code with the digest of the normalized code, keeping the command and the bot', () => {
    const original = updateOf('/link@cashier_bot abcd-efgh');
    const redacted = redactStaffLinkCode(original, fakeDigest);

    expect(redacted.message?.text).toBe(`/link@cashier_bot digest:${fakeDigest('ABCDEFGH')}`);
    expect(JSON.stringify(redacted)).not.toMatch(/abcd-efgh|ABCD-EFGH/i);
    expect(redacted.message?.entities).toEqual(original.message?.entities);
    // The original body is untouched.
    expect(original.message?.text).toBe('/link@cashier_bot abcd-efgh');
  });

  it.each([
    ['/link ABCD-EFGH' + ' '.repeat(300)],
    ['/link\nABCD-EFGH'],
    ['/link   ab cd - ef gh  \n'],
  ])('redacts a code however it is spaced or wrapped: %j', (text) => {
    const redacted = redactStaffLinkCode(updateOf(text), fakeDigest);
    expect(redacted.message?.text).toBe(`/link digest:${fakeDigest('ABCDEFGH')}`);
  });

  it('redacts in a group too, where a code must be voided and must not be stored either', () => {
    expect(redactStaffLinkCode(updateOf('/link ABCD-EFGH', 'group'), fakeDigest).message?.text).toBe(
      `/link digest:${fakeDigest('ABCDEFGH')}`,
    );
  });

  it('neutralises a typed digest, so nobody can link with a digest read from the database', () => {
    const redacted = redactStaffLinkCode(updateOf(`/link digest:${DIGEST}`), fakeDigest);
    expect(redacted.message?.text).toBe('/link [not-a-link-code]');
    expect(staffLinkCommandOf(redacted.message)).toEqual({ mention: null, digest: null });
  });

  it('returns the same object for everything else', () => {
    for (const text of ['/link', '/link not a code', '/start ABCD-EFGH', 'ABCD-EFGH']) {
      const update = updateOf(text);
      expect(redactStaffLinkCode(update, fakeDigest)).toBe(update);
    }
    const callback = { update_id: 1, callback_query: { id: 'x' } } as unknown as Update;
    expect(redactStaffLinkCode(callback, fakeDigest)).toBe(callback);
  });

  it('what it produces is what the worker reads', () => {
    const redacted = redactStaffLinkCode(updateOf('/link ABCD-EFGH'), () => DIGEST);
    expect(staffLinkCommandOf(redacted.message)).toEqual({ mention: null, digest: DIGEST });
  });

  describe('in an edited message (a typo fixed in place)', () => {
    const editedOf = (text: string, chatType = 'private'): Update =>
      ({ update_id: 8, edited_message: { ...message(text, chatType), edit_date: 1 } }) as unknown as Update;

    it('replaces the code with the digest, exactly as in a sent message', () => {
      const original = editedOf('/link@cashier_bot abcd-efgh');
      const redacted = redactStaffLinkCode(original, fakeDigest);

      expect(redacted.edited_message?.text).toBe(`/link@cashier_bot digest:${fakeDigest('ABCDEFGH')}`);
      // Hyphen required: fakeDigest embeds the normalized code on purpose, so the digest itself holds "abcdefgh".
      expect(JSON.stringify(redacted)).not.toMatch(/abcd-efgh/i);
      expect(redacted.edited_message?.edit_date).toBe(1);
      expect(redacted.message).toBeUndefined();
      expect(original.edited_message?.text).toBe('/link@cashier_bot abcd-efgh');
    });

    it('redacts a code edited into a group message too', () => {
      const redacted = redactStaffLinkCode(editedOf('/link ABCD EFGH', 'supergroup'), fakeDigest);
      expect(redacted.edited_message?.text).toBe(`/link digest:${fakeDigest('ABCDEFGH')}`);
    });

    it('neutralises a typed digest in an edit', () => {
      const redacted = redactStaffLinkCode(editedOf(`/link digest:${DIGEST}`), fakeDigest);
      expect(redacted.edited_message?.text).toBe('/link [not-a-link-code]');
    });

    it('returns an edit with no code, and a malformed body, as the same object', () => {
      for (const text of ['/link', '/link ABCD-EFG', 'ABCD-EFGH']) {
        const update = editedOf(text);
        expect(redactStaffLinkCode(update, fakeDigest)).toBe(update);
      }
      expect(redactStaffLinkCode(null as unknown as Update, fakeDigest)).toBeNull();
      const malformed = { update_id: 1, edited_message: 'not an object' } as unknown as Update;
      expect(redactStaffLinkCode(malformed, fakeDigest)).toBe(malformed);
    });

    it('is recognised as a /link update, so a SUSPENDED operator keeps it to answer', () => {
      expect(isStaffLinkUpdate(editedOf('/link ABCD-EFGH'))).toBe(true);
      expect(isStaffLinkUpdate(editedOf('hello'))).toBe(false);
    });
  });
});

describe('isStaffLinkUpdate', () => {
  it('recognises /link in any chat and nothing else', () => {
    expect(isStaffLinkUpdate(updateOf('/link ABCD-EFGH'))).toBe(true);
    expect(isStaffLinkUpdate(updateOf('/link', 'supergroup'))).toBe(true);
    expect(isStaffLinkUpdate(updateOf('/start'))).toBe(false);
    expect(isStaffLinkUpdate({ update_id: 1 })).toBe(false);
    expect(isStaffLinkUpdate(undefined)).toBe(false);
  });
});
