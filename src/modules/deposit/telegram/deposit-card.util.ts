/**
 * Rendering for the admin review card and the player's messages.
 *
 * WHY pure functions in a util rather than string building inside the notifier: the card is edited
 * in place on every state change, and Telegram answers "message is not modified" when the new text
 * equals the old one. That makes the rendering function's OUTPUT part of the concurrency behaviour —
 * two workers redrawing the same card must produce byte-identical text or one of them will "win" a
 * pointless edit. A pure function is the only way to be sure.
 *
 * WHY HTML and not Markdown: a player's Telegram display name can legally contain `_`, `*` and `[`.
 * MarkdownV2 would need every one of them escaped in exactly the right places, and one miss makes
 * the whole send fail with a parse error — i.e. an admin card that never appears for one specific
 * player. HTML needs exactly three characters escaped, done once in `esc()`.
 *
 * CALLBACK DATA BUDGET: Telegram allows 64 BYTES. `d:a:<uuid>` is 4 + 36 = 40, which fits; a
 * shortId would fit too but the uuid is what the admin endpoints address rows by, so using it here
 * removes a lookup from the hot path of a button press.
 */
import { DepositStatus, type DepositProof, type DepositRequest } from '@prisma/client';

import { dualNsp, formatNspGrouped } from '@common/helpers/money-display.util';
import { formatMinorToDecimal } from '@common/helpers/money.util';
import { encodeCallbackData } from '@core/telegram/utils/callback-data.util';

import { DEPOSIT_CALLBACK_NS } from '../deposit.constants';
import { RISK_FLAG_SEVERITY, type RiskFlag } from '../enums/risk-flag.enum';

/** Telegram's HTML parse mode needs exactly these three escaped, and nothing else. */
export function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const STATUS_LABEL: Readonly<Record<DepositStatus, string>> = Object.freeze({
  [DepositStatus.DRAFT]: 'Draft',
  [DepositStatus.AWAITING_PROOF]: 'Awaiting proof',
  [DepositStatus.SUBMITTED]: 'Waiting for review',
  [DepositStatus.UNDER_REVIEW]: 'Under review',
  [DepositStatus.PENDING_SECOND_APPROVAL]: 'Needs a second approval',
  [DepositStatus.APPROVED]: 'Approved — crediting',
  [DepositStatus.CREDITING]: 'Crediting',
  [DepositStatus.CREDITED]: 'Credited',
  [DepositStatus.CREDIT_FAILED]: 'Credit FAILED',
  [DepositStatus.NEEDS_RECONCILIATION]: 'NEEDS RECONCILIATION',
  [DepositStatus.REJECTED]: 'Rejected',
  [DepositStatus.EXPIRED]: 'Expired',
  [DepositStatus.REVERSED]: 'Reversed',
});

const RISK_LABEL: Readonly<Record<RiskFlag, string>> = Object.freeze({
  DUPLICATE_PROOF_EXACT: 'identical proof used by ANOTHER player',
  DUPLICATE_PROOF_SIMILAR: 'near-identical proof used by ANOTHER player',
  DUPLICATE_PROOF_SAME_PLAYER: 'this player reused an earlier proof',
  REFERENCE_REUSED: 'reference already claimed by another deposit',
  LARGE_AMOUNT: 'at or above the dual-approval threshold',
  NEW_PLAYER: 'account is less than a day old',
  RAPID_RESUBMISSION: 'several submissions in the last few minutes',
  PROOF_UNREADABLE: 'proof image could not be decoded',
});

export interface AdminCardInput {
  deposit: DepositRequest;
  proofs: readonly DepositProof[];
  riskFlags: readonly RiskFlag[];
  playerLabel: string;
  paymentMethodName: string;
  destinationLabel: string | null;
  /** Rendered only when set; keeps the card stable while nobody has claimed the deposit. */
  reviewerLabel?: string | null;
  requiresSecondApproval: boolean;
}

