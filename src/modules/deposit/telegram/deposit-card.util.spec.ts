import { DepositStatus, type DepositRequest } from '@prisma/client';

import { CALLBACK_DATA_MAX_BYTES } from '@core/telegram/utils/callback-data.util';

import { RiskFlags } from '../enums/risk-flag.enum';
import {
  esc,
  mask,
  renderAdminCard,
  renderAdminKeyboard,
  renderOpsCard,
  renderOpsCardPublic,
  renderPlayerMessage,
  type OpsCardInput,
} from './deposit-card.util';

const DEPOSIT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function deposit(overrides: Partial<DepositRequest> = {}): DepositRequest {
  return {
    id: DEPOSIT_ID,
    shortId: 'K7Q2ZP9V3M',
    currencyCode: 'NSP',
    claimedAmountMinor: 150_000n,
    verifiedAmountMinor: null,
    creditedAmountMinor: null,
    feeMinor: 0n,
    status: DepositStatus.SUBMITTED,
    externalReference: null,
    senderAccount: null,
    rejectionCode: null,
    rejectionNote: null,
    createdAt: new Date('2026-08-12T09:00:00.000Z'),
    ...overrides,
  } as DepositRequest;
}

const base = {
  proofs: [],
  riskFlags: [],
  playerLabel: '@player (123)',
  paymentMethodName: 'Syriatel Cash',
  destinationLabel: 'Main wallet',
  requiresSecondApproval: false,
};

