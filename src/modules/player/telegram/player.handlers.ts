/**
 * Player-facing bot commands. These run ONLY in the worker role — the registrar skips discovery in
 * the api process.
 *
 * WHY /start creates the player row: the referral binding points at a `players.id`, so the row has
 * to exist before a referrer can be attached to it. /start is also the first contact for most
 * users, well before they ever open the mini app, and a row here costs nothing.
 *
 * WHY nothing in this file throws on a Telegram failure: the registrar swallows and logs handler
 * errors so that a failed reply cannot make BullMQ retry the whole update — replaying an update
 * whose side effect already happened is precisely what the dedupe layer exists to prevent. Handlers
 * are therefore written to degrade to a plain message, never to blow up.
 *
 * ══ WHY THE READS GO STRAIGHT TO PRISMA AND ONLY THE WRITE GOES THROUGH A SERVICE ═════════════
 * `eslint-plugin-boundaries` makes modules/player -> modules/deposit and modules/player ->
 * modules/payment-method a BUILD FAILURE, and correctly so. Everything /methods and /deposits show
 * is a read-only projection for a human to look at — no transaction, no money write, nothing that
 * needs the invariants those services own — so they are read from Prisma (@core, always allowed),
 * exactly as src/modules/admin/telegram/admin.handlers.ts does for the review queue. The two rules
 * that had to be restated are marked MIRRORS and name what they mirror.
 *
 * ══ WHY DepositService IS RESOLVED THROUGH DiscoveryService INSTEAD OF INJECTED ════════════════
 * Opening a deposit is a MONEY WRITE and must not be reimplemented here: it is a policy gate, a
 * state-machine transition, an audit row and an outbox message inside one transaction. It has to be
 * `DepositService.create`. But that service cannot be reached from this module:
 *
 *   - importing it (or DepositModule) is the boundary violation above; and
 *   - `PlayerModule` importing `DepositModule` would ALSO break the DI graph of
 *     src/modules/modules.int.spec.ts, which boots PlayerModule without the three ports
 *     DepositService needs (PLAYER_LINK_PORT / PAYMENT_METHOD_PORT / APPROVAL_LIMIT_PORT); and
 *   - there is no published DEPOSIT port — the existing tokens are all consumed BY the deposit
 *     flow, not offered by it.
 *
 * So the instance is located in the container at first use, by provider class name, and duck-typed
 * against the local `DepositCreatePort` below before it is trusted. It is a workaround and it is
 * written to fail LOUDLY (logged error + a plain "try again later" to the player) rather than
 * silently, because the alternative — a second implementation of a money write — is not an option.
 *
 * PROPER FIX (for whoever owns the composition root): publish `DEPOSIT_PORT` from DepositModule the
 * way PaymentMethodModule publishes PAYMENT_METHOD_PORT, and re-export DepositModule from
 * FeaturePortsModule. `resolveDeposits()` then collapses into `@Inject(DEPOSIT_PORT)` and this file
 * loses its only piece of magic; nothing else here changes.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { DepositStatus, PaymentRail, type Player } from '@prisma/client';
import type { Context } from 'grammy';

import { AppConfigService } from '@core/config/config.service';
import { PrismaService } from '@core/prisma/prisma.service';
import { RedisService } from '@core/cache/redis.service';
import { AdminIdentityService } from '@core/auth/services/admin-identity.service';
import { OnCallback, OnCommand } from '@core/telegram/decorators/handlers.decorator';
import {
  CALLBACK_DATA_MAX_BYTES,
  decodeCallbackData,
  encodeCallbackData,
} from '@core/telegram/utils/callback-data.util';
import { ICHANCY_PORT, type IchancyPort, isIchancyOk } from '@core/ichancy';
import { isAppException } from '@common/exceptions/app.exception';
import { formatMinorToDecimal, parseDecimalToMinor } from '@common/helpers/money.util';
import { playerActor, type Actor } from '@common/types/actor.type';

import { PlayerService } from '../services/player.service';
import { ReferralService } from '../services/referral.service';
import { PlayerRepository } from '../repositories/player.repository';
import { toPlayerView } from '../dtos/player.view';
import { PlayerErrorCodes } from '../player.constants';

const ABOUT_NAME = 'Ichancy Cashier';

/**
 * OUR callback namespace. `dep` belongs to the deposit module's ADMIN card
 * (src/modules/deposit/telegram/deposit.handlers.ts) and taps there release money — the two must
 * never share a prefix, because the registrar routes on the namespace alone.
 */
const PLAYER_DEPOSIT_NS = 'pdep';

/** Recorded on `deposit_requests.source`, the way the controller records 'miniapp'. */
const DEPOSIT_SOURCE = 'telegram:bot';

/** A phone screen, not a statement. Mirrors the take used by the admin bot's lists. */
const DEPOSIT_LIST_LIMIT = 5;

/** Provider class name looked up in the container — see the header. */
const DEPOSIT_SERVICE_PROVIDER = 'DepositService';

/** Telegram truncates silently past ~4096 characters; our static texts stay far below that. */
const TERMS_TEXT = [
  '<b>Terms of Service</b>',
  '',
  '• You must be of legal age in your jurisdiction to use this service.',
  '• Deposits are credited to your gaming account after our team verifies your payment receipt.',
  '• Always send the exact amount you declare, from an account in your own name.',
  '• A deposit reference is valid only for the request it was issued for.',
  '• We may ask for additional verification before crediting a payment.',
  '',
  'Use /paysupport if a payment needs attention.',
].join('\n');

