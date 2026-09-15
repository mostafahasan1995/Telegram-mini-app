import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { TENANT_BOOTSTRAP_ID, TENANT_ZERO_ID } from '@core/tenant/tenant.constants';

import { TenantIdParamDto } from './tenant-id-param.dto';

const errorsFor = async (id: unknown): Promise<string[]> => {
  const errors = await validate(plainToInstance(TenantIdParamDto, { id }));
  return errors.flatMap((error) => Object.values(error.constraints ?? {}));
};

describe('TenantIdParamDto', () => {
  it.each([
    ['tenant zero', TENANT_ZERO_ID],
    // The case the shared IdParamDto refused: version nibble 0.
    ['the bootstrap operator', TENANT_BOOTSTRAP_ID],
    ['a gen_random_uuid() v4 id', '3f2b8c1e-9d4a-4e7b-8a6c-1b2d3e4f5a6b'],
    ['a uuidv7 id', '01a0a2d3-e91a-7aab-8c29-42bddbc808a6'],
    ['an upper-case id', '3F2B8C1E-9D4A-4E7B-8A6C-1B2D3E4F5A6B'],
  ])('accepts %s', async (_name, id) => {
    expect(await errorsFor(id)).toEqual([]);
  });

  it.each([
    ['text', 'not-a-uuid'],
    ['a uuid without dashes', '3f2b8c1e9d4a4e7b8a6c1b2d3e4f5a6b'],
    ['a uuid with a trailing character', `${TENANT_BOOTSTRAP_ID}0`],
    ['a non-hex digit', '3f2b8c1e-9d4a-4e7b-8a6c-1b2d3e4f5a6g'],
    ['an empty string', ''],
    ['a number', 42],
  ])('refuses %s with the shared message', async (_name, id) => {
    expect(await errorsFor(id)).toEqual(['id must be a UUID']);
  });
});