describe('esc', () => {
  it('escapes exactly the three characters Telegram HTML needs', () => {
    expect(esc('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
  });

  it('leaves the characters MarkdownV2 would have needed alone', () => {
    // This is the whole reason the card is HTML: a display name like this would break MarkdownV2.
    expect(esc('a_b*c[d]')).toBe('a_b*c[d]');
  });
});

describe('renderAdminCard', () => {
  it('is deterministic — the same inputs produce byte-identical text', () => {
    const input = { ...base, deposit: deposit() };
    expect(renderAdminCard(input)).toBe(renderAdminCard(input));
  });

  it('shows the claim, and the verified amount only once one exists', () => {
    expect(renderAdminCard({ ...base, deposit: deposit() })).toContain('Claimed: <b>1500.00 NSP');
    expect(renderAdminCard({ ...base, deposit: deposit() })).not.toContain('Verified:');
    expect(
      renderAdminCard({ ...base, deposit: deposit({ verifiedAmountMinor: 140_000n }) }),
    ).toContain('Verified: <b>1400.00 NSP');
  });

  it('states that risk signals are not a verdict', () => {
    const text = renderAdminCard({
      ...base,
      deposit: deposit(),
      riskFlags: [RiskFlags.DUPLICATE_PROOF_EXACT],
    });
    expect(text).toContain('Risk signals');
    expect(text).toContain('nothing was auto-rejected');
  });

  it('orders risk signals worst-first', () => {
    const text = renderAdminCard({
      ...base,
      deposit: deposit(),
      riskFlags: [RiskFlags.NEW_PLAYER, RiskFlags.DUPLICATE_PROOF_EXACT],
    });
    expect(text.indexOf('ANOTHER player')).toBeLessThan(text.indexOf('less than a day old'));
  });

  it('escapes player-supplied text rather than trusting it', () => {
    const text = renderAdminCard({
      ...base,
      deposit: deposit({ senderAccount: '<script>alert(1)</script>' }),
    });
    expect(text).not.toContain('<script>');
    expect(text).toContain('&lt;script&gt;');
  });

  it('tells a reviewer where to look when a credit outcome is unknown', () => {
    const text = renderAdminCard({
      ...base,
      deposit: deposit({ status: DepositStatus.NEEDS_RECONCILIATION }),
    });
    expect(text).toContain('Ichancy panel');
    expect(text).toContain('K7Q2ZP9V3M');
  });
});

describe('renderAdminKeyboard', () => {
  it('offers claim/approve/reject on a fresh submission', () => {
    const keyboard = renderAdminKeyboard(deposit({ status: DepositStatus.SUBMITTED }));
    const actions = keyboard?.inline_keyboard[0]?.map((button) => button.callback_data) ?? [];
    expect(actions).toEqual([`d:c:${DEPOSIT_ID}`, `d:a:${DEPOSIT_ID}`, `d:r:${DEPOSIT_ID}`]);
  });

  it('drops the claim button once the deposit is under review', () => {
    const keyboard = renderAdminKeyboard(deposit({ status: DepositStatus.UNDER_REVIEW }));
    expect(keyboard?.inline_keyboard[0]).toHaveLength(2);
  });

  /** The point of the whole exercise: a terminal card must not offer a button that can only fail. */
  it.each([
    DepositStatus.CREDITED,
    DepositStatus.CREDIT_FAILED,
    DepositStatus.REJECTED,
    DepositStatus.EXPIRED,
    DepositStatus.REVERSED,
    DepositStatus.NEEDS_RECONCILIATION,
    DepositStatus.APPROVED,
    DepositStatus.CREDITING,
  ])('strips the keyboard for %s', (status) => {
    expect(renderAdminKeyboard(deposit({ status }))).toBeUndefined();
  });

  it('keeps every callback payload inside Telegram’s 64-BYTE budget', () => {
    const keyboard = renderAdminKeyboard(deposit({ status: DepositStatus.SUBMITTED }));
    for (const row of keyboard?.inline_keyboard ?? []) {
      for (const button of row) {
        expect(Buffer.byteLength(button.callback_data, 'utf8')).toBeLessThanOrEqual(
          CALLBACK_DATA_MAX_BYTES,
        );
      }
    }
  });
});

describe('mask', () => {
  it('keeps only the last three characters, behind a fixed-length prefix', () => {
    expect(mask('player_hamza')).toBe('•••mza');
    expect(mask('90210123')).toBe('•••123');
  });

  it('accepts a bigint without going through Number', () => {
    // 6243119785 > 2^32; a Number round-trip would still be exact here, but the point is that the
    // function never reaches for one — the same call with a >2^53 id must keep its real last digits.
    expect(mask(6_243_119_785n)).toBe('•••785');
    expect(mask(90_071_992_547_409_931n)).toBe('•••931');
  });

  it('reveals NOTHING when "the last three" would be the whole value', () => {
    expect(mask('abc')).toBe('•••');
    expect(mask('ab')).toBe('•••');
    expect(mask('a')).toBe('•••');
    expect(mask(42n)).toBe('•••');
  });

  it('renders a missing value as the same em-dash the full card uses', () => {
    expect(mask(null)).toBe('—');
    expect(mask(undefined)).toBe('—');
    expect(mask('')).toBe('—');
    expect(mask('   ')).toBe('—');
  });

  it('never leaks the length of what it hid', () => {
    // One bullet per hidden character would turn the mask into a length oracle.
    expect(mask('abcd')).toHaveLength(mask('abcdefghijklmnopqrstuvwxyz').length);
  });

  it('never reveals more than three characters, whatever it is given', () => {
    for (const value of ['abcd', 'x'.repeat(200), '  padded_login  ', '000000000000']) {
      expect(mask(value).replace('•••', '').length).toBeLessThanOrEqual(3);
    }
  });
});

describe('renderOpsCardPublic', () => {
  const opsCard: OpsCardInput = {
    shortId: 'K7Q2ZP9V3M',
    telegramUserId: 6_243_119_785n,
    ichancyLogin: 'player_hamza',
    ichancyPlayerId: '90210123',
    amountMinor: 150_000n,
    floatBeforeMinor: 8_800_000n,
    floatAfterMinor: 8_650_000n,
    paymentMethodName: 'Syriatel Cash',
    creditedAt: new Date('2026-08-12T09:31:07.000Z'),
  };

  it('is deterministic — the same inputs produce byte-identical text', () => {
    expect(renderOpsCardPublic(opsCard)).toBe(renderOpsCardPublic(opsCard));
  });

  /** The whole reason this variant exists: the feed group may contain customers. */
  it('never contains the cashier float, in any form', () => {
    const text = renderOpsCardPublic(opsCard);
    expect(text).not.toContain('رصيد الكاشيرة');
    expect(text).not.toContain('88,000.00'); // floatBeforeMinor
    expect(text).not.toContain('86,500.00'); // floatAfterMinor
    expect(text).not.toContain('8800000');
    expect(text).not.toContain('8650000');
  });

  it('masks every identifier and leaks none of them whole', () => {
    const text = renderOpsCardPublic(opsCard);
    expect(text).toContain('•••785');
    expect(text).toContain('•••mza');
    expect(text).toContain('•••123');
    expect(text).not.toContain('6243119785');
    expect(text).not.toContain('player_hamza');
    expect(text).not.toContain('90210123');
  });

  it('keeps the amount in both market currencies, the method, the reference and the time', () => {
    const text = renderOpsCardPublic(opsCard);
    expect(text).toContain('1,500.00 جديدة | 150,000 قديمة');
    expect(text).toContain('Syriatel Cash');
    expect(text).toContain('K7Q2ZP9V3M');
    expect(text).toContain('2026-08-12 09:31:07 UTC');
  });

  it('reads as the same product as the admin card, and ends on a friendly line', () => {
    const text = renderOpsCardPublic(opsCard);
    expect(text.startsWith('📥 <b>عملية شحن على المنصة</b>')).toBe(true);
    expect(text.endsWith('✅ تم شحن الرصيد بنجاح')).toBe(true);
  });

  it('renders a missing login or player id as — rather than an empty mask', () => {
    const text = renderOpsCardPublic({ ...opsCard, ichancyLogin: null, ichancyPlayerId: null });
    expect(text).toContain('🎮 حساب المنصة: <code>—</code>');
    expect(text).toContain('🆔 ID اللاعب: <code>—</code>');
  });

  it('escapes what survives masking — a login is player-supplied text', () => {
    const text = renderOpsCardPublic({ ...opsCard, ichancyLogin: 'evil<b>' });
    expect(text).not.toContain('•••<b>');
    expect(text).toContain('•••&lt;b&gt;');
  });

  /** Guard: the admin card is the money record and must not have been softened by any of this. */
  it('is the only masked variant — renderOpsCard still shows everything', () => {
    const admin = renderOpsCard(opsCard);
    expect(admin).toContain('رصيد الكاشيرة قبل الشحن: 88,000.00 NSP');
    expect(admin).toContain('رصيد الكاشيرة بعد الشحن: 86,500.00 NSP');
    expect(admin).toContain('6243119785');
    expect(admin).toContain('player_hamza');
    expect(admin).not.toContain('•••');
  });
});

describe('renderPlayerMessage', () => {
  it('formats the amount from minor units, never from a float', () => {
    expect(
      renderPlayerMessage('deposit.credited', { shortId: 'K7Q2ZP9V3M', amountMinor: '150000' }),
    ).toContain('1500.00');
  });

  it('never tells a player which of our checks fired', () => {
    const text = renderPlayerMessage('deposit.rejected', {
      shortId: 'K7Q2ZP9V3M',
      rejectionCode: 'PROOF_UNREADABLE',
    });
    expect(text).toContain('PROOF_UNREADABLE');
    expect(text).not.toContain('DUPLICATE');
  });

  it('falls back to a neutral sentence for an unknown template', () => {
    expect(renderPlayerMessage('deposit.something_new', { shortId: 'K7Q2ZP9V3M' })).toContain(
      'K7Q2ZP9V3M',
    );
  });
});