/** The card body. Deterministic: same inputs, same bytes. */
export function renderAdminCard(input: AdminCardInput): string {
  const { deposit } = input;
  const lines: string[] = [];

  lines.push(`<b>Deposit ${esc(deposit.shortId)}</b> — ${esc(STATUS_LABEL[deposit.status])}`);
  lines.push('');
  lines.push(
    `Claimed: <b>${esc(formatMinorToDecimal(deposit.claimedAmountMinor))} ${esc(deposit.currencyCode)}</b>`,
  );
  if (deposit.verifiedAmountMinor !== null) {
    lines.push(
      `Verified: <b>${esc(formatMinorToDecimal(deposit.verifiedAmountMinor))} ${esc(deposit.currencyCode)}</b>`,
    );
  }
  if (deposit.feeMinor > 0n) {
    lines.push(`Fee: ${esc(formatMinorToDecimal(deposit.feeMinor))} ${esc(deposit.currencyCode)}`);
  }
  lines.push(`Player: ${esc(input.playerLabel)}`);
  lines.push(
    `Via: ${esc(input.paymentMethodName)}${
      input.destinationLabel === null ? '' : ` → ${esc(input.destinationLabel)}`
    }`,
  );
  if (deposit.externalReference !== null) {
    lines.push(`Reference: <code>${esc(deposit.externalReference)}</code>`);
  }
  if (deposit.senderAccount !== null) {
    lines.push(`Sender: <code>${esc(deposit.senderAccount)}</code>`);
  }
  lines.push(`Proofs: ${input.proofs.length}`);
  lines.push(`Opened: ${esc(deposit.createdAt.toISOString())}`);

  if (input.riskFlags.length > 0) {
    lines.push('');
    lines.push('<b>⚠ Risk signals</b>');
    for (const flag of orderRisk(input.riskFlags)) {
      lines.push(`• ${esc(RISK_LABEL[flag])}`);
    }
    // Said explicitly on the card, because the flag list looks like a verdict and is not one.
    lines.push('<i>Signals only — nothing was auto-rejected.</i>');
  }

  if (input.requiresSecondApproval) {
    lines.push('');
    lines.push('<b>Four eyes required:</b> a second, different admin must approve this amount.');
  }

  if (input.reviewerLabel !== null && input.reviewerLabel !== undefined) {
    lines.push('');
    lines.push(`Claimed by ${esc(input.reviewerLabel)}`);
  }

  if (deposit.status === DepositStatus.CREDIT_FAILED && deposit.rejectionCode !== null) {
    lines.push('');
    lines.push(`Failure: <code>${esc(deposit.rejectionCode)}</code>`);
  }
  if (deposit.status === DepositStatus.NEEDS_RECONCILIATION) {
    lines.push('');
    lines.push(
      `<b>Check the Ichancy panel for comment</b> <code>${esc(deposit.shortId)}</code> before re-running.`,
    );
  }
  if (deposit.status === DepositStatus.REJECTED && deposit.rejectionCode !== null) {
    lines.push('');
    lines.push(`Rejected: <code>${esc(deposit.rejectionCode)}</code>`);
    if (deposit.rejectionNote !== null) lines.push(esc(deposit.rejectionNote));
  }

  return lines.join('\n');
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineButton[][];
}

/**
 * The keyboard for a card. Returns `undefined` on a TERMINAL status: a credited or rejected deposit
 * must not keep offering buttons that would only produce "already handled" answers. Stripping the
 * keyboard is what turns the card into a receipt.
 */
export function renderAdminKeyboard(deposit: DepositRequest): InlineKeyboardMarkup | undefined {
  switch (deposit.status) {
    case DepositStatus.SUBMITTED:
      return {
        inline_keyboard: [
          [
            button('🔒 Claim', 'c', deposit.id),
            button('✅ Approve', 'a', deposit.id),
            button('❌ Reject', 'r', deposit.id),
          ],
        ],
      };
    case DepositStatus.UNDER_REVIEW:
    case DepositStatus.PENDING_SECOND_APPROVAL:
      return {
        inline_keyboard: [
          [button('✅ Approve', 'a', deposit.id), button('❌ Reject', 'r', deposit.id)],
        ],
      };
    default:
      // APPROVED/CREDITING are in flight; everything else is terminal. Neither takes a decision.
      return undefined;
  }
}

function button(text: string, action: string, depositId: string): InlineButton {
  return { text, callback_data: encodeCallbackData(DEPOSIT_CALLBACK_NS, action, depositId) };
}

