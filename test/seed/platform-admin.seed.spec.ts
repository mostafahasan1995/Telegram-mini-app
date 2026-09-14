/**
 * The platform-admin seed's decisions, without a database: what input is refused and how, and what
 * a run does to each shape of existing row. The database-level behaviour (the real transaction, the
 * audit row, signing in afterwards) is platform-admin.seed.int.spec.ts.
 */
import { AdminRole, type PrismaClient } from '@prisma/client';

import {
  DEFAULT_PLATFORM_ADMIN_DISPLAY_NAME,
  PlatformAdminSeedError,
  describeSeedFailure,
  planPlatformAdmin,
  readPlatformAdminInput,
  seedPlatformAdmin,
  type ExistingAdminRow,
  type PlatformAdminInput,
} from '../../prisma/seed/platform-admin.seed';

const PASSWORD = 'Correct Horse 9';

const env = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  SEED_PLATFORM_ADMIN_USERNAME: 'owner',
  SEED_PLATFORM_ADMIN_PASSWORD: PASSWORD,
  ...overrides,
});

/** Runs the reader and returns the refusal, failing the test if there was none. */
function refusal(values: NodeJS.ProcessEnv): PlatformAdminSeedError {
  try {
    readPlatformAdminInput(values);
  } catch (error: unknown) {
    if (error instanceof PlatformAdminSeedError) return error;
    throw error;
  }
  throw new Error('expected the input to be refused');
}

describe('readPlatformAdminInput', () => {
  it('normalises the username and keeps the password exactly as given', () => {
    const input = readPlatformAdminInput(
      env({
        SEED_PLATFORM_ADMIN_USERNAME: '  Owner.Name+ops@Example ',
        SEED_PLATFORM_ADMIN_PASSWORD: '  spaced  ',
      }),
    );

    expect(input).toEqual({
      username: 'owner.name+ops@example',
      password: '  spaced  ',
      displayName: null,
      telegramUserId: null,
      resetPassword: false,
    });
  });

  it('requires both the username and the password, and names both at once', () => {
    const error = refusal({});
    expect(error.message).toContain('SEED_PLATFORM_ADMIN_USERNAME is required');
    expect(error.message).toContain('SEED_PLATFORM_ADMIN_PASSWORD is required');

    expect(refusal(env({ SEED_PLATFORM_ADMIN_USERNAME: '   ' })).message).toContain(
      'SEED_PLATFORM_ADMIN_USERNAME is required',
    );
  });

  it.each([
    ['too short', 'ab'],
    ['too long', 'a'.repeat(65)],
    ['a space inside', 'own er'],
    ['a character outside the rule', 'owner!'],
    ['non-ASCII letters', 'ownér'],
  ])('refuses a username with %s', (_label, username) => {
    expect(refusal(env({ SEED_PLATFORM_ADMIN_USERNAME: username })).message).toContain(
      'SEED_PLATFORM_ADMIN_USERNAME must be 3 to 64 characters',
    );
  });

  it('accepts usernames at both length bounds', () => {
    expect(readPlatformAdminInput(env({ SEED_PLATFORM_ADMIN_USERNAME: 'abc' })).username).toBe(
      'abc',
    );
    const longest = 'a'.repeat(64);
    expect(readPlatformAdminInput(env({ SEED_PLATFORM_ADMIN_USERNAME: longest })).username).toBe(
      longest,
    );
  });

  it('bounds the password at 8 to 72 characters as a person counts them, never echoing it', () => {
    const short = 'Sh0rt!x';
    const error = refusal(env({ SEED_PLATFORM_ADMIN_PASSWORD: short }));
    expect(error.message).toContain('SEED_PLATFORM_ADMIN_PASSWORD must be 8 to 72 characters');
    expect(error.message).not.toContain(short);

    expect(refusal(env({ SEED_PLATFORM_ADMIN_PASSWORD: 'x'.repeat(73) })).message).toContain(
      'must be 8 to 72 characters',
    );
    // 72 code points that are two UTF-16 units each: accepted, because a person counts 72.
    const emoji = '\u{1F512}'.repeat(72);
    expect(readPlatformAdminInput(env({ SEED_PLATFORM_ADMIN_PASSWORD: emoji })).password).toBe(
      emoji,
    );
    // Eight spaces is eight characters: never trimmed, so never shortened below the bound.
    expect(
      readPlatformAdminInput(env({ SEED_PLATFORM_ADMIN_PASSWORD: ' '.repeat(8) })).password,
    ).toBe(' '.repeat(8));
  });

  it('reads an optional display name, trimmed, and treats a blank one as not given', () => {
    expect(readPlatformAdminInput(env({ SEED_ADMIN_DISPLAY_NAME: '  Nadia  ' })).displayName).toBe(
      'Nadia',
    );
    expect(readPlatformAdminInput(env({ SEED_ADMIN_DISPLAY_NAME: '   ' })).displayName).toBeNull();
    expect(refusal(env({ SEED_ADMIN_DISPLAY_NAME: 'n'.repeat(121) })).message).toContain(
      'SEED_ADMIN_DISPLAY_NAME must be at most 120 characters',
    );
  });

  it('reads an optional Telegram id as digits only', () => {
    expect(
      readPlatformAdminInput(env({ SEED_ADMIN_TELEGRAM_ID: ' 123456789 ' })).telegramUserId,
    ).toBe(123_456_789n);
    expect(readPlatformAdminInput(env({ SEED_ADMIN_TELEGRAM_ID: '' })).telegramUserId).toBeNull();
    expect(
      readPlatformAdminInput(env({ SEED_ADMIN_TELEGRAM_ID: '9223372036854775807' })).telegramUserId,
    ).toBe(9_223_372_036_854_775_807n);

    for (const bad of ['-5', '12a', '1 2', '0', '9223372036854775808', '1'.repeat(20)]) {
      expect(refusal(env({ SEED_ADMIN_TELEGRAM_ID: bad })).message).toContain(
        'SEED_ADMIN_TELEGRAM_ID must be a positive Telegram user id, digits only',
      );
    }
  });

  it('turns the reset flag on only for 1 or true, and refuses anything unrecognised', () => {
    for (const on of ['1', 'true', 'TRUE']) {
      expect(
        readPlatformAdminInput(env({ SEED_PLATFORM_ADMIN_RESET_PASSWORD: on })).resetPassword,
      ).toBe(true);
    }
    for (const off of [undefined, '', '0', 'false']) {
      expect(
        readPlatformAdminInput(env({ SEED_PLATFORM_ADMIN_RESET_PASSWORD: off })).resetPassword,
      ).toBe(false);
    }
    expect(refusal(env({ SEED_PLATFORM_ADMIN_RESET_PASSWORD: 'yes' })).message).toContain(
      'SEED_PLATFORM_ADMIN_RESET_PASSWORD must be 1 or 0',
    );
  });

  it('never reads a TELEGRAM_* or JWT_SECRET variable', () => {
    const accessed: string[] = [];
    const tracked = new Proxy(env(), {
      get(target, key: string) {
        accessed.push(key);
        return target[key];
      },
    });
    readPlatformAdminInput(tracked);
    expect(accessed.filter((key) => key.startsWith('TELEGRAM_') || key === 'JWT_SECRET')).toEqual(
      [],
    );
  });
});

