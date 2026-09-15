/**
 * The pure rules behind the chat directory and staff-group binding: what the bot's membership means
 * (canPost in particular, which is NOT `can_post_messages` in a group), which updates a stopped
 * operator keeps, and the shape of a bind link and its command.
 */
import { TelegramBotChatStatus, TelegramChatType } from '@prisma/client';
import { GrammyError } from 'grammy';
import type { ChatMember, Message, Update } from 'grammy/types';

import {
  BIND_NONCE_PATTERN,
  bindCommandOf,
  boundChatOf,
  chatTypeOf,
  hashBindNonce,
  isChatProjectionUpdate,
  membershipFacts,
  migratedChatIdOf,
  newBindNonce,
  numericChatId,
  redactBindNonce,
  startGroupUrl,
} from './chat-membership.util';

const BOT = { id: 1, is_bot: true, first_name: 'Bot' };
const NONCE = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';

const member = (fields: Record<string, unknown>): ChatMember =>
  ({ user: BOT, ...fields }) as unknown as ChatMember;

const groupMessage = (text: string, type = 'supergroup'): Message =>
  ({
    message_id: 1,
    date: 1,
    chat: { id: -100123, type, title: 'Staff' },
    text,
  }) as unknown as Message;

describe('membershipFacts', () => {
  it('says a group administrator can post, although can_post_messages is for channels only', () => {
    expect(membershipFacts(TelegramChatType.SUPERGROUP, member({ status: 'administrator' }))).toEqual({
      status: TelegramBotChatStatus.ADMINISTRATOR,
      isAdministrator: true,
      isPresent: true,
      canPost: true,
    });
  });

  it('lets a plain group member post, and not a restricted one without can_send_messages', () => {
    expect(membershipFacts(TelegramChatType.GROUP, member({ status: 'member' }))).toMatchObject({
      isAdministrator: false,
      isPresent: true,
      canPost: true,
    });
    expect(
      membershipFacts(
        TelegramChatType.GROUP,
        member({ status: 'restricted', is_member: true, can_send_messages: false }),
      ),
    ).toMatchObject({ status: 'RESTRICTED', isPresent: true, canPost: false });
    expect(
      membershipFacts(
        TelegramChatType.GROUP,
        member({ status: 'restricted', is_member: false, can_send_messages: true }),
      ),
    ).toMatchObject({ isPresent: false, canPost: false });
  });

  it('marks a bot that left or was removed as not present and unable to post', () => {
    for (const status of ['left', 'kicked'] as const) {
      expect(membershipFacts(TelegramChatType.SUPERGROUP, member({ status }))).toMatchObject({
        status: status === 'left' ? 'LEFT' : 'KICKED',
        isPresent: false,
        isAdministrator: false,
        canPost: false,
      });
    }
  });

  it('in a channel, requires the creator or an administrator with can_post_messages', () => {
    const admin = (canPost?: boolean) =>
      membershipFacts(
        TelegramChatType.CHANNEL,
        member({ status: 'administrator', ...(canPost === undefined ? {} : { can_post_messages: canPost }) }),
      ).canPost;
    expect(admin()).toBe(false);
    expect(admin(false)).toBe(false);
    expect(admin(true)).toBe(true);
    expect(membershipFacts(TelegramChatType.CHANNEL, member({ status: 'creator' })).canPost).toBe(true);
    expect(membershipFacts(TelegramChatType.CHANNEL, member({ status: 'member' })).canPost).toBe(false);
  });
});

describe('chatTypeOf and boundChatOf', () => {
  it('records groups, supergroups and channels, and never a private chat', () => {
    expect(chatTypeOf('group')).toBe('GROUP');
    expect(chatTypeOf('supergroup')).toBe('SUPERGROUP');
    expect(chatTypeOf('channel')).toBe('CHANNEL');
    expect(chatTypeOf('private')).toBeNull();
  });

  it('reads the stored 0 as "no group bound"', () => {
    expect(boundChatOf(0n)).toBeNull();
    expect(boundChatOf(null)).toBeNull();
    expect(boundChatOf(-1001n)).toBe(-1001n);
  });
});