const PAYSUPPORT_TEXT = [
  '<b>Payment support</b>',
  '',
  'If a deposit has not appeared, please have ready:',
  '• the deposit reference shown in the app,',
  '• the amount you sent,',
  '• the receipt or transaction id from your bank or wallet.',
  '',
  'Send those here and our team will look into it. Refunds and corrections are handled manually by',
  'a human — never share your password or one-time codes with anyone, including us.',
].join('\n');

/**
 * Every command this bot answers for a player, in the order a confused person needs them. Admin
 * commands are deliberately absent: AdminTelegramHandlers answers a non-admin with silence so the
 * bot cannot be used to enumerate the staff surface, and listing them here would undo that.
 */
const HELP_TEXT = [
  `<b>${ABOUT_NAME}</b> — what I can do`,
  '',
  '💰 <b>Money</b>',
  '<code>/deposit 50000</code> — start a deposit for that amount · ابدأ إيداع',
  '/methods — where you can pay from, with the limits · طرق الدفع',
  '/deposits — your last deposits and their status · إيداعاتك',
  '/balance — your gaming balance · رصيدك',
  '',
  '👤 <b>Account</b>',
  '/profile — your details and your referral code · حسابك',
  '/start — set up your account and open the cashier',
  '',
  'ℹ️ <b>Help</b>',
  '/paysupport — a payment needs attention · مشكلة بالدفع',
  '/terms — the rules · الشروط',
  '/about — is everything working right now?',
  '',
  '<i>After starting a deposit, send the receipt photo here in this chat.</i>',
].join('\n');

/** Telegram's HTML parse mode needs exactly these three escaped, and nothing else. */
function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** What a player is told each status means. Their words, not the queue's. */
const DEPOSIT_STATUS_LABEL: Readonly<Record<DepositStatus, string>> = Object.freeze({
  [DepositStatus.DRAFT]: '📝 Not sent yet',
  [DepositStatus.AWAITING_PROOF]: '📸 Waiting for your receipt',
  [DepositStatus.SUBMITTED]: '⏳ Waiting for review',
  [DepositStatus.UNDER_REVIEW]: '👀 Being reviewed',
  [DepositStatus.PENDING_SECOND_APPROVAL]: '👀 Being reviewed',
  [DepositStatus.APPROVED]: '✅ Approved',
  [DepositStatus.CREDITING]: '💸 Crediting now',
  [DepositStatus.CREDITED]: '✅ Credited',
  [DepositStatus.CREDIT_FAILED]: '⚠️ Credit failed — we are on it',
  [DepositStatus.NEEDS_RECONCILIATION]: '⚠️ A human is checking it',
  [DepositStatus.REJECTED]: '❌ Rejected',
  [DepositStatus.EXPIRED]: '⌛ Expired',
  [DepositStatus.REVERSED]: '↩️ Reversed',
});

/**
 * The slice of `payment_methods` a player is shown. MIRRORS the read model of
 * GET /v1/payment-methods (PaymentMethodService.listForPlayer + toPlayerView).
 */
interface ActiveMethod {
  id: string;
  code: string;
  displayName: string;
  currencyCode: string;
  minAmountMinor: bigint;
  maxAmountMinor: bigint;
  feeFixedMinor: bigint;
  feeBps: number;
}

// ── the money write we cannot import ────────────────────────────────────────────────────────────
//
// MUST STAY STRUCTURALLY IDENTICAL to DepositService.create in
// src/modules/deposit/services/deposit.service.ts (CreateDepositInput / CreatedDeposit). Only the
// fields this file actually passes or reads are restated; the rest of CreateDepositInput is
// optional there and is genuinely not ours to fill in from a chat message.

interface CreateDepositPortInput {
  readonly playerId: string;
  readonly paymentMethodId: string;
  readonly amountMinor: bigint;
  readonly source?: string;
  /** Persisted and UNIQUE, so a replay resolves to the SAME deposit instead of a second one. */
  readonly idempotencyKey?: string;
}

interface PortMoneyView {
  readonly minor: string;
  readonly amount: string;
  readonly currency: string;
}

interface CreatedDepositView {
  readonly shortId: string;
  readonly status: DepositStatus;
  readonly amount: PortMoneyView;
  readonly fee: PortMoneyView;
  readonly expiresAt: string;
  readonly destination: {
    readonly methodCode: string;
    readonly methodName: string;
    readonly instructions: string | null;
    readonly requiresReference: boolean;
    readonly label: string | null;
    readonly accountIdentifier: string | null;
    readonly accountHolder: string | null;
  };
}

interface DepositCreatePort {
  create(actor: Actor, input: CreateDepositPortInput): Promise<CreatedDepositView>;
}

/** Shape check before an unknown container instance is trusted with a deposit. */
function isDepositCreatePort(value: unknown): value is DepositCreatePort {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as Record<string, unknown>)['create'] === 'function';
}

/**
 * Accepts what people actually type: `50,000`, `50 000`, `٥٠٠٠٠`. Separators are dropped rather
 * than guessed at, and the Arabic decimal separator becomes a dot — everything else is left alone
 * so parseDecimalToMinor stays the single judge of what a valid amount is.
 */