describe('planPlatformAdmin', () => {
  const input = (overrides: Partial<PlatformAdminInput> = {}): PlatformAdminInput => ({
    username: 'owner',
    password: PASSWORD,
    displayName: null,
    telegramUserId: null,
    resetPassword: false,
    ...overrides,
  });

  const row = (overrides: Partial<ExistingAdminRow> = {}): ExistingAdminRow => ({
    id: 'admin-1',
    username: 'owner',
    role: AdminRole.PLATFORM_ADMIN,
    isActive: true,
    displayName: 'Owner',
    telegramUserId: null,
    passwordHash: '$scrypt$ln=15,r=8,p=3$c2FsdA$a2V5',
    ...overrides,
  });

  const none = { byUsername: null, byTelegramUserId: null };

  it('creates the admin when nothing holds the username, with the default display name', () => {
    expect(planPlatformAdmin(input(), none)).toEqual({
      outcome: 'created',
      displayName: DEFAULT_PLATFORM_ADMIN_DISPLAY_NAME,
      telegramUserId: null,
    });
    expect(planPlatformAdmin(input({ displayName: 'Nadia', telegramUserId: 42n }), none)).toEqual({
      outcome: 'created',
      displayName: 'Nadia',
      telegramUserId: 42n,
    });
  });

  it('leaves an active platform admin that already has a password unchanged', () => {
    const existing = row();
    expect(planPlatformAdmin(input(), { byUsername: existing, byTelegramUserId: null })).toEqual({
      outcome: 'unchanged',
      existing,
    });
  });

  it('does not treat the (always present) password as a request to change it', () => {
    const plan = planPlatformAdmin(input({ password: 'a different one' }), {
      byUsername: row(),
      byTelegramUserId: null,
    });
    expect(plan.outcome).toBe('unchanged');
  });

  it('replaces the password only with the reset flag', () => {
    expect(
      planPlatformAdmin(input({ resetPassword: true }), {
        byUsername: row(),
        byTelegramUserId: null,
      }),
    ).toMatchObject({ outcome: 'updated', changes: {}, setPassword: true });
  });

  it('sets a password on a row that has none, since there is nothing to preserve', () => {
    expect(
      planPlatformAdmin(input(), {
        byUsername: row({ passwordHash: null }),
        byTelegramUserId: null,
      }),
    ).toMatchObject({ outcome: 'updated', changes: {}, setPassword: true });
  });

  it('re-arms a deactivated platform admin without touching the password', () => {
    expect(
      planPlatformAdmin(input(), { byUsername: row({ isActive: false }), byTelegramUserId: null }),
    ).toMatchObject({ outcome: 'updated', changes: { isActive: true }, setPassword: false });
  });

  it('applies a display name or Telegram id only when one is given and differs', () => {
    const existing = row({ displayName: 'Owner', telegramUserId: 7n });

    expect(
      planPlatformAdmin(input({ displayName: 'Owner', telegramUserId: 7n }), {
        byUsername: existing,
        byTelegramUserId: existing,
      }).outcome,
    ).toBe('unchanged');

    expect(
      planPlatformAdmin(input({ displayName: 'Nadia' }), {
        byUsername: existing,
        byTelegramUserId: null,
      }),
    ).toMatchObject({ outcome: 'updated', changes: { displayName: 'Nadia' }, setPassword: false });

    expect(
      planPlatformAdmin(input({ telegramUserId: 8n }), {
        byUsername: existing,
        byTelegramUserId: null,
      }),
    ).toMatchObject({ outcome: 'updated', changes: { telegramUserId: 8n }, setPassword: false });
  });

  it.each([AdminRole.SUPER_ADMIN, AdminRole.SUPPORT, AdminRole.VIEWER])(
    'refuses a username held by a %s in tenant zero rather than promoting it',
    (role) => {
      const attempt = (): unknown =>
        planPlatformAdmin(input(), { byUsername: row({ role }), byTelegramUserId: null });
      expect(attempt).toThrow(PlatformAdminSeedError);
      expect(attempt).toThrow(`already belongs to a ${role} in tenant zero`);
      expect(attempt).not.toThrow(PASSWORD);
    },
  );

  it('refuses a Telegram id that belongs to a different admin than the username', () => {
    expect(() =>
      planPlatformAdmin(input({ telegramUserId: 9n }), {
        byUsername: row(),
        byTelegramUserId: row({ id: 'admin-2', username: 'someone', telegramUserId: 9n }),
      }),
    ).toThrow('SEED_ADMIN_TELEGRAM_ID already belongs to another admin in tenant zero');
  });

  it('adopts a Telegram-id-only platform admin instead of colliding with it', () => {
    const legacy = row({ username: null, telegramUserId: 9n, passwordHash: null });
    expect(
      planPlatformAdmin(input({ telegramUserId: 9n }), {
        byUsername: null,
        byTelegramUserId: legacy,
      }),
    ).toEqual({
      outcome: 'updated',
      existing: legacy,
      changes: { username: 'owner' },
      setPassword: true,
    });
  });

  it('refuses to adopt a Telegram id held by a named login or by another role', () => {
    for (const holder of [
      row({ username: 'someone', telegramUserId: 9n }),
      row({ username: null, telegramUserId: 9n, role: AdminRole.SUPER_ADMIN }),
    ]) {
      expect(() =>
        planPlatformAdmin(input({ telegramUserId: 9n }), {
          byUsername: null,
          byTelegramUserId: holder,
        }),
      ).toThrow(PlatformAdminSeedError);
    }
  });
});

describe('seedPlatformAdmin', () => {
  it('refuses to run before the migrations have created tenant zero', async () => {
    const prisma = {
      tenant: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(),
    } as unknown as PrismaClient;
    const hasher = { hash: jest.fn() };

    await expect(seedPlatformAdmin(prisma, readPlatformAdminInput(env()), hasher)).rejects.toThrow(
      'Tenant zero does not exist',
    );
    expect(hasher.hash).not.toHaveBeenCalled();
  });
});

describe('describeSeedFailure', () => {
  it('cuts the password and anything shaped like a stored hash out of an unexpected error', () => {
    const error = new Error(
      `insert failed: data { passwordHash: "$scrypt$ln=15,r=8,p=3$abc$def", note: "${PASSWORD}" }`,
    );
    const message = describeSeedFailure(error, [PASSWORD]);

    expect(message).toContain('Error: insert failed');
    expect(message).not.toContain(PASSWORD);
    expect(message).not.toContain('$scrypt$');
    expect(message).toContain('[redacted]');
  });

  it('describes a non-Error throw without crashing', () => {
    expect(describeSeedFailure('boom', [''])).toBe('non-error thrown: boom');
  });
});