describe('bind links', () => {
  it('mints 32-character URL-safe nonces and stores only a sha256 of them', () => {
    const first = newBindNonce();
    const second = newBindNonce();
    expect(first).toMatch(BIND_NONCE_PATTERN);
    expect(first).not.toBe(second);

    const hash = hashBindNonce(first);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashBindNonce(first)).toBe(hash);
    expect(hash).not.toContain(first);
  });

  it('builds the startgroup link with the admin rights in Telegram’s + syntax', () => {
    expect(startGroupUrl('cashier_bot', NONCE)).toBe(
      `https://t.me/cashier_bot?startgroup=${NONCE}&admin=post_messages+delete_messages+pin_messages+manage_chat`,
    );
  });

  it('reads the bind command only in a group, only with a nonce-shaped payload, and hands on only its hash', () => {
    expect(bindCommandOf(groupMessage(`/start@cashier_bot ${NONCE}`))).toEqual({
      mention: 'cashier_bot',
      nonceHash: hashBindNonce(NONCE),
    });
    expect(bindCommandOf(groupMessage(`/start ${NONCE}`, 'group'))).toEqual({
      mention: null,
      nonceHash: hashBindNonce(NONCE),
    });
    // The redacted form the webhook stores reads back to the same hash.
    expect(bindCommandOf(groupMessage(`/start@cashier_bot sha256:${hashBindNonce(NONCE)}`))).toEqual({
      mention: 'cashier_bot',
      nonceHash: hashBindNonce(NONCE),
    });
    expect(bindCommandOf(groupMessage('/start sha256:not-hex'))).toBeNull();
    expect(bindCommandOf(groupMessage(`/start ${NONCE}`, 'private'))).toBeNull();
    expect(bindCommandOf(groupMessage(`/start ${NONCE}`, 'channel'))).toBeNull();
    expect(bindCommandOf(groupMessage('/start ref_12345'))).toBeNull();
    expect(bindCommandOf(groupMessage(`/start ${NONCE} extra`))).toBeNull();
    expect(bindCommandOf(groupMessage(`/help ${NONCE}`))).toBeNull();
    expect(bindCommandOf(undefined)).toBeNull();
  });
});

describe('redactBindNonce', () => {
  const inGroup = (text: string, type = 'supergroup'): Update =>
    ({ update_id: 9, message: groupMessage(text, type) }) as unknown as Update;
  const textOf = (update: Update): string | undefined => update.message?.text;

  it('replaces the nonce with its hash, keeping the command and its entity offsets', () => {
    const original = inGroup(`/start@cashier_bot ${NONCE}`);
    const redacted = redactBindNonce(original);

    expect(textOf(redacted)).toBe(`/start@cashier_bot sha256:${hashBindNonce(NONCE)}`);
    expect(JSON.stringify(redacted)).not.toContain(NONCE);
    // The argument is untouched, and the stored form still binds the same link.
    expect(textOf(original)).toBe(`/start@cashier_bot ${NONCE}`);
    expect(bindCommandOf(redacted.message)).toEqual({
      mention: 'cashier_bot',
      nonceHash: hashBindNonce(NONCE),
    });
    expect(isChatProjectionUpdate(redacted)).toBe(true);
  });

  it('neutralises a hash somebody typed, so a hash read from the database never binds', () => {
    const typed = redactBindNonce(inGroup(`/start@cashier_bot sha256:${hashBindNonce(NONCE)}`));

    expect(bindCommandOf(typed.message)).toBeNull();
    expect(isChatProjectionUpdate(typed)).toBe(false);
  });

  it('redacts a nonce typed into an edited group message too, which never binds', () => {
    const original = {
      update_id: 10,
      edited_message: { ...groupMessage(`/start@cashier_bot ${NONCE}`), edit_date: 2 },
    } as unknown as Update;
    const redacted = redactBindNonce(original);

    expect(redacted.edited_message?.text).toBe(`/start@cashier_bot sha256:${hashBindNonce(NONCE)}`);
    expect(JSON.stringify(redacted)).not.toContain(NONCE);
    expect(original.edited_message?.text).toBe(`/start@cashier_bot ${NONCE}`);
    // Only a sent message is a bind command or a projection update.
    expect(isChatProjectionUpdate(redacted)).toBe(false);
  });

  it('returns every other update as the same object, a malformed body included', () => {
    const plain = inGroup('hello');
    const referral = inGroup('/start ref_12345');
    const privateStart = inGroup(`/start ${NONCE}`, 'private');
    expect(redactBindNonce(plain)).toBe(plain);
    expect(redactBindNonce(referral)).toBe(referral);
    expect(redactBindNonce(privateStart)).toBe(privateStart);
    expect(redactBindNonce(null as unknown as Update)).toBeNull();
    const malformed = { update_id: 1, message: 'not an object' } as unknown as Update;
    expect(redactBindNonce(malformed)).toBe(malformed);
  });
});

