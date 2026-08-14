/**
 * The dual-amount convention is a CONTRACT with the operators: the old-lira figure must be the
 * minor-unit integer itself (scale 2 ⇒ minor = NSP × 100 = old lira). If someone "helpfully"
 * converts instead of reusing the bigint, these tests are what catches it.
 */
import { dualNsp, formatNspGrouped, groupThousands } from './money-display.util';

describe('groupThousands', () => {
  it('groups the whole part and leaves the fraction alone', () => {
    expect(groupThousands('2563315.00')).toBe('2,563,315.00');
    expect(groupThousands('100000')).toBe('100,000');
    expect(groupThousands('999')).toBe('999');
    expect(groupThousands('1000')).toBe('1,000');
  });

  it('keeps the sign out of the first group', () => {
    expect(groupThousands('-1234567.89')).toBe('-1,234,567.89');
  });

  it('handles amounts beyond Number safety, because it never leaves strings', () => {
    expect(groupThousands('9007199254740993')).toBe('9,007,199,254,740,993');
  });
});

describe('formatNspGrouped', () => {
  it('renders minor units as a grouped NSP decimal', () => {
    expect(formatNspGrouped(256_331_500n)).toBe('2,563,315.00');
    expect(formatNspGrouped(0n)).toBe('0.00');
  });
});

describe('dualNsp', () => {
  it('shows new NSP and old lira, where old lira IS the minor-unit integer', () => {
    expect(dualNsp(100_000n)).toBe('1,000.00 جديدة | 100,000 قديمة');
  });

  it('round example from the market reference: 100000 NSP', () => {
    expect(dualNsp(10_000_000n)).toBe('100,000.00 جديدة | 10,000,000 قديمة');
  });
});
