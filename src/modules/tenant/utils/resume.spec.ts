import {
  ichancyFingerprint,
  mayResumeWithoutSignIn,
  type IchancyIdentity,
  type StatusDecision,
} from './resume';

const IDENTITY: IchancyIdentity = {
  ichancyBaseUrl: 'https://agents.ichancy.com',
  ichancyUsername: 'agent_north',
  ichancyPasswordEnc: 'v1:sealed-password',
  ichancyAgentId: '10099',
};

const suspendedWith = (fingerprint: unknown): StatusDecision => ({
  action: 'tenant.suspended',
  after: { status: 'SUSPENDED', $meta: { ichancyFingerprint: fingerprint } as never },
});

describe('ichancyFingerprint', () => {
  it('is a stable hex digest that contains none of the values it covers', () => {
    const digest = ichancyFingerprint(IDENTITY);

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(ichancyFingerprint({ ...IDENTITY })).toBe(digest);
    for (const value of Object.values(IDENTITY)) expect(digest).not.toContain(value);
  });

  it.each(['ichancyBaseUrl', 'ichancyUsername', 'ichancyPasswordEnc', 'ichancyAgentId'] as const)(
    'changes when %s changes',
    (field) => {
      expect(ichancyFingerprint({ ...IDENTITY, [field]: `${IDENTITY[field]}x` })).not.toBe(
        ichancyFingerprint(IDENTITY),
      );
    },
  );

  it('cannot be matched by shifting characters between neighbouring fields', () => {
    const shifted = { ...IDENTITY, ichancyUsername: 'agent_nort', ichancyPasswordEnc: 'hv1:sealed-password' };
    expect(ichancyFingerprint(shifted)).not.toBe(ichancyFingerprint(IDENTITY));
  });
});

describe('mayResumeWithoutSignIn', () => {
  it('resumes an operator whose last decision was a suspension with the same credentials', () => {
    expect(mayResumeWithoutSignIn(suspendedWith(ichancyFingerprint(IDENTITY)), IDENTITY)).toBe(true);
  });

  it('refuses an operator with no status decision at all, such as one created suspended', () => {
    expect(mayResumeWithoutSignIn(null, IDENTITY)).toBe(false);
  });

  it('refuses when the latest decision is not a suspension', () => {
    expect(
      mayResumeWithoutSignIn(
        { action: 'tenant.activated', after: { $meta: { ichancyFingerprint: ichancyFingerprint(IDENTITY) } } },
        IDENTITY,
      ),
    ).toBe(false);
  });

  it('refuses when the credentials changed while it was suspended', () => {
    const before = ichancyFingerprint(IDENTITY);
    expect(mayResumeWithoutSignIn(suspendedWith(before), { ...IDENTITY, ichancyAgentId: '10500' })).toBe(
      false,
    );
  });

  it('refuses a suspension recorded without a usable fingerprint', () => {
    expect(mayResumeWithoutSignIn({ action: 'tenant.suspended', after: { status: 'SUSPENDED' } }, IDENTITY)).toBe(
      false,
    );
    expect(mayResumeWithoutSignIn({ action: 'tenant.suspended', after: null }, IDENTITY)).toBe(false);
    expect(mayResumeWithoutSignIn(suspendedWith(42), IDENTITY)).toBe(false);
  });
});