export interface OpsCardInput {
  shortId: string;
  telegramUserId: bigint;
  /** Null on a legacy row whose Ichancy account predates the stored credentials. Rendered as —. */
  ichancyLogin: string | null;
  ichancyPlayerId: string | null;
  amountMinor: bigint;
  /** From the T2 balance snapshot on ICHANCY_AGENT_FLOAT; null when the snapshot is unrecoverable. */
  floatBeforeMinor: bigint | null;
  floatAfterMinor: bigint | null;
  paymentMethodName: string;
  /** When the credit was confirmed. Rendered in UTC and labelled as such. */
  creditedAt: Date;
}

const NO_VALUE = '—';

/**
 * The credited ops card posted to the admin group — Arabic-first because the operators are; the
 * field labels follow the market convention the operators already read all day. Deterministic like
 * renderAdminCard: same inputs, same bytes.
 */
export function renderOpsCard(input: OpsCardInput): string {
  const login = input.ichancyLogin === null ? NO_VALUE : `<code>${esc(input.ichancyLogin)}</code>`;
  const playerId =
    input.ichancyPlayerId === null ? NO_VALUE : `<code>${esc(input.ichancyPlayerId)}</code>`;
  const float = (minor: bigint | null): string =>
    minor === null ? NO_VALUE : `${esc(formatNspGrouped(minor))} NSP`;
  // toISOString IS UTC; the label says so because the operators live in another timezone.
  const time = `${input.creditedAt.toISOString().slice(0, 19).replace('T', ' ')} UTC`;

  return [
    '📥 <b>عملية شحن على المنصة</b>',
    `👤 مستخدم التيليغرام: <code>${input.telegramUserId.toString()}</code>`,
    `🎮 حساب المنصة: ${login}`,
    `🆔 ID اللاعب: ${playerId}`,
    `💰 المبلغ المشحون: <b>${esc(dualNsp(input.amountMinor))}</b>`,
    `📊 رصيد الكاشيرة قبل الشحن: ${float(input.floatBeforeMinor)}`,
    `📊 رصيد الكاشيرة بعد الشحن: ${float(input.floatAfterMinor)}`,
    `🧾 المرجع: <code>${esc(input.shortId)}</code>`,
    `💳 وسيلة الدفع: ${esc(input.paymentMethodName)}`,
    `📅 الوقت: ${esc(time)}`,
  ].join('\n');
}

function orderRisk(flags: readonly RiskFlag[]): RiskFlag[] {
  return [...flags].sort((a, b) => RISK_FLAG_SEVERITY[b] - RISK_FLAG_SEVERITY[a]);
}

/**
 * Player-facing text. Keyed by a stable template id rather than rendered at the producer, so the
 * wording can change without rewriting queued messages — the queue carries the key, not the
 * sentence.
 */
export function renderPlayerMessage(
  template: string,
  params: Readonly<Record<string, string>>,
): string {
  const shortId = esc(params['shortId'] ?? '');
  const amount =
    params['amountMinor'] === undefined
      ? null
      : formatMinorToDecimal(BigInt(params['amountMinor']));

  switch (template) {
    case 'deposit.credited':
      return (
        `✅ Your deposit <b>${shortId}</b> has been credited` +
        (amount === null ? '.' : ` with <b>${esc(amount)}</b>.`) +
        `\nEnjoy your game!`
      );
    case 'deposit.rejected':
      return (
        `❌ Your deposit <b>${shortId}</b> could not be accepted.\n` +
        `Reason code: <code>${esc(params['rejectionCode'] ?? 'OTHER')}</code>\n` +
        `Contact support if you think this is a mistake.`
      );
    case 'deposit.credit_failed':
      return (
        `⚠️ We confirmed your payment for <b>${shortId}</b>, but crediting it is taking longer ` +
        `than usual. Our team has been alerted — you do not need to do anything.`
      );
    case 'deposit.expired':
      return (
        `⌛ Your deposit <b>${shortId}</b> expired because no payment proof arrived in time. ` +
        `Start a new one whenever you are ready.`
      );
    case 'deposit.submitted':
      return `📨 We received your proof for <b>${shortId}</b>. A reviewer will look at it shortly.`;
    default:
      return `Update on your deposit <b>${shortId}</b>.`;
  }
}