function normalizeAmountInput(raw: string): string {
  let out = '';
  for (const char of raw.trim()) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    // Arabic-Indic (٠-٩) and Extended Arabic-Indic (۰-۹) digits.
    if (code >= 0x0660 && code <= 0x0669) {
      out += String.fromCodePoint(0x30 + (code - 0x0660));
      continue;
    }
    if (code >= 0x06f0 && code <= 0x06f9) {
      out += String.fromCodePoint(0x30 + (code - 0x06f0));
      continue;
    }
    // Arabic decimal separator ٫ -> '.'
    if (char === '٫') {
      out += '.';
      continue;
    }
    // Grouping: comma, underscore, space, Arabic thousands separator ٬, Arabic comma ،
    if (char === ',' || char === '_' || char === ' ' || char === '٬' || char === '،') {
      continue;
    }
    out += char;
  }
  return out;
}

/** `1500.00` from a fee in bps, without ever putting a rate through a float. */
function formatBps(bps: number): string {
  const whole = Math.floor(bps / 100);
  const fraction = (bps % 100).toString().padStart(2, '0');
  return `${whole}.${fraction}%`;
}

@Injectable()
export class PlayerTelegramHandlers {
  private readonly logger = new Logger(PlayerTelegramHandlers.name);

  /** Memoized once found; the container does not change shape after bootstrap. */
  private deposits: DepositCreatePort | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly players: PlayerService,
    private readonly playerRepo: PlayerRepository,
    private readonly referrals: ReferralService,
    private readonly config: AppConfigService,
    @Inject(ICHANCY_PORT) private readonly ichancy: IchancyPort,
    private readonly redis: RedisService,
    private readonly admins: AdminIdentityService,
    private readonly discovery: DiscoveryService,
  ) {}

  @OnCommand('start')
  async onStart(ctx: Context): Promise<void> {
    const from = ctx.from;
    if (from === undefined || from.is_bot) return;

    const playerId = await this.ensurePlayerRow(ctx);
    if (playerId === null) return;

    // `ctx.match` is whatever followed "/start". grammY types it as string | RegExpMatchArray
    // depending on how the listener was registered, so it is narrowed rather than trusted.
    const payload = typeof ctx.match === 'string' ? ctx.match : '';

    const referral = await this.referrals
      .bindFromStartPayload(playerId, BigInt(from.id), payload, 'telegram:/start')
      .catch((error: unknown) => {
        // A broken deep link must never stop someone using the bot.
        this.logger.warn(`Referral capture failed for player ${playerId}: ${describeError(error)}`);
        return null;
      });

    const greeting = [
      `Welcome${from.first_name ? `, ${from.first_name}` : ''}!`,
      '',
      'This bot is your cashier: open the app to make a deposit, and use /balance to check your',
      'gaming balance at any time.',
    ];

    if (referral?.outcome === 'BOUND') {
      greeting.push('', 'You were referred by a friend — thanks for joining through them.');
    }

    await this.reply(ctx, greeting.join('\n'), this.miniAppKeyboard());
  }

  /**
   * /help — the first thing a confused person taps, so it lists only commands that exist and says
   * what each one is FOR rather than what it is called.
   */
  @OnCommand('help')
  async onHelp(ctx: Context): Promise<void> {
    await this.reply(ctx, HELP_TEXT, this.miniAppKeyboard());
  }

  @OnCommand('balance')
  async onBalance(ctx: Context): Promise<void> {
    const from = ctx.from;
    if (from === undefined || from.is_bot) return;

    const player = await this.playerRepo.findByTelegramUserId(BigInt(from.id));
    if (player === null) {
      await this.reply(ctx, 'Please send /start first to set up your account.');
      return;
    }

    // Deliberately NOT calling PlayerLinkService: /balance must not create an Ichancy account. The
    // mirror is created just before the first credit, and a curious tap on /balance is not that.
    if (player.ichancyPlayerId === null) {
      await this.reply(
        ctx,
        'Your gaming account is created with your first deposit. Open the app to make one.',
        this.miniAppKeyboard(),
      );
      return;
    }

    const result = await this.ichancy.getPlayerBalance(player.ichancyPlayerId, {
      playerId: player.id,
    });

    if (!isIchancyOk(result)) {
      // Never guess a balance. "Unavailable" is honest; "0.00" would be a lie a player might act on.
      await this.reply(
        ctx,
        'Your balance is temporarily unavailable. Please try again in a few minutes.',
      );
      return;
    }

    const amount = formatMinorToDecimal(result.data.balanceMinor);
    await this.reply(ctx, `Your balance: <b>${amount} ${player.currencyCode}</b>`);
  }

  // ---------------------------------------------------------------------------------------------
  // /profile — mirrors GET /v1/me
  // ---------------------------------------------------------------------------------------------

  /**
   * The same two answers /v1/me returns — the profile projection and the eligibility verdict —
   * because "what is my account?" and "may I deposit right now?" are read from different sources
   * (`players.status` and `self_exclusions`) and a profile that shows only the first can say ACTIVE
   * to somebody who is self-excluded.
   *
   * The referral CODE is the player's own Telegram id, because that is the only stable handle a
   * deep link can carry: there is no referral-code column, and ReferralService parses exactly
   * `ref_<telegram id>` out of a /start payload.
   */
  @OnCommand('profile')
  async onProfile(ctx: Context): Promise<void> {
    const player = await this.requirePlayer(ctx);
    if (player === null) return;

    const view = toPlayerView(player);
    const eligibility = await this.players.checkEligibility(player.id).catch((error: unknown) => {
      this.logger.warn(`Eligibility check failed for player ${player.id}: ${describeError(error)}`);
      return null;
    });

    const name = [view.firstName, view.lastName].filter((part) => part !== null).join(' ');
    const referralCode = `ref_${view.telegramUserId}`;
    const username = this.botUsername(ctx);

    const lines = [
      '👤 <b>Your profile</b>',
      '',
      `Name: <b>${esc(name.length > 0 ? name : 'not set')}</b>`,
      view.telegramUsername === null ? null : `Username: @${esc(view.telegramUsername)}`,
      `Telegram id: <code>${esc(view.telegramUserId)}</code>`,
      `Currency: <b>${esc(view.currencyCode)}</b>`,
      `Account: <b>${esc(view.status)}</b>${eligibility === null ? '' : eligibility.eligible ? ' ✅' : ' ⛔'}`,
    ];

    if (eligibility !== null && !eligibility.eligible) {
      lines.push(this.describeIneligibility(eligibility.reason, eligibility.excludedUntil));
    }

    lines.push(
      view.ichancyLinked
        ? 'Gaming account: <b>linked ✅</b>'
        : 'Gaming account: <b>not yet</b> — it is created with your first deposit.',
      '',
      `Referral code: <code>${esc(referralCode)}</code>`,
      username === null
        ? '<i>Share your code — a friend sends it with /start.</i>'
        : `Invite link: <code>https://t.me/${esc(username)}?start=${esc(referralCode)}</code>`,
      '',
      '<i>/help for everything I can do.</i>',
    );

    await this.reply(ctx, lines.filter((line): line is string => line !== null).join('\n'));
  }

  // ---------------------------------------------------------------------------------------------
  // /methods — mirrors GET /v1/payment-methods
  // ---------------------------------------------------------------------------------------------

  @OnCommand('methods')
  async onMethods(ctx: Context): Promise<void> {
    const player = await this.requirePlayer(ctx);
    if (player === null) return;

    const methods = await this.activeMethodsFor(player.currencyCode);
    if (methods.length === 0) {
      await this.reply(
        ctx,
        [
          `No payment method is open for <b>${esc(player.currencyCode)}</b> at the moment.`,
          'لا توجد طريقة دفع متاحة حالياً.',
          '',
          'Please try again later, or use /paysupport if you were expecting one.',
        ].join('\n'),
      );
      return;
    }

    const lines = [`💳 <b>Payment methods</b> — ${esc(player.currencyCode)}`, ''];

    for (const method of methods) {
      lines.push(`• <b>${esc(method.displayName)}</b>`);
      lines.push(
        `   Limits: <code>${formatMinorToDecimal(method.minAmountMinor)}</code> – ` +
          `<code>${formatMinorToDecimal(method.maxAmountMinor)}</code> ${esc(method.currencyCode)}`,
      );
      if (method.feeFixedMinor > 0n || method.feeBps > 0) {
        const parts: string[] = [];
        if (method.feeFixedMinor > 0n) parts.push(formatMinorToDecimal(method.feeFixedMinor));
        if (method.feeBps > 0) parts.push(formatBps(method.feeBps));
        lines.push(`   Fee: ${parts.join(' + ')}`);
      }
    }

    lines.push(
      '',
      'To start, send the amount with the command:',
      '<code>/deposit 50000</code>',
      'ثم اختر طريقة الدفع وابعت صورة الإيصال هون.',
    );

    await this.reply(ctx, lines.join('\n'));
  }

  // ---------------------------------------------------------------------------------------------
  // /deposit <amount> — mirrors POST /v1/deposits
  // ---------------------------------------------------------------------------------------------

  /**
   * ONE MESSAGE IN, ONE ANSWER OUT. There is no wizard here on purpose: @grammyjs/conversations is
   * a REPLAY engine, so a multi-step flow would re-execute the money write every time the step
   * machine replayed. Everything the second half of this flow needs — the method and the amount —
   * is carried in the button's callback_data instead.
   */
  @OnCommand('deposit')
  async onDeposit(ctx: Context): Promise<void> {
    const raw = typeof ctx.match === 'string' ? ctx.match : '';
    const amountMinor = this.parseAmount(raw);
    if (amountMinor === null) {
      await this.reply(ctx, this.depositUsageText());
      return;
    }

    const player = await this.requirePlayer(ctx);
    if (player === null) return;

    // The same gate POST /v1/deposits runs inside its transaction. Checking it here as well costs
    // one indexed read and means a self-excluded player is told so instead of being handed a
    // keyboard that can only ever fail.
    const eligibility = await this.players.checkEligibility(player.id).catch(() => null);
    if (eligibility !== null && !eligibility.eligible) {
      await this.reply(
        ctx,
        [
          '⛔ <b>Deposits are closed on your account.</b>',
          '',
          this.describeIneligibility(eligibility.reason, eligibility.excludedUntil),
        ].join('\n'),
      );
      return;
    }

    const methods = await this.activeMethodsFor(player.currencyCode);
    if (methods.length === 0) {
      await this.reply(
        ctx,
        'No payment method is open right now. لا توجد طريقة دفع متاحة حالياً. Please try again later.',
      );
      return;
    }

    // Bounds are checked BEFORE anything is created: an amount no rail will take must never reach
    // the write path, and a button that can only produce a 422 is worse than no button.
    const usable = methods.filter(
      (method) => amountMinor >= method.minAmountMinor && amountMinor <= method.maxAmountMinor,
    );

    if (usable.length === 0) {
      await this.reply(ctx, this.outOfRangeText(amountMinor, methods, player.currencyCode));
      return;
    }

    const only = usable[0];
    if (usable.length === 1 && only !== undefined) {
      // Exactly one method can take this amount: asking "which one?" with a single button is a tap
      // that carries no information.
      await this.createDeposit(ctx, player, only, amountMinor, this.messageSeed(ctx));
      return;
    }

    const keyboard = this.methodKeyboard(usable, amountMinor);
    if (keyboard === null) {
      await this.reply(
        ctx,
        'Deposits cannot be started from chat right now. Please open the cashier app.',
        this.miniAppKeyboard(),
      );
      return;
    }

    await this.reply(
      ctx,
      [
        `You are depositing <b>${formatMinorToDecimal(amountMinor)} ${esc(player.currencyCode)}</b>.`,
        '',
        'Choose where you are paying from · اختر طريقة الدفع:',
      ].join('\n'),
      keyboard,
    );
  }

  /**
   * The second half of /deposit. `pdep:<paymentMethodId>:<amountMinor>` — the method is the uuid
   * rather than the code because a uuid is a fixed 36 bytes, and the 64-byte budget has to hold the
   * amount too. Nothing about the tapper is trusted: the player, the method and the bounds are all
   * re-read here, because the button may be minutes old and a method can be retired in between.
   */
  @OnCallback(PLAYER_DEPOSIT_NS)
  async onDepositMethodChosen(ctx: Context): Promise<void> {
    const query = ctx.callbackQuery;
    if (query === undefined) return;

    const decoded = decodeCallbackData(query.data);
    if (decoded === null || decoded.ns !== PLAYER_DEPOSIT_NS) {
      await this.answer(ctx, 'That button is no longer valid.');
      return;
    }

    const paymentMethodId = decoded.action;
    const rawAmount = decoded.args[0];
    if (rawAmount === undefined) {
      await this.answer(ctx, 'That button is missing its amount.');
      return;
    }

    let amountMinor: bigint;
    try {
      // BigInt('') is 0n rather than a throw, so the sign is checked as well as the parse.
      amountMinor = BigInt(rawAmount);
    } catch {
      await this.answer(ctx, 'That button is no longer valid.');
      return;
    }
    if (amountMinor <= 0n) {
      await this.answer(ctx, 'That button is no longer valid.');
      return;
    }

    const player = await this.requirePlayer(ctx);
    if (player === null) {
      await this.answer(ctx, 'Send /start first.');
      return;
    }

    const methods = await this.activeMethodsFor(player.currencyCode);
    const method = methods.find((candidate) => candidate.id === paymentMethodId);
    if (method === undefined) {
      await this.answer(ctx, 'That payment method is no longer available.', true);
      await this.reply(ctx, 'That payment method is no longer available. Send /deposit again.');
      return;
    }
    if (amountMinor < method.minAmountMinor || amountMinor > method.maxAmountMinor) {
      await this.answer(ctx, 'That amount is outside this method’s limits now.', true);
      await this.reply(ctx, this.outOfRangeText(amountMinor, [method], player.currencyCode));
      return;
    }

    await this.answer(ctx, 'Opening your deposit…');
    // The keyboard has done its job. Removing it stops a second tap turning into a second (empty)
    // deposit on a DIFFERENT method — the same-method double-tap is already absorbed by the
    // idempotency key below.
    await this.clearKeyboard(ctx);

    await this.createDeposit(ctx, player, method, amountMinor, this.callbackSeed(ctx));
  }

  // ---------------------------------------------------------------------------------------------
  // /deposits — mirrors GET /v1/deposits
  // ---------------------------------------------------------------------------------------------

  @OnCommand('deposits')
  async onDeposits(ctx: Context): Promise<void> {
    const player = await this.requirePlayer(ctx);
    if (player === null) return;

    // MIRRORS DepositRepository.listForPlayer + buildOrderBy('newest'): the id breaks ties so two
    // rows sharing a timestamp cannot swap places between two calls.
    const rows = await this.prisma.depositRequest.findMany({
      where: { playerId: player.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: DEPOSIT_LIST_LIMIT,
      select: {
        shortId: true,
        status: true,
        claimedAmountMinor: true,
        creditedAmountMinor: true,
        currencyCode: true,
        createdAt: true,
      },
    });

    if (rows.length === 0) {
      await this.reply(
        ctx,
        [
          '🧾 <b>No deposits yet.</b>',
          'ما في إيداعات لسا.',
          '',
          'Start one with <code>/deposit 50000</code> — /methods shows where you can pay from.',
        ].join('\n'),
      );
      return;
    }

    const lines = ['🧾 <b>Your last deposits</b>', '<i>newest first</i>', ''];

    for (const row of rows) {
      // The credited figure once there is one, the player's claim until then: after a partial
      // credit the number that matters to them is the one that reached their account.
      const amountMinor = row.creditedAmountMinor ?? row.claimedAmountMinor;
      lines.push(
        `<code>${esc(row.shortId)}</code> · <b>${formatMinorToDecimal(amountMinor)} ${esc(row.currencyCode)}</b>`,
        `   ${DEPOSIT_STATUS_LABEL[row.status]} · ${this.formatWhen(row.createdAt)}`,
      );
    }

    lines.push('', '<i>Send the receipt photo here to attach it to an open deposit.</i>');

    await this.reply(ctx, lines.join('\n'));
  }

  @OnCommand('terms')
  async onTerms(ctx: Context): Promise<void> {
    await this.reply(ctx, TERMS_TEXT);
  }

  /**
   * /about — the same signal as GET /health/ready, reachable from a phone.
   *
   * WHY it re-implements the checks instead of calling the endpoint: the bot runs in the WORKER
   * role, which is an application context with no HTTP server and no HealthModule. Calling our own
   * API over the network would also mean the worker reporting on the API's health, not its own —
   * the opposite of what you want when diagnosing "the bot stopped responding".
   *
   * WHY players see a verdict and admins see numbers: response times and dependency names are
   * infrastructure detail. A player needs to know whether depositing will work right now; nobody
   * else needs to learn what this service is built on.
   */
  @OnCommand('about')
  async onAbout(ctx: Context): Promise<void> {
    const [db, redis] = await Promise.all([this.checkDb(), this.checkRedis()]);
    const healthy = db.up && redis.up;

    const lines = [
      `<b>${ABOUT_NAME}</b>`,
      'Deposit cashier for your gaming account.',
      '',
      healthy
        ? '✅ <b>All systems working.</b> Deposits are open.'
        : '⚠️ <b>We have a problem.</b> Please try again in a few minutes.',
    ];

    const from = ctx.from;
    const isAdmin =
      from !== undefined && (await this.admins.isAdmin(BigInt(from.id)).catch(() => false));

    if (isAdmin) {
      lines.push(
        '',
        '<i>Admin details</i>',
        `<code>database  ${db.up ? 'up' : 'DOWN'}  ${db.ms}ms</code>`,
        `<code>redis     ${redis.up ? 'up' : 'DOWN'}  ${redis.ms}ms</code>`,
        `<code>role      ${this.config.app.role}</code>`,
        `<code>uptime    ${Math.floor(process.uptime())}s</code>`,
        // The single most important line in the whole bot: whether money is real.
        `<code>ichancy   ${this.config.ichancy.fake ? 'FAKE — no real money' : 'REAL'}</code>`,
      );
    }

    await this.reply(ctx, lines.join('\n'));
  }

  private async checkDb(): Promise<{ up: boolean; ms: number }> {
    const started = Date.now();
    const up = await this.prisma.ping().catch(() => false);
    return { up, ms: Date.now() - started };
  }

  private async checkRedis(): Promise<{ up: boolean; ms: number }> {
    const started = Date.now();
    const up = await this.redis
      .ping()
      .then((r) => r === 'PONG')
      .catch(() => false);
    return { up, ms: Date.now() - started };
  }

  /**
   * Telegram REQUIRES a bot that takes payments to answer /paysupport. It is not optional polish:
   * bots without it can be rejected during review.
   */
  @OnCommand('paysupport')
  async onPaySupport(ctx: Context): Promise<void> {
    await this.reply(ctx, PAYSUPPORT_TEXT);
  }

  // ---------------------------------------------------------------------------------------------
  // Deposit internals
  // ---------------------------------------------------------------------------------------------

  /**
   * The ONE money write in this file. Everything before it has already decided the method and the
   * amount; this only carries them across the boundary and renders the answer.
   */
  private async createDeposit(
    ctx: Context,
    player: Player,
    method: ActiveMethod,
    amountMinor: bigint,
    seed: string,
  ): Promise<void> {
    const deposits = this.resolveDeposits();
    if (deposits === null) {
      await this.reply(
        ctx,
        'Deposits cannot be started from chat right now. Please open the cashier app.',
        this.miniAppKeyboard(),
      );
      return;
    }

    try {
      const created = await deposits.create(playerActor(player.id), {
        playerId: player.id,
        paymentMethodId: method.id,
        amountMinor,
        source: DEPOSIT_SOURCE,
        // Derived from the MESSAGE this came from, never from the clock: two taps on one button
        // produce the same key, and `deposit_requests.idempotency_key` is UNIQUE, so the second one
        // resolves to the first deposit instead of opening a new one. A fresh /deposit is a fresh
        // message and therefore a fresh key.
        idempotencyKey: `telegram:${PLAYER_DEPOSIT_NS}:${seed}:${player.id}:${method.id}:${amountMinor.toString()}`,
      });

      await this.reply(ctx, this.renderCreated(created));
    } catch (cause) {
      // A business error carries a message written for the player (a cap, a cooldown, a rail rule);
      // anything else gets a generic one, because its message was written for us.
      const message = isAppException(cause)
        ? cause.message
        : 'Your deposit could not be opened right now. Please try again in a few minutes.';
      this.logger.error(
        `deposit create from Telegram failed for player ${player.id} on ${method.code}: ${describeError(cause)}`,
      );
      await this.reply(ctx, `⚠️ ${esc(message)}`);
    }
  }

  private renderCreated(created: CreatedDepositView): string {
    const destination = created.destination;

    const lines = [
      `🧾 <b>Deposit ${esc(created.shortId)}</b>`,
      '',
      `Amount: <b>${esc(created.amount.amount)} ${esc(created.amount.currency)}</b>`,
    ];

    if (created.fee.minor !== '0') {
      lines.push(`Fee: ${esc(created.fee.amount)} ${esc(created.fee.currency)}`);
    }

    lines.push('', `<b>Pay to · ادفع إلى</b>`, `Method: ${esc(destination.methodName)}`);

    if (destination.accountIdentifier !== null) {
      lines.push(`Account: <code>${esc(destination.accountIdentifier)}</code>`);
    }
    if (destination.accountHolder !== null) {
      lines.push(`Name: <b>${esc(destination.accountHolder)}</b>`);
    }
    if (destination.label !== null) {
      lines.push(`<i>${esc(destination.label)}</i>`);
    }
    if (destination.instructions !== null && destination.instructions.trim().length > 0) {
      lines.push('', esc(destination.instructions.trim()));
    }

    const expiresInMinutes = this.minutesUntil(created.expiresAt);
    if (expiresInMinutes !== null) {
      lines.push(
        '',
        `⏳ Valid for <b>${expiresInMinutes} minutes</b> — pay and send the receipt before it expires.`,
      );
    }

    lines.push(
      '',
      `📸 <b>Send the receipt photo here in this chat.</b> ابعت صورة الإيصال هون.`,
      `Quote <code>${esc(created.shortId)}</code> if your bank or wallet asks for a reference.`,
    );

    return lines.join('\n');
  }

  /**
   * One button per method, each carrying everything the callback needs.
   *
   * The byte assertion is not decoration: Telegram caps callback_data at 64 BYTES and rejects an
   * oversized button at SEND time, which would take the WHOLE message down — so an over-long
   * payload is dropped from the keyboard here, loudly, rather than silently resolving to the wrong
   * method later. Bytes, never characters: a non-ASCII character is 2-4 of them.
   */
  private methodKeyboard(
    methods: readonly ActiveMethod[],
    amountMinor: bigint,
  ): Record<string, unknown> | null {
    const rows: { text: string; callback_data: string }[][] = [];

    for (const method of methods) {
      const data = this.depositCallbackData(method, amountMinor);
      if (data === null) continue;
      rows.push([{ text: method.displayName, callback_data: data }]);
    }

    return rows.length === 0 ? null : { inline_keyboard: rows };
  }

  private depositCallbackData(method: ActiveMethod, amountMinor: bigint): string | null {
    try {
      const data = encodeCallbackData(PLAYER_DEPOSIT_NS, method.id, amountMinor.toString());
      const bytes = Buffer.byteLength(data, 'utf8');
      if (bytes > CALLBACK_DATA_MAX_BYTES) {
        this.logger.error(
          `Dropping ${method.code} from the deposit keyboard: callback data is ${bytes} bytes (max ${CALLBACK_DATA_MAX_BYTES})`,
        );
        return null;
      }
      return data;
    } catch (error: unknown) {
      // encodeCallbackData throws on a ':' inside a segment or on an over-long payload. Neither may
      // cost the player their whole keyboard.
      this.logger.error(
        `Cannot build a deposit button for ${method.code}: ${describeError(error)}`,
      );
      return null;
    }
  }

  /**
   * Locates DepositService in the container — see the header for why this is not an injection.
   * Memoized, and loud when it fails: a bot that cannot open deposits is an incident, not a typo.
   */
  private resolveDeposits(): DepositCreatePort | null {
    if (this.deposits !== null) return this.deposits;

    for (const wrapper of this.discovery.getProviders()) {
      const metatype = wrapper.metatype;
      if (typeof metatype !== 'function' || metatype.name !== DEPOSIT_SERVICE_PROVIDER) continue;

      const instance = wrapper.instance as unknown;
      if (!isDepositCreatePort(instance)) continue;

      this.deposits = instance;
      return instance;
    }

    this.logger.error(
      `${DEPOSIT_SERVICE_PROVIDER} is not in this process's DI container (or no longer exposes ` +
        `create()). /deposit is disabled until DepositModule is part of the graph.`,
    );
    return null;
  }

  /** Active methods for a currency. MIRRORS PaymentMethodService.listForPlayer. */
  private async activeMethodsFor(currencyCode: string): Promise<ActiveMethod[]> {
    return this.prisma.paymentMethod.findMany({
      where: {
        isActive: true,
        currencyCode,
        // MIRRORS the driver filter in PaymentMethodService.listForPlayer: RailDriverRegistry has a
        // driver for every rail EXCEPT INTERNAL, which exists for corrections and float top-ups and
        // has no instructions to render. Offering it would produce a payment nobody can make.
        rail: { not: PaymentRail.INTERNAL },
      },
      orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
      select: {
        id: true,
        code: true,
        displayName: true,
        currencyCode: true,
        minAmountMinor: true,
        maxAmountMinor: true,
        feeFixedMinor: true,
        feeBps: true,
      },
    });
  }

  /** null when the argument is missing, not a plain decimal, or not a positive amount. */
  private parseAmount(raw: string): bigint | null {
    const normalized = normalizeAmountInput(raw);
    if (normalized.length === 0) return null;

    try {
      const minor = parseDecimalToMinor(normalized);
      return minor > 0n ? minor : null;
    } catch {
      // MoneyError only. The player gets an example rather than a parser message.
      return null;
    }
  }

  private depositUsageText(): string {
    return [
      'Send the amount together with the command:',
      '<code>/deposit 50000</code>',
      '',
      'اكتب المبلغ بعد الأمر، مثال: <code>/deposit 50000</code>',
      '',
      '/methods shows the limits for each payment method.',
    ].join('\n');
  }

  private outOfRangeText(
    amountMinor: bigint,
    methods: readonly ActiveMethod[],
    currencyCode: string,
  ): string {
    const lines = [
      `<b>${formatMinorToDecimal(amountMinor)} ${esc(currencyCode)}</b> is outside the limits.`,
      'المبلغ خارج الحدود المسموحة.',
      '',
    ];

    for (const method of methods) {
      lines.push(
        `• ${esc(method.displayName)}: <code>${formatMinorToDecimal(method.minAmountMinor)}</code> – ` +
          `<code>${formatMinorToDecimal(method.maxAmountMinor)}</code>`,
      );
    }

    lines.push('', 'Send /deposit again with an amount inside one of those ranges.');
    return lines.join('\n');
  }

  private describeIneligibility(reason: string | null, excludedUntil: Date | null): string {
    if (reason === PlayerErrorCodes.PLAYER_SELF_EXCLUDED) {
      return excludedUntil === null
        ? 'Your account is self-excluded. Contact support if you need help.'
        : `Your account is self-excluded until ${this.formatWhen(excludedUntil)}.`;
    }
    return 'Your account cannot transact at the moment. Use /paysupport if you think this is wrong.';
  }

  /**
   * UTC, spelled out. A local time would be a guess — nothing in this service knows the player's
   * timezone — and a wrong clock on a deposit that expires is worse than an explicit one.
   */
  private formatWhen(value: Date): string {
    const iso = value.toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  }

  /** null when the timestamp cannot be read, so the caller simply omits the line. */
  private minutesUntil(isoTimestamp: string): number | null {
    const target = Date.parse(isoTimestamp);
    if (Number.isNaN(target)) return null;
    const minutes = Math.floor((target - Date.now()) / 60_000);
    return minutes > 0 ? minutes : null;
  }

  /** Identifies the /deposit MESSAGE, so a redelivery of it cannot open a second deposit. */
  private messageSeed(ctx: Context): string {
    const message = ctx.message;
    if (message === undefined) return `u${ctx.update.update_id}`;
    return `m${message.chat.id}.${message.message_id}`;
  }

  /** Identifies the KEYBOARD the button lives on, so a double-tap resolves to one deposit. */
  private callbackSeed(ctx: Context): string {
    const message = ctx.callbackQuery?.message;
    if (message === undefined) return `q${ctx.callbackQuery?.id ?? ctx.update.update_id}`;
    return `c${message.chat.id}.${message.message_id}`;
  }

  // ---------------------------------------------------------------------------------------------
  // Shared
  // ---------------------------------------------------------------------------------------------

  /**
   * The player behind an update, or null after telling them what to do. Unlike ensurePlayerRow this
   * does NOT create anything: a command other than /start should not quietly register an account.
   */
  private async requirePlayer(ctx: Context): Promise<Player | null> {
    const from = ctx.from;
    if (from === undefined || from.is_bot) return null;

    try {
      const player = await this.playerRepo.findByTelegramUserId(BigInt(from.id));
      if (player !== null) return player;
    } catch (error: unknown) {
      this.logger.error(
        `Player lookup failed for Telegram user ${from.id}: ${describeError(error)}`,
      );
      await this.reply(ctx, 'Something went wrong reading your account. Please try again.');
      return null;
    }

    await this.reply(ctx, 'Please send /start first to set up your account.');
    return null;
  }

  /** Upserts the player behind an update. Returns null when the row could not be written. */
  private async ensurePlayerRow(ctx: Context): Promise<string | null> {
    const from = ctx.from;
    if (from === undefined) return null;

    try {
      const { playerId } = await this.prisma.runInTransaction((tx) =>
        this.players.upsertFromTelegram(
          tx,
          {
            telegramUserId: BigInt(from.id),
            telegramUsername: from.username ?? null,
            firstName: from.first_name,
            lastName: from.last_name ?? null,
            languageCode: from.language_code ?? null,
          },
          this.config.ichancy.currency,
        ),
      );
      return playerId;
    } catch (error: unknown) {
      this.logger.error(
        `Failed to upsert player for Telegram user ${from.id}: ${describeError(error)}`,
      );
      await this.reply(ctx, 'Something went wrong setting up your account. Please try again.');
      return null;
    }
  }

  /**
   * A `web_app` button REQUIRES an https URL — Telegram rejects the whole message otherwise, so a
   * developer running on http://localhost would see every /start silently fail. Below https, the
   * keyboard is simply omitted.
   */
  private miniAppKeyboard(): Record<string, unknown> | undefined {
    const url = this.config.app.baseUrl;
    if (!url.startsWith('https://')) return undefined;
    return {
      inline_keyboard: [[{ text: 'Open cashier', web_app: { url } }]],
    };
  }

  /** `@username` of this bot, or null when the Bot was constructed without botInfo (getMe failed). */
  private botUsername(ctx: Context): string | null {
    try {
      const username = ctx.me.username;
      return username.length > 0 ? username : null;
    } catch {
      return null;
    }
  }

  private async answer(ctx: Context, text: string, alert = false): Promise<void> {
    try {
      await ctx.answerCallbackQuery({ text, show_alert: alert });
    } catch (error: unknown) {
      // An unanswered query only spins the client's loader; it is never worth an exception.
      this.logger.warn(`answerCallbackQuery failed: ${describeError(error)}`);
    }
  }

  private async clearKeyboard(ctx: Context): Promise<void> {
    try {
      await ctx.editMessageReplyMarkup();
    } catch (error: unknown) {
      this.logger.debug(`Could not clear the deposit keyboard: ${describeError(error)}`);
    }
  }

  private async reply(
    ctx: Context,
    text: string,
    replyMarkup?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await ctx.reply(text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(replyMarkup !== undefined ? { reply_markup: replyMarkup as never } : {}),
      });
    } catch (error: unknown) {
      // Blocked bot, deleted chat, rate limit that survived autoRetry — none of these are failures
      // of the command itself.
      this.logger.warn(`Reply failed for update ${ctx.update.update_id}: ${describeError(error)}`);
    }
  }
}
