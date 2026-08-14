/**
 * The credited ops card. Deterministic rendering matters here for the same reason as the review
 * card (byte-identical replays), and the legacy degradations (— instead of a crash) are the cases
 * a production replay will actually hit.
 */
import { renderOpsCard, type OpsCardInput } from './deposit-card.util';

const base: OpsCardInput = {
  shortId: 'K7Q2ZP9V3M',
  telegramUserId: 123456789n,
  ichancyLogin: 'pdeadbeef1234',
  ichancyPlayerId: 'ich-123',
  amountMinor: 100_000n, // 1,000.00 NSP
  floatBeforeMinor: 256_331_500n,
  floatAfterMinor: 256_231_500n,
  paymentMethodName: 'Syriatel Cash',
  creditedAt: new Date('2026-08-14T09:57:17.123Z'),
};

describe('renderOpsCard', () => {
  it('carries every field of the market reference, with the dual amount and UTC label', () => {
    const text = renderOpsCard(base);

    expect(text).toContain('عملية شحن على المنصة');
    expect(text).toContain('<code>123456789</code>');
    expect(text).toContain('<code>pdeadbeef1234</code>');
    expect(text).toContain('<code>ich-123</code>');
    expect(text).toContain('1,000.00 جديدة | 100,000 قديمة');
    expect(text).toContain('قبل الشحن: 2,563,315.00 NSP');
    expect(text).toContain('بعد الشحن: 2,562,315.00 NSP');
    expect(text).toContain('<code>K7Q2ZP9V3M</code>');
    expect(text).toContain('Syriatel Cash');
    expect(text).toContain('2026-08-14 09:57:17 UTC');
  });

  it('degrades to — for a legacy player with no stored Ichancy identity', () => {
    const text = renderOpsCard({ ...base, ichancyLogin: null, ichancyPlayerId: null });
    expect(text).toContain('حساب المنصة: —');
    expect(text).toContain('ID اللاعب: —');
    expect(text).not.toContain('null');
  });

  it('degrades to — when the T2 snapshot could not be recovered', () => {
    const text = renderOpsCard({ ...base, floatBeforeMinor: null, floatAfterMinor: null });
    expect(text).toContain('قبل الشحن: —');
    expect(text).toContain('بعد الشحن: —');
  });

  it('escapes HTML in operator-controlled strings', () => {
    const text = renderOpsCard({ ...base, paymentMethodName: 'Cash <&> Go' });
    expect(text).toContain('Cash &lt;&amp;&gt; Go');
  });

  it('is deterministic: same input, same bytes', () => {
    expect(renderOpsCard(base)).toBe(renderOpsCard(base));
  });
});
