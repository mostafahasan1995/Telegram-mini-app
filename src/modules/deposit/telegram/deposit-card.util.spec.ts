import { DepositStatus, type DepositRequest } from '@prisma/client';

import { CALLBACK_DATA_MAX_BYTES } from '@core/telegram/utils/callback-data.util';

import { RiskFlags } from '../enums/risk-flag.enum';
import {
  esc,
  renderAdminCard,
  renderAdminKeyboard,
  renderPlayerMessage,
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
