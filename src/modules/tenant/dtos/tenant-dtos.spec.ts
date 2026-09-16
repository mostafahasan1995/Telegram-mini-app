/**
 * Through a ValidationPipe built with the SAME options main.ts installs (whitelist,
 * forbidNonWhitelisted, transform, no implicit conversion), because a DTO that validates under
 * different options is a different contract. What reaches `details.fields` is the array this pipe
 * throws, so the assertions read those messages.
 */
import { BadRequestException, ValidationPipe, type Type } from '@nestjs/common';

import { UpdatePlatformDefaultsDto } from './update-platform-defaults.dto';
import { UpdateTenantDto } from './update-tenant.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
});

type Outcome<T> = { ok: true; value: T } | { ok: false; fields: string[] };

async function run<T>(metatype: Type<T>, body: unknown): Promise<Outcome<T>> {
  try {
    const value = (await pipe.transform(body, { type: 'body', metatype })) as T;
    return { ok: true, value };
  } catch (error: unknown) {
    if (!(error instanceof BadRequestException)) throw error;
    const response = error.getResponse() as { message?: unknown };
    const fields = Array.isArray(response.message)
      ? response.message.filter((entry): entry is string => typeof entry === 'string')
      : [];
    return { ok: false, fields };
  }
}

async function refusedFields<T>(metatype: Type<T>, body: unknown): Promise<string[]> {
  const outcome = await run(metatype, body);
  if (outcome.ok) throw new Error(`expected ${JSON.stringify(body)} to be refused`);
  return outcome.fields;
}

describe('UpdateTenantDto', () => {
  it('accepts exactly what the console edit form sends, trimmed', async () => {
    const outcome = await run(UpdateTenantDto, {
      displayName: '  Northern branch ',
      adminChatId: ' -1001234567890',
      feedChatId: '-1009876543210',
      dualApprovalThresholdMinor: '50000000',
      agentFloatLowWatermarkMinor: '100000000',
      depositExpiryMinutes: 30,
      depositMode: 'AUTO',
      withdrawalMode: 'MANUAL',
      miniAppUrl: 'https://cashier.example.app',
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toMatchObject({
      displayName: 'Northern branch',
      adminChatId: '-1001234567890',
      depositExpiryMinutes: 30,
    });
  });

  it('accepts an empty body and a null miniAppUrl, which is how a URL is cleared', async () => {
    expect((await run(UpdateTenantDto, {})).ok).toBe(true);
    expect((await run(UpdateTenantDto, { miniAppUrl: null })).ok).toBe(true);
  });

  it('admits slug and currencyCode so the service can refuse them by name', async () => {
    expect((await run(UpdateTenantDto, { slug: 'renamed', currencyCode: 'USD' })).ok).toBe(true);
  });

  it.each([
    ['a chat id sent as a JSON number', { adminChatId: -1001234567890 }, 'adminChatId'],
    ['a chat id with a decimal point', { adminChatId: '12.5' }, 'adminChatId'],
    ['a chat id past signed 64-bit', { adminChatId: '-9223372036854775809' }, 'adminChatId'],
    ['a feed chat set to null', { feedChatId: null }, 'feedChatId'],
    ['minor units with a decimal point', { dualApprovalThresholdMinor: '1500.00' }, 'dualApprovalThresholdMinor'],
    ['minor units past a BIGINT', { agentFloatLowWatermarkMinor: '9223372036854775808' }, 'agentFloatLowWatermarkMinor'],
    ['a negative threshold', { dualApprovalThresholdMinor: '-1' }, 'dualApprovalThresholdMinor'],
    ['an expiry under five minutes', { depositExpiryMinutes: 4 }, 'depositExpiryMinutes'],
    ['an expiry over a day', { depositExpiryMinutes: 1441 }, 'depositExpiryMinutes'],
    ['an expiry sent as a string', { depositExpiryMinutes: '30' }, 'depositExpiryMinutes'],
    ['a deposit mode that does not exist', { depositMode: 'SOMETIMES' }, 'depositMode'],
    ['a plain http mini app URL', { miniAppUrl: 'http://cashier.example.app' }, 'miniAppUrl'],
    ['a blank display name', { displayName: '   ' }, 'displayName'],
    ['a display name over 120 characters', { displayName: 'x'.repeat(121) }, 'displayName'],
  ])('refuses %s, naming the field', async (_label, body, field) => {
    const fields = await refusedFields(UpdateTenantDto, body);
    expect(fields.length).toBeGreaterThan(0);
    for (const message of fields) expect(message.startsWith(field)).toBe(true);
  });

  it('accepts the extremes of a signed 64-bit chat id', async () => {
    expect((await run(UpdateTenantDto, { adminChatId: '-9223372036854775808' })).ok).toBe(true);
    expect((await run(UpdateTenantDto, { adminChatId: '9223372036854775807' })).ok).toBe(true);
  });

  it('refuses a field the form cannot send, such as status', async () => {
    expect(await refusedFields(UpdateTenantDto, { status: 'ACTIVE' })).toEqual([
      'property status should not exist',
    ]);
  });
});

describe('UpdatePlatformDefaultsDto', () => {
  it('upper-cases a currency code and accepts every documented field', async () => {
    const outcome = await run(UpdatePlatformDefaultsDto, {
      ichancyBaseUrl: 'https://agents.ichancy.com',
      ichancyAgentId: '10500',
      currencyCode: ' nsp ',
      dualApprovalThresholdMinor: '50000000',
      agentFloatLowWatermarkMinor: '100000000',
      depositExpiryMinutes: 30,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.currencyCode).toBe('NSP');
  });

  it.each([
    ['an agent id cleared with null', { ichancyAgentId: null }, 'ichancyAgentId'],
    ['an agent id that is not digits', { ichancyAgentId: 'agent-7' }, 'ichancyAgentId'],
    ['a two-letter currency', { currencyCode: 'NS' }, 'currencyCode'],
    ['a plain http Ichancy URL', { ichancyBaseUrl: 'http://agents.ichancy.com' }, 'ichancyBaseUrl'],
    ['minor units as a number', { dualApprovalThresholdMinor: 50000000 }, 'dualApprovalThresholdMinor'],
    ['an expiry of zero', { depositExpiryMinutes: 0 }, 'depositExpiryMinutes'],
  ])('refuses %s, naming the field', async (_label, body, field) => {
    const fields = await refusedFields(UpdatePlatformDefaultsDto, body);
    expect(fields.length).toBeGreaterThan(0);
    for (const message of fields) expect(message.startsWith(field)).toBe(true);
  });

  it('refuses a key the defaults row does not have', async () => {
    expect(await refusedFields(UpdatePlatformDefaultsDto, { withdrawalMode: 'AUTO' })).toEqual([
      'property withdrawalMode should not exist',
    ]);
  });
});
