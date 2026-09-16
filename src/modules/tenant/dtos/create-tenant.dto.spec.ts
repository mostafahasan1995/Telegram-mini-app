/**
 * Through a ValidationPipe built with the SAME options main.ts installs, because a DTO that validates
 * under different options is a different contract. What reaches `details.fields` is the array this
 * pipe throws.
 */
import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { CreateTenantDto } from './create-tenant.dto';
import { ReplaceTenantBotDto } from './replace-tenant-bot.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
});

const TOKEN = '123456789:AAbbccddeeffgghhiijjkkllmmnnooppqq';

const fourFields = (): Record<string, unknown> => ({
  displayName: 'Northern branch',
  botToken: TOKEN,
  ichancyUsername: 'agent_north',
  ichancyPassword: ' a password with spaces ',
});

async function validate(
  metatype: typeof CreateTenantDto | typeof ReplaceTenantBotDto,
  body: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; fields: string[] }> {
  try {
    return { ok: true, value: await pipe.transform(body, { type: 'body', metatype }) };
  } catch (error: unknown) {
    if (!(error instanceof BadRequestException)) throw error;
    const response = error.getResponse() as { message?: unknown };
    const fields = Array.isArray(response.message)
      ? response.message.filter((entry): entry is string => typeof entry === 'string')
      : [];
    return { ok: false, fields };
  }
}

async function refused(body: unknown): Promise<string[]> {
  const outcome = await validate(CreateTenantDto, body);
  if (outcome.ok) throw new Error(`expected ${JSON.stringify(body)} to be refused`);
  return outcome.fields;
}

describe('CreateTenantDto', () => {
  it('accepts the four required fields alone, trimming everything but the password', async () => {
    const outcome = await validate(CreateTenantDto, {
      ...fourFields(),
      displayName: '  Northern branch ',
      botToken: ` ${TOKEN}\n`,
    });
    expect(outcome).toEqual({
      ok: true,
      value: expect.objectContaining({
        displayName: 'Northern branch',
        botToken: TOKEN,
        ichancyPassword: ' a password with spaces ',
      }),
    });
  });

  it('accepts every advanced field the console form sends, upper-casing the currency', async () => {
    const outcome = await validate(CreateTenantDto, {
      ...fourFields(),
      slug: 'northern-branch',
      adminChatId: '-1001234567890',
      feedChatId: '-1009876543210',
      ichancyBaseUrl: 'https://agents.ichancy.com',
      ichancyAgentId: '10045',
      currencyCode: 'nsp',
      dualApprovalThresholdMinor: '50000000',
      agentFloatLowWatermarkMinor: '100000000',
      depositExpiryMinutes: 30,
      depositMode: 'AUTO',
      withdrawalMode: 'MANUAL',
      miniAppUrl: 'https://app.example/north',
    });
    expect(outcome.ok && outcome.value).toMatchObject({ currencyCode: 'NSP', slug: 'northern-branch' });
  });

  it('names each missing required field', async () => {
    const fields = await refused({});
    for (const name of ['displayName', 'botToken', 'ichancyUsername', 'ichancyPassword']) {
      expect(fields.some((message) => message.startsWith(name))).toBe(true);
    }
  });

  it('refuses a token that is not shaped like a BotFather token, in the mock’s words', async () => {
    expect(await refused({ ...fourFields(), botToken: '12345:short' })).toEqual([
      'botToken must look like 123456789:AA... — the token BotFather gave you',
    ]);
  });

  it('refuses an optional field sent as "" or null instead of being left out', async () => {
    const optional = [
      'slug',
      'adminChatId',
      'feedChatId',
      'ichancyBaseUrl',
      'ichancyAgentId',
      'currencyCode',
      'dualApprovalThresholdMinor',
      'agentFloatLowWatermarkMinor',
    ];
    for (const field of optional) {
      for (const empty of ['', null]) {
        const fields = await refused({ ...fourFields(), [field]: empty });
        expect(fields.length).toBeGreaterThan(0);
        for (const message of fields) expect(message.startsWith(field)).toBe(true);
      }
    }
    // miniAppUrl is the one documented null.
    expect((await validate(CreateTenantDto, { ...fourFields(), miniAppUrl: null })).ok).toBe(true);
  });

  it('refuses a slug outside the console’s rule, an unknown field and an out-of-range expiry', async () => {
    expect((await refused({ ...fourFields(), slug: '9-lives' }))[0]).toMatch(/^slug must be/);
    expect((await refused({ ...fourFields(), slug: 'Upper' }))[0]).toMatch(/^slug must be/);
    expect(await refused({ ...fourFields(), status: 'ACTIVE' })).toEqual([
      'property status should not exist',
    ]);
    expect((await refused({ ...fourFields(), depositExpiryMinutes: 2 }))[0]).toMatch(
      /^depositExpiryMinutes/,
    );
    expect((await refused({ ...fourFields(), adminChatId: 123 }))[0]).toMatch(/^adminChatId/);
  });
});

describe('ReplaceTenantBotDto', () => {
  it('accepts a trimmed BotFather token and refuses anything else by name', async () => {
    expect(await validate(ReplaceTenantBotDto, { botToken: ` ${TOKEN} ` })).toEqual({
      ok: true,
      value: expect.objectContaining({ botToken: TOKEN }),
    });
    const outcome = await validate(ReplaceTenantBotDto, { botToken: 'nope' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.fields[0]).toMatch(/^botToken must look like/);
  });
});