describe('isChatProjectionUpdate', () => {
  const membershipIn = (type: string): Update =>
    ({
      update_id: 1,
      my_chat_member: {
        chat: { id: type === 'private' ? 5 : -100, type, title: 'G', first_name: 'P' },
        from: { id: 5, is_bot: false, first_name: 'P' },
        date: 1,
        old_chat_member: member({ status: 'left' }),
        new_chat_member: member({ status: 'member' }),
      },
    }) as unknown as Update;

  it('keeps group and channel membership, supergroup moves and bind commands', () => {
    expect(isChatProjectionUpdate(membershipIn('supergroup'))).toBe(true);
    expect(isChatProjectionUpdate(membershipIn('channel'))).toBe(true);
    expect(
      isChatProjectionUpdate({ update_id: 1, message: { ...groupMessage(''), migrate_to_chat_id: -1009 } } as Update),
    ).toBe(true);
    expect(
      isChatProjectionUpdate({ update_id: 1, message: { ...groupMessage(''), migrate_from_chat_id: -9 } } as Update),
    ).toBe(true);
    expect(
      isChatProjectionUpdate({ update_id: 1, message: groupMessage(`/start@b ${NONCE}`) } as Update),
    ).toBe(true);
  });

  it('keeps nothing else: a private block, a plain message, a button, a malformed body', () => {
    expect(isChatProjectionUpdate(membershipIn('private'))).toBe(false);
    expect(isChatProjectionUpdate({ update_id: 1, message: groupMessage('hello') } as Update)).toBe(false);
    expect(
      isChatProjectionUpdate({
        update_id: 1,
        callback_query: { id: 'x', from: BOT, chat_instance: 'c', data: 'dep:approve:1' },
      }),
    ).toBe(false);
    expect(isChatProjectionUpdate(undefined)).toBe(false);
  });
});

describe('supergroup migration', () => {
  const grammyError = (parameters: Record<string, unknown>): GrammyError =>
    new GrammyError(
      'failed',
      { ok: false, error_code: 400, description: 'Bad Request: group chat was upgraded', parameters },
      'sendMessage',
      {},
    );

  it('reads migrate_to_chat_id off a Telegram error, and nothing off anything else', () => {
    expect(migratedChatIdOf(grammyError({ migrate_to_chat_id: -1001234567890 }))).toBe(-1001234567890n);
    expect(migratedChatIdOf(grammyError({ retry_after: 3 }))).toBeNull();
    expect(migratedChatIdOf(new Error('boom'))).toBeNull();
  });

  it('only follows numeric chat ids', () => {
    expect(numericChatId(-100n)).toBe(-100n);
    expect(numericChatId(-100)).toBe(-100n);
    expect(numericChatId('-1001234567890')).toBe(-1001234567890n);
    expect(numericChatId('@public_group')).toBeNull();
  });
});
