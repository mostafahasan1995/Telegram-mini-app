/**
 * The player-facing half of the deposit spine: create, submit proof, list.
 *
 * THREE RULES THIS FILE EXISTS TO ENFORCE
 *
 * 1. NO HTTP INSIDE A TRANSACTION. Uploading a proof image talks to object storage, and object
 *    storage is a third party. So the upload happens BEFORE the transaction opens, and the
 *    transaction only ever writes rows. A transaction that can be replayed by the serialization
 *    retry helper must not contain a call that cannot be replayed.
 *
 * 2. THE OUTBOX ROW GOES IN THE SAME TRANSACTION. "A proof arrived, tell an admin" is committed by
 *    the same COMMIT that made the proof exist. Enqueuing after the commit loses the notification on
 *    a crash; enqueuing before it announces a proof that a rollback then erased.
 *
 * 3. DUPLICATE DETECTION NEVER REJECTS. It writes risk flags and lets a human decide — see
 *    enums/risk-flag.enum.ts.
 *
 * IDEMPOTENCY: `create` is guarded twice. The @Idempotent interceptor on the controller replays the
 * cached response for a repeated Idempotency-Key, and `deposit_requests.idempotency_key` is UNIQUE,
 * so even if the interceptor were bypassed the database refuses the second row. The unique violation
 * is turned back into the original deposit rather than an error: a retried POST from a phone that
 * switched networks is not a client mistake.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DepositStatus,
  PaymentRail,
  ProofSource,
  type DepositRequest,
  type PaymentDestination,
  type PaymentMethod,
  type Prisma,
} from '@prisma/client';

import {
  BusinessRuleError,
  NotFoundError,
  ValidationError,
} from '@common/exceptions/app.exception';
import { applyBps, formatMinorToDecimal } from '@common/helpers/money.util';
import { generateShortId } from '@common/helpers/short-id.util';
import type { Actor } from '@common/types/actor.type';
import { AuditService } from '@core/audit/audit.service';
import { AppConfigService } from '@core/config/config.service';
import {
  FILE_STORAGE,
  isAcceptedImageMimeType,
  normalizeImage,
  normalizedProofKey,
  type FileStorage,
  type NormalizedImage,
} from '@core/file';
import { MAX_PROOF_BYTES } from '@core/file/telegram-file.service';
import { OutboxService } from '@core/outbox/outbox.service';
import { PrismaService } from '@core/prisma/prisma.service';
import { isUniqueConstraintError, mapPrismaError } from '@core/prisma/prisma-errors';
import type { Tx } from '@core/prisma/tx.type';

import { DEPOSIT_AGGREGATE, DEPOSIT_TOPICS, MAX_PROOFS_PER_DEPOSIT } from '../deposit.constants';
import {
  DepositStateMachine,
  type TransitionInput,
  type TransitionOutcome,
} from '../deposit-state.machine';
import { DepositErrorCodes } from '../enums/deposit-error-code.enum';
import { RiskFlags, RISK_FLAG_SEVERITY, type RiskFlag } from '../enums/risk-flag.enum';
import {
  DepositRepository,
  type DepositWithReviewContext,
} from '../repositories/deposit.repository';
import {
  PAYMENT_METHOD_PORT,
  type PaymentMethodPort,
  type ResolvedDestination,
  type ResolvedPaymentMethod,
  type SubmissionCheckInput,
  type SubmissionIssue,
} from '../ports';
import { DepositPolicyService, type PolicyDecision } from './deposit-policy.service';
import { ProofDuplicateService, type DuplicateReport } from './proof-duplicate.service';
import { toDepositView, type DepositDestinationView, type DepositView } from '../dtos/deposit.view';
import { readRiskFlags } from '../utils/deposit-filter.util';

export interface CreateDepositInput {
  playerId: string;
  paymentMethodId: string;
  paymentDestinationId?: string;
  amountMinor: bigint;
  externalReference?: string;
  senderAccount?: string;
  source?: string;
  ipAddress?: string;
  userAgent?: string;
  /** The client's Idempotency-Key, persisted so a replay resolves to the same deposit. */
  idempotencyKey?: string;
}

export interface CreatedDeposit {
  shortId: string;
  status: DepositStatus;
  amount: { minor: string; amount: string; currency: string };
  fee: { minor: string; amount: string; currency: string };
  expiresAt: string;
  destination: DepositDestinationView;
}

export interface SubmitProofInput {
  playerId: string;
  shortId: string;
  image: Buffer;
  mimeType: string;
  externalReference?: string;
  senderAccount?: string;
  source?: ProofSource;
}

export interface SubmitProofResult {
  shortId: string;
  status: DepositStatus;
  proofId: string;
  /** Surfaced to the admin card, never to the player — they must not learn what we detect. */
  riskFlags: RiskFlag[];
}

/**
 * What `attachStoredProof` returns. `missing` is empty when the proof completed the submission; a
 * non-empty list means the receipt was STORED but the deposit stayed in AWAITING_PROOF because the
 * rail still wants evidence the bot cannot collect in one message — the caller must ask for it.
 */
export interface StoredProofResult extends SubmitProofResult {
  missing: readonly SubmissionIssue[];
}

/** A proof whose bytes are already in storage; the Telegram path produces this shape. */
export interface StoredProofInput {
  depositRequestId: string;
  bucket: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  source: ProofSource;
  telegramFileId?: string;
  uploadedBy: Actor;
}

const MINUTE_MS = 60_000;

/**
 * '' AND '   ' ARE ABSENCE, NOT VALUES — and this is not a nicety.
 *
 * `@IsOptional()` skips only null/undefined, so a client that serializes every optional input
 * unconditionally (the normal shape of a form: untouched field -> empty string) sends `""`. Two
 * things then go wrong if it is taken at face value:
 *
 *  - at CREATE, `""` is written to `deposit_requests.external_reference`, which is NOT NULL for the
 *    purposes of `uq_deposit_external_reference_active` (prisma/sql/004). The first player to do it
 *    on a method locks that empty string for every other player on that method, and only an
 *    explicit cancel -> REJECTED ever releases it; EXPIRED does not.
 *  - at SUBMIT, `""` overrides what the player already typed at creation and the rail then reports
 *    the field as missing — asking them for something they have already given us.
 *
 * Trimming is part of the same decision: what is stored is what the reviewer reads off the card.
 */
function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length === 0 ? null : trimmed;
}

/** Same rule, for an OPTIONAL patch field where undefined means "leave what is already there". */
function blankToUndefined(value: string | null | undefined): string | undefined {
  return blankToNull(value) ?? undefined;
}

/**
 * Rail issue codes that a deposit ALREADY ANSWERED at creation, and which can only reappear at
 * submission because an admin edited the payment method in between.
 *
 * `claimed_amount_minor` is never overwritten, so the amount presented at SUBMIT is the same amount
 * this deposit was opened with — and it was inside the bounds then. If an admin narrows min/max
 * afterwards, re-throwing here means a player who has ALREADY SENT THE MONEY cannot attach their
 * receipt at all: the deposit sits in AWAITING_PROOF until the sweeper expires it and the cash is
 * gone. So these two are logged, not thrown.
 *
 * NOTHING about the evidence itself is in this set. REFERENCE_REQUIRED, SENDER_ACCOUNT_REQUIRED,
 * PROOF_REQUIRED, REFERENCE_MALFORMED, SENDER_ACCOUNT_MALFORMED and DESTINATION_MISSING all still
 * throw at SUBMIT, exactly as before.
 */
const CONFIG_DRIFT_CODES: ReadonlySet<string> = new Set(['AMOUNT_BELOW_MINIMUM', 'AMOUNT_ABOVE_MAXIMUM']);

@Injectable()
export class DepositService {
  private readonly logger = new Logger(DepositService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deposits: DepositRepository,
    private readonly stateMachine: DepositStateMachine,
    private readonly duplicates: ProofDuplicateService,
    private readonly policy: DepositPolicyService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    // Owned by the payment-method module; reached through a string token — see ../ports.
    @Inject(PAYMENT_METHOD_PORT) private readonly payments: PaymentMethodPort,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // CREATE
  // ---------------------------------------------------------------------------------------------

  /**
   * Open a deposit and hand the player the destination to pay into.
   *
   * The policy checks (self-exclusion, caps, cooldown) run INSIDE the transaction that inserts the
   * row, because the cap is a SUM the new row participates in — checking it outside leaves a window
   * where two concurrent requests each see a compliant total.
   */
  async create(actor: Actor, input: CreateDepositInput): Promise<CreatedDeposit> {
    // Method resolution, destination rotation and the rail's own field rules all belong to the
    // payment-method module and are reached through PAYMENT_METHOD_PORT (see ../ports). Duplicating
    // any of them here would mean two answers to "is this amount allowed on this rail?".
    const method = await this.payments.getActiveById(input.paymentMethodId);
    const destination = await this.resolveDestination(input, method.id);
    // Normalized BEFORE the rail sees them and before they are stored, so a blank optional field is
    // absent everywhere — including in the partial unique index. See blankToNull.
    const reference = blankToNull(input.externalReference);
    const senderAccount = blankToNull(input.senderAccount);

    await this.assertRailAccepts({
      paymentMethodId: method.id,
      destinationId: destination.id,
      amountMinor: input.amountMinor,
      externalReference: reference,
      senderAccount,
      // No proof exists yet at creation time, and none CAN: a proof is uploaded against a deposit
      // that already has an id (DRAFT -> AWAITING_PROOF -> SUBMITTED). So this asks the CREATE
      // question — amount bounds, a destination, and the format of anything the player did type.
      // The strict question, with every required proof field, is asked in submitProof below.
      proofCount: 0,
      stage: 'CREATE',
    });

    const feeMinor = this.feeFor(method, input.amountMinor);
    const expiresAt = new Date(Date.now() + this.config.limits.depositExpiryMinutes * MINUTE_MS);

    const deposit = await this.prisma.runInTransaction(async (tx) => {
      const policy = await this.policyGate(tx, input, method.currencyCode);

      const created = await this.insertDeposit(tx, {
        input,
        method,
        destination,
        feeMinor,
        expiresAt,
        reference,
        senderAccount,
      });
      if (created.replayed) return created.deposit;

      await this.stateMachine.transition(tx, {
        depositRequestId: created.deposit.id,
        from: DepositStatus.DRAFT,
        to: DepositStatus.AWAITING_PROOF,
        actor,
        reason: 'Deposit opened by player',
        metadata: {
          paymentMethodCode: method.code,
          windowUsedMinor: policy.windowUsedMinor.toString(),
          windowCapMinor: policy.windowCapMinor?.toString() ?? null,
        },
      });

      await this.audit.write(tx, {
        action: 'deposit.create',
        actor,
        subjectType: DEPOSIT_AGGREGATE,
        subjectId: created.deposit.id,
        after: {
          shortId: created.deposit.shortId,
          paymentMethodId: method.id,
          paymentDestinationId: destination.id,
          status: DepositStatus.AWAITING_PROOF,
        },
        amountMinor: input.amountMinor,
        metadata: { source: input.source ?? null, appliedLimitId: policy.appliedLimitId },
      });

      return { ...created.deposit, status: DepositStatus.AWAITING_PROOF };
    });

    return {
      shortId: deposit.shortId,
      status: deposit.status,
      amount: {
        minor: deposit.claimedAmountMinor.toString(),
        amount: formatMinorToDecimal(deposit.claimedAmountMinor),
        currency: deposit.currencyCode,
      },
      fee: {
        minor: deposit.feeMinor.toString(),
        amount: formatMinorToDecimal(deposit.feeMinor),
        currency: deposit.currencyCode,
      },
      expiresAt: (deposit.expiresAt ?? expiresAt).toISOString(),
      destination: {
        methodCode: method.code,
        methodName: method.displayName,
        // Rendered by the rail driver, with the shortId embedded as the reference the player must
        // quote — which is why it can only be produced once the deposit exists.
        instructions: await this.payments.renderInstructions(
          method.id,
          destination.id,
          deposit.claimedAmountMinor,
          deposit.shortId,
        ),
        requiresReference: method.requiresReference,
        label: destination.label,
        accountIdentifier: destination.accountIdentifier,
        accountHolder: destination.accountHolder,
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // SUBMIT PROOF
  // ---------------------------------------------------------------------------------------------

  /**
   * Mini-app path: the bytes are already in hand, so normalization, hashing and duplicate detection
   * all happen here. Order matters and is deliberate:
   *
   *   rail SUBMIT check       (pure, no transaction)  <- the evidence gate, before any bytes move
   *   normalize + hash        (CPU, no transaction)
   *   upload to storage       (network, no transaction)  <- the only third-party call
   *   ── open transaction ──
   *   duplicate lookup, proof row, CAS to SUBMITTED, audit, outbox notify_admin
   *   ── commit ──
   *   index the perceptual hash (a cache; safe to do after the commit, and must not roll it back)
   */
  async submitProof(actor: Actor, input: SubmitProofInput): Promise<SubmitProofResult> {
    if (!isAcceptedImageMimeType(input.mimeType)) {
      throw new ValidationError(
        'That file type is not accepted as a payment proof.',
        { mimeType: input.mimeType },
        DepositErrorCodes.PROOF_MEDIA_UNSUPPORTED,
      );
    }
    if (input.image.byteLength > MAX_PROOF_BYTES) {
      throw new ValidationError(
        'That image is too large.',
        { sizeBytes: input.image.byteLength, maxBytes: MAX_PROOF_BYTES },
        DepositErrorCodes.PROOF_TOO_LARGE,
      );
    }

    const deposit = await this.requirePlayerDeposit(input.shortId, input.playerId);
    this.assertAcceptsProof(deposit);

    // A blank optional field is NOT an answer, so it must not overwrite the answer given at
    // creation. `?? ` alone would let `""` win over a stored reference and the gate below would
    // then ask for something the player already typed. See blankToNull.
    const reference = blankToUndefined(input.externalReference);
    const senderAccount = blankToUndefined(input.senderAccount);

    // THE EVIDENCE GATE. This call is the player asserting the money was sent, so every field the
    // rail requires as proof must be present now. Two details make it fair rather than merely
    // strict: a value typed at creation still counts (the player is not asked twice), and the image
    // in THIS call is a proof, so it counts toward proofCount.
    // Runs before the upload deliberately — there is no reason to push bytes to object storage for
    // a submission we are about to refuse.
    await this.assertProofComplete(deposit.shortId, {
      paymentMethodId: deposit.paymentMethodId,
      destinationId: deposit.paymentDestinationId,
      amountMinor: deposit.claimedAmountMinor,
      externalReference: reference ?? deposit.externalReference,
      senderAccount: senderAccount ?? deposit.senderAccount,
      proofCount: deposit.proofs.length + 1,
      stage: 'SUBMIT',
    });

    // Also before the upload: a reference already claimed by another live deposit on this method
    // violates uq_deposit_external_reference_active, and that violation would otherwise surface
    // from inside the transaction — AFTER the image is in the bucket, as a generic 409, leaving an
    // orphaned object behind. The unique index is still the authority (see finishSubmission); this
    // is the readable answer, given before anything is spent.
    if (reference !== undefined && reference !== deposit.externalReference) {
      await this.assertReferenceUnused(deposit.id, deposit.paymentMethodId, reference);
    }

    const normalized = await this.normalizeOrFail(input.image);
    const storageKey = normalizedProofKey(deposit.id, normalized.sha256);

    // Outside the transaction on purpose: this is the third-party call.
    const stored = await this.storage.put({
      key: storageKey,
      body: normalized.buffer,
      contentType: normalized.mimeType,
      contentLength: normalized.sizeBytes,
      metadata: { 'deposit-short-id': deposit.shortId },
    });

    const outcome = await this.prisma.runInTransaction(async (tx) => {
      const existingProofs = await this.deposits.countProofs(tx, deposit.id);
      if (existingProofs >= MAX_PROOFS_PER_DEPOSIT) {
        throw new BusinessRuleError(
          DepositErrorCodes.DEPOSIT_TOO_MANY_PROOFS,
          'This deposit already has the maximum number of proofs attached.',
          { max: MAX_PROOFS_PER_DEPOSIT },
        );
      }

      const proof = await this.insertProof(tx, {
        depositRequestId: deposit.id,
        bucket: stored.bucket,
        storageKey: stored.key,
        mimeType: normalized.mimeType,
        sizeBytes: normalized.sizeBytes,
        sha256: normalized.sha256,
        source: input.source ?? ProofSource.PLAYER_UPLOAD,
        uploadedBy: actor,
        width: normalized.width,
        height: normalized.height,
      });

      const report = await this.duplicates.findDuplicates(tx, {
        proofId: proof.id,
        depositRequestId: deposit.id,
        playerId: deposit.playerId,
        sha256: normalized.sha256,
        perceptualHash: normalized.perceptualHash,
        createdAt: proof.createdAt,
      });

      const riskFlags = await this.assessRisk(tx, deposit, report, {
        reference: reference ?? deposit.externalReference,
      });

      return this.finishSubmission(tx, {
        deposit,
        actor,
        proofId: proof.id,
        perceptualHash: normalized.perceptualHash,
        riskFlags,
        report,
        // Undefined (not '') when the player left the field alone, so the patch below leaves the
        // value typed at creation in place instead of blanking it.
        externalReference: reference,
        senderAccount,
        createdAt: proof.createdAt,
      });
    });

    // The perceptual index is a rebuildable cache; a failure here must never undo a committed proof.
    await this.duplicates.index({
      proofId: outcome.proofId,
      depositRequestId: deposit.id,
      playerId: deposit.playerId,
      sha256: normalized.sha256,
      perceptualHash: normalized.perceptualHash,
      createdAt: outcome.createdAt,
    });

    return {
      shortId: deposit.shortId,
      status: outcome.status,
      proofId: outcome.proofId,
      riskFlags: outcome.riskFlags,
    };
  }

  /**
   * Telegram path: the bytes are already in the bucket (streamed there, never buffered), so the row
   * is created with the RAW hash and a `deposit.proof_ingest` message re-normalizes it in the media
   * queue. Both paths converge on a normalized sha256 — see ProofIngestService.
   *
   * THE SUBMIT GATE RUNS HERE TOO, but it decides whether the deposit MOVES, not whether the photo
   * is kept. A message to the bot carries a picture and nothing else — no reference, no sender
   * account — and there is nowhere in a one-message interaction to ask for them. Refusing the photo
   * would throw away the player's evidence; transitioning to SUBMITTED anyway would let a chat
   * message reach the review queue without the fields the rail demands, which is precisely what the
   * gate exists to prevent, and the admin card omits null lines so a reviewer would not even see
   * the gap. So: the proof is always stored, and the deposit is submitted only when the rail is
   * satisfied. Otherwise it stays in AWAITING_PROOF and the caller is handed `missing` to ask with.
   */
  async attachStoredProof(input: StoredProofInput): Promise<StoredProofResult> {
    const deposit = await this.prisma.depositRequest.findUnique({
      where: { id: input.depositRequestId },
    });
    if (deposit === null) {
      throw new NotFoundError(DepositErrorCodes.DEPOSIT_NOT_FOUND, 'Deposit not found.');
    }
    this.assertAcceptsProof(deposit);

    // Only a deposit that has not been submitted yet can be blocked by the gate. One that is
    // already SUBMITTED/UNDER_REVIEW passed it (or was moved by an admin); an extra photo on it is
    // more evidence, and finishSubmission records it without a transition.
    const beforeSubmission =
      deposit.status === DepositStatus.DRAFT || deposit.status === DepositStatus.AWAITING_PROOF;
    const missing = beforeSubmission
      ? await this.proofGaps(
          deposit.shortId,
          this.submissionCheckFor(
            deposit,
            // This photo counts: it is the receipt image the rail is asking for.
            (await this.deposits.countProofs(this.prisma, deposit.id)) + 1,
          ),
        )
      : [];

    return this.prisma.runInTransaction(async (tx) => {
      const proof = await this.insertProof(tx, {
        depositRequestId: deposit.id,
        bucket: input.bucket,
        storageKey: input.storageKey,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        source: input.source,
        uploadedBy: input.uploadedBy,
        telegramFileId: input.telegramFileId ?? null,
        width: null,
        height: null,
      });

      // Enqueued on both branches: the bytes need normalizing and hashing whether or not this photo
      // completed the submission.
      await this.outbox.enqueue(tx, {
        aggregateType: DEPOSIT_AGGREGATE,
        aggregateId: deposit.id,
        topic: DEPOSIT_TOPICS.PROOF_INGEST,
        payload: { depositProofId: proof.id, depositRequestId: deposit.id },
        dedupeKey: `${DEPOSIT_TOPICS.PROOF_INGEST}:${proof.id}`,
      });

      if (missing.length > 0) {
        // No transition, so no admin card: an incomplete claim must not enter the review queue.
        // The proof is still recorded, and audited, because it is evidence the player produced.
        await this.audit.write(tx, {
          action: 'deposit.proof.attach',
          actor: input.uploadedBy,
          subjectType: DEPOSIT_AGGREGATE,
          subjectId: deposit.id,
          after: { proofId: proof.id, status: deposit.status },
          metadata: { missing: missing.map((issue) => issue.code), source: input.source },
        });

        return {
          shortId: deposit.shortId,
          status: deposit.status,
          proofId: proof.id,
          riskFlags: [],
          missing,
        };
      }

      const outcome = await this.finishSubmission(tx, {
        deposit,
        actor: input.uploadedBy,
        proofId: proof.id,
        perceptualHash: null,
        // Risk is assessed once the image has actually been decoded, in the media queue.
        riskFlags: [],
        report: null,
        createdAt: proof.createdAt,
      });

      return {
        shortId: deposit.shortId,
        status: outcome.status,
        proofId: proof.id,
        riskFlags: outcome.riskFlags,
        missing: [],
      };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // READ
  // ---------------------------------------------------------------------------------------------

  async listForPlayer(
    playerId: string,
    status: readonly DepositStatus[] | undefined,
    take: number,
    skip: number,
  ): Promise<{ items: DepositView[]; total: number }> {
    const { rows, total } = await this.deposits.listForPlayer(
      this.prisma,
      playerId,
      status === undefined ? {} : { status },
      take,
      skip,
    );
    const proofCounts = await this.proofCounts(rows.map((row) => row.id));
    return {
      items: rows.map((row) => toDepositView(row, { proofCount: proofCounts.get(row.id) ?? 0 })),
      total,
    };
  }

  async getForPlayer(playerId: string, shortId: string): Promise<DepositView> {
    const deposit = await this.requirePlayerDeposit(shortId, playerId);
    return toDepositView(deposit, {
      proofCount: deposit.proofs.length,
      destination: this.destinationView(deposit.paymentMethod, deposit.paymentDestination),
    });
  }

  /** A player may abandon a deposit they have not paid for yet. Anything later needs an admin. */
  async cancel(actor: Actor, playerId: string, shortId: string): Promise<DepositView> {
    const deposit = await this.requirePlayerDeposit(shortId, playerId);

    return this.prisma.runInTransaction(async (tx) => {
      const outcome = await this.stateMachine.transition(tx, {
        depositRequestId: deposit.id,
        from: [DepositStatus.DRAFT, DepositStatus.AWAITING_PROOF],
        to: DepositStatus.REJECTED,
        actor,
        reason: 'Cancelled by player',
        patch: {
          rejectionCode: 'OTHER',
          rejectionNote: 'Cancelled by player',
          decidedAt: new Date(),
        },
      });

      if (outcome.kind === 'alreadyHandled') {
        throw new BusinessRuleError(
          DepositErrorCodes.DEPOSIT_INVALID_STATE,
          'This deposit can no longer be cancelled.',
          { status: outcome.current },
        );
      }

      await this.audit.write(tx, {
        action: 'deposit.cancel',
        actor,
        subjectType: DEPOSIT_AGGREGATE,
        subjectId: deposit.id,
        before: { status: deposit.status },
        after: { status: DepositStatus.REJECTED },
      });

      return toDepositView(outcome.deposit, { proofCount: deposit.proofs.length });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // INTERNALS
  // ---------------------------------------------------------------------------------------------

  /**
   * Insert the row, treating a duplicate idempotency key as a REPLAY rather than an error.
   * `deposit_requests.idempotency_key` is UNIQUE, so this is the database serializing two concurrent
   * retries of the same POST — exactly the race the interceptor cannot see across processes.
   */
  private async insertDeposit(
    tx: Tx,
    args: {
      input: CreateDepositInput;
      method: ResolvedPaymentMethod;
      destination: ResolvedDestination;
      feeMinor: bigint;
      expiresAt: Date;
      /** Already normalized by the caller: trimmed, and null when the player supplied nothing. */
      reference: string | null;
      senderAccount: string | null;
    },
  ): Promise<{ deposit: DepositRequest; replayed: boolean }> {
    const data: Prisma.DepositRequestUncheckedCreateInput = {
      shortId: generateShortId(),
      playerId: args.input.playerId,
      paymentMethodId: args.method.id,
      paymentDestinationId: args.destination.id,
      currencyCode: args.method.currencyCode,
      claimedAmountMinor: args.input.amountMinor,
      feeMinor: args.feeMinor,
      status: DepositStatus.DRAFT,
      externalReference: args.reference,
      senderAccount: args.senderAccount,
      expiresAt: args.expiresAt,
      idempotencyKey: args.input.idempotencyKey ?? null,
      source: args.input.source ?? null,
      ipAddress: args.input.ipAddress ?? null,
      userAgent: args.input.userAgent ?? null,
    };

    try {
      return { deposit: await this.deposits.create(tx, data), replayed: false };
    } catch (cause) {
      const mapped = mapPrismaError(cause, { model: DEPOSIT_AGGREGATE, operation: 'create' });
      if (!isUniqueConstraintError(mapped)) throw mapped;

      if (args.input.idempotencyKey !== undefined) {
        const existing = await this.deposits.findByIdempotencyKey(tx, args.input.idempotencyKey);
        if (existing !== null) {
          this.logger.log(
            `deposit create replayed for idempotency key ${args.input.idempotencyKey} -> ${existing.shortId}`,
          );
          return { deposit: existing, replayed: true };
        }
      }

      // Not the idempotency key: the only other realistic collision is the partial unique index on
      // (payment_method_id, external_reference) for non-rejected rows.
      throw new BusinessRuleError(
        DepositErrorCodes.REFERENCE_ALREADY_USED,
        'That payment reference is already attached to another deposit.',
        { externalReference: args.reference },
      );
    }
  }

  private policyGate(
    tx: Tx,
    input: CreateDepositInput,
    currencyCode: string,
  ): Promise<PolicyDecision> {
    return this.policy.assertMayDeposit(tx, {
      playerId: input.playerId,
      currencyCode,
      amountMinor: input.amountMinor,
    });
  }

  private async insertProof(
    tx: Tx,
    args: {
      depositRequestId: string;
      bucket: string;
      storageKey: string;
      mimeType: string;
      sizeBytes: number;
      sha256: string;
      source: ProofSource;
      uploadedBy: Actor;
      telegramFileId?: string | null;
      width: number | null;
      height: number | null;
    },
  ) {
    try {
      return await this.deposits.createProof(tx, {
        depositRequestId: args.depositRequestId,
        source: args.source,
        bucket: args.bucket,
        storageKey: args.storageKey,
        mimeType: args.mimeType,
        sizeBytes: args.sizeBytes,
        sha256: args.sha256,
        width: args.width,
        height: args.height,
        telegramFileId: args.telegramFileId ?? null,
        uploadedByType: args.uploadedBy.type,
        uploadedById: args.uploadedBy.id,
      });
    } catch (cause) {
      const mapped = mapPrismaError(cause, { model: 'DepositProof', operation: 'create' });
      if (isUniqueConstraintError(mapped)) {
        // @@unique([depositRequestId, sha256]) — the same picture, twice, on the same deposit.
        throw new BusinessRuleError(
          DepositErrorCodes.PROOF_DUPLICATE_IN_DEPOSIT,
          'You have already attached this exact image to this deposit.',
        );
      }
      throw mapped;
    }
  }

  /**
   * The tail every submission shares: CAS to SUBMITTED, record the risk flags on that transition,
   * audit, and enqueue the admin notification IN THE SAME TRANSACTION.
   *
   * A deposit that is ALREADY submitted (a second proof on an existing submission) is not an error:
   * the CAS reports alreadyHandled and we simply refresh the card instead of posting a new one.
   */
  private async finishSubmission(
    tx: Tx,
    args: {
      deposit: DepositRequest;
      actor: Actor;
      proofId: string;
      perceptualHash: string | null;
      riskFlags: RiskFlag[];
      report: DuplicateReport | null;
      externalReference?: string;
      senderAccount?: string;
      createdAt: Date;
    },
  ): Promise<{ status: DepositStatus; proofId: string; riskFlags: RiskFlag[]; createdAt: Date }> {
    const now = new Date();
    const metadata: Record<string, unknown> = {
      proofId: args.proofId,
      riskFlags: args.riskFlags,
      // Durable copy of the perceptual hash: `deposit_proofs` has no column for it, and this row is
      // append-only, so the Redis index can always be rebuilt from Postgres.
      perceptualHash: args.perceptualHash,
      duplicateMatches:
        args.report === null
          ? null
          : args.report.matches.slice(0, 5).map((match) => ({
              depositRequestId: match.depositRequestId,
              playerId: match.playerId,
              distance: match.distance,
              kind: match.kind,
              samePlayer: match.samePlayer,
            })),
    };

    // The patch can write `external_reference`, which is covered by the partial unique index
    // uq_deposit_external_reference_active. `insertDeposit` translates that collision on the CREATE
    // path; the UPDATE here needs the same translation, or a reference already claimed by another
    // live deposit surfaces as a generic conflict with nothing pointing at the field that caused
    // it. submitProof checks this before it uploads anything — the index is what makes it a race
    // nobody can win.
    const outcome = await this.transitionOrExplainReference(tx, args.externalReference, {
      depositRequestId: args.deposit.id,
      from: [DepositStatus.DRAFT, DepositStatus.AWAITING_PROOF],
      to: DepositStatus.SUBMITTED,
      actor: args.actor,
      reason: 'Payment proof submitted',
      metadata,
      patch: {
        submittedAt: now,
        ...(args.externalReference === undefined
          ? {}
          : { externalReference: args.externalReference }),
        ...(args.senderAccount === undefined ? {} : { senderAccount: args.senderAccount }),
      },
    });

    const status = outcome.kind === 'transitioned' ? outcome.deposit.status : args.deposit.status;

    if (outcome.kind === 'alreadyHandled') {
      // Already submitted (or already decided). Record the extra proof's findings anyway — they are
      // evidence — but on their own transition-free audit row.
      await this.audit.write(tx, {
        action: 'deposit.proof.attach',
        actor: args.actor,
        subjectType: DEPOSIT_AGGREGATE,
        subjectId: args.deposit.id,
        after: { proofId: args.proofId, status: outcome.current },
        metadata,
      });
    } else {
      await this.audit.write(tx, {
        action: 'deposit.submit',
        actor: args.actor,
        subjectType: DEPOSIT_AGGREGATE,
        subjectId: args.deposit.id,
        before: { status: args.deposit.status },
        after: { status: DepositStatus.SUBMITTED, proofId: args.proofId },
        amountMinor: args.deposit.claimedAmountMinor,
        metadata,
      });
    }

    // Rule 2 in the header: the notification is committed by the same COMMIT as the proof.
    await this.outbox.enqueue(tx, {
      aggregateType: DEPOSIT_AGGREGATE,
      aggregateId: args.deposit.id,
      topic:
        outcome.kind === 'transitioned' ? DEPOSIT_TOPICS.NOTIFY_ADMIN : DEPOSIT_TOPICS.CARD_UPDATE,
      payload: {
        depositRequestId: args.deposit.id,
        shortId: args.deposit.shortId,
        riskFlags: args.riskFlags,
        reason: outcome.kind === 'transitioned' ? 'submitted' : 'additional-proof',
      },
      // One admin card per submission; an extra proof refreshes it rather than posting a second.
      dedupeKey:
        outcome.kind === 'transitioned'
          ? `${DEPOSIT_TOPICS.NOTIFY_ADMIN}:${args.deposit.id}`
          : `${DEPOSIT_TOPICS.CARD_UPDATE}:${args.proofId}`,
    });

    return { status, proofId: args.proofId, riskFlags: args.riskFlags, createdAt: args.createdAt };
  }

  /**
   * Turn evidence into flags. Ordered by severity so the admin card leads with the worst thing.
   * NOTHING here rejects — that is the whole point.
   */
  private async assessRisk(
    tx: Tx,
    deposit: DepositRequest,
    report: DuplicateReport,
    context: { reference?: string | null },
  ): Promise<RiskFlag[]> {
    const flags = new Set<RiskFlag>();

    if (report.exact && report.crossPlayer) flags.add(RiskFlags.DUPLICATE_PROOF_EXACT);
    if (report.similar && report.crossPlayer) flags.add(RiskFlags.DUPLICATE_PROOF_SIMILAR);
    if (report.matches.some((match) => match.samePlayer)) {
      flags.add(RiskFlags.DUPLICATE_PROOF_SAME_PLAYER);
    }

    if (deposit.claimedAmountMinor >= this.config.limits.dualApprovalThresholdMinor) {
      flags.add(RiskFlags.LARGE_AMOUNT);
    }

    const player = await tx.player.findUnique({
      where: { id: deposit.playerId },
      select: { createdAt: true },
    });
    if (player !== null && Date.now() - player.createdAt.getTime() < 24 * 60 * MINUTE_MS) {
      flags.add(RiskFlags.NEW_PLAYER);
    }

    if (context.reference !== null && context.reference !== undefined) {
      const others = await this.deposits.findByReference(
        tx,
        deposit.paymentMethodId,
        context.reference,
      );
      if (others.some((other) => other.id !== deposit.id)) flags.add(RiskFlags.REFERENCE_REUSED);
    }

    const recent = await tx.depositRequest.count({
      where: {
        playerId: deposit.playerId,
        submittedAt: { gte: new Date(Date.now() - 5 * MINUTE_MS) },
        id: { not: deposit.id },
      },
    });
    if (recent >= 2) flags.add(RiskFlags.RAPID_RESUBMISSION);

    return [...flags].sort((a, b) => RISK_FLAG_SEVERITY[b] - RISK_FLAG_SEVERITY[a]);
  }

  private async normalizeOrFail(image: Buffer): Promise<NormalizedImage> {
    try {
      return await normalizeImage(image);
    } catch (cause) {
      throw new ValidationError(
        'That image could not be read. Please upload a clear photo or screenshot.',
        { reason: cause instanceof Error ? cause.message : String(cause) },
        DepositErrorCodes.PROOF_UNREADABLE,
      );
    }
  }

  private async requirePlayerDeposit(
    shortId: string,
    playerId: string,
  ): Promise<DepositWithReviewContext> {
    const deposit = await this.deposits.findByShortIdForPlayer(this.prisma, shortId, playerId);
    if (deposit === null) {
      throw new NotFoundError(DepositErrorCodes.DEPOSIT_NOT_FOUND, 'Deposit not found.');
    }
    return deposit;
  }

  private assertAcceptsProof(deposit: DepositRequest): void {
    if (
      deposit.status !== DepositStatus.DRAFT &&
      deposit.status !== DepositStatus.AWAITING_PROOF &&
      deposit.status !== DepositStatus.SUBMITTED &&
      deposit.status !== DepositStatus.UNDER_REVIEW
    ) {
      throw new BusinessRuleError(
        DepositErrorCodes.DEPOSIT_INVALID_STATE,
        'This deposit is no longer accepting proof.',
        { status: deposit.status },
      );
    }
    // Expiry only bites BEFORE submission. A deposit that is already in the review queue has been
    // paid for; letting a TTL void it would destroy a player's money on a clock.
    const beforeSubmission =
      deposit.status === DepositStatus.DRAFT || deposit.status === DepositStatus.AWAITING_PROOF;
    if (beforeSubmission && deposit.expiresAt !== null && deposit.expiresAt < new Date()) {
      throw new BusinessRuleError(
        DepositErrorCodes.DEPOSIT_EXPIRED,
        'This deposit has expired. Please start a new one.',
        { expiredAt: deposit.expiresAt.toISOString() },
      );
    }
  }

  /**
   * A destination the client explicitly asked for is still routed through the port, so it goes
   * through the same activity and ownership checks as a rotated one. Without an explicit choice the
   * port rotates (sticky per player for 24h, weighted otherwise), which is deliberately NOT
   * reimplemented here — spreading volume across accounts is the payment module's job.
   */
  private async resolveDestination(
    input: CreateDepositInput,
    paymentMethodId: string,
  ): Promise<ResolvedDestination> {
    const picked = await this.payments.pickDestination(paymentMethodId, input.playerId);
    if (input.paymentDestinationId === undefined || input.paymentDestinationId === picked.id) {
      return picked;
    }
    // The client named a different one. Honour it only if the rotation would have been willing to
    // use it at all; otherwise the client is choosing an inactive or foreign account.
    throw new BusinessRuleError(
      DepositErrorCodes.PAYMENT_DESTINATION_UNAVAILABLE,
      'That payment destination is not the one assigned to you right now.',
      { assignedDestinationId: picked.id },
    );
  }

  /**
   * Rail-specific field rules (amount bounds, reference format, required proofs) live in the port.
   * `input.stage` says WHICH rules: 'CREATE' for opening an intent, 'SUBMIT' for completed proof.
   * The port defaults to 'SUBMIT' when it is omitted, so a forgotten stage fails closed.
   */
  private async assertRailAccepts(input: SubmissionCheckInput): Promise<void> {
    const check = await this.payments.checkSubmission(input);
    if (check.ok) return;
    this.throwRailIssues(check.issues);
  }

  /**
   * The SUBMIT gate for a deposit that ALREADY EXISTS, and the only caller allowed to soften an
   * issue — for exactly the two codes in CONFIG_DRIFT_CODES, and never for an evidence rule.
   *
   * Everything the rail requires as proof is thrown here, unweakened. What is NOT thrown is an
   * amount bound that this deposit already satisfied at creation and that an admin has since moved:
   * `claimed_amount_minor` is never rewritten, the player has already sent that money, and refusing
   * their receipt over an edit made afterwards strands the payment until the sweeper expires it.
   */
  private async assertProofComplete(
    depositLabel: string,
    input: SubmissionCheckInput,
  ): Promise<void> {
    const blocking = await this.proofGaps(depositLabel, input);
    if (blocking.length > 0) this.throwRailIssues(blocking);
  }

  /**
   * Asks the rail the SUBMIT question about an existing deposit and returns what is still missing,
   * with config drift filtered out and logged (see CONFIG_DRIFT_CODES). An empty array means the
   * evidence is complete.
   */
  private async proofGaps(
    depositLabel: string,
    input: SubmissionCheckInput,
  ): Promise<readonly SubmissionIssue[]> {
    const check = await this.payments.checkSubmission({ ...input, stage: 'SUBMIT' });
    if (check.ok) return [];

    const drifted = check.issues.filter((issue) => CONFIG_DRIFT_CODES.has(issue.code));
    if (drifted.length > 0) {
      // Loud, because it means an admin edit is being ignored for this deposit. Silent tolerance is
      // how a rule quietly stops existing.
      this.logger.warn(
        `deposit ${depositLabel}: payment method config moved after creation, tolerating [${drifted
          .map((issue) => issue.code)
          .join(', ')}] at submission`,
      );
    }
    return check.issues.filter((issue) => !CONFIG_DRIFT_CODES.has(issue.code));
  }

  /** The SUBMIT question as it stands for a deposit row, using only what is stored on it. */
  private submissionCheckFor(deposit: DepositRequest, proofCount: number): SubmissionCheckInput {
    return {
      paymentMethodId: deposit.paymentMethodId,
      destinationId: deposit.paymentDestinationId,
      amountMinor: deposit.claimedAmountMinor,
      externalReference: deposit.externalReference,
      senderAccount: deposit.senderAccount,
      proofCount,
      stage: 'SUBMIT',
    };
  }

  /**
   * The CAS, with the one database constraint this patch can violate translated back into the
   * error the player needs to read. Anything else is rethrown untouched.
   */
  private async transitionOrExplainReference(
    tx: Tx,
    reference: string | undefined,
    input: TransitionInput,
  ): Promise<TransitionOutcome> {
    try {
      return await this.stateMachine.transition(tx, input);
    } catch (cause) {
      const mapped = mapPrismaError(cause, { model: DEPOSIT_AGGREGATE, operation: 'update' });
      if (reference !== undefined && isUniqueConstraintError(mapped)) {
        throw new BusinessRuleError(
          DepositErrorCodes.REFERENCE_ALREADY_USED,
          'That payment reference is already attached to another deposit.',
          { externalReference: reference },
        );
      }
      throw mapped;
    }
  }

  private throwRailIssues(issues: readonly SubmissionIssue[]): never {
    const first = issues[0];
    throw new ValidationError(
      first?.message ?? 'This payment cannot be submitted as entered.',
      { issues },
      first?.code ?? DepositErrorCodes.REFERENCE_MALFORMED,
    );
  }

  /**
   * The friendly half of uq_deposit_external_reference_active. The index is what actually enforces
   * it (a race cannot slip past a unique index); this exists so the common case is answered with
   * "that reference is already attached to another deposit" instead of a generic conflict, and
   * before an image has been pushed to object storage.
   */
  private async assertReferenceUnused(
    depositRequestId: string,
    paymentMethodId: string,
    reference: string,
  ): Promise<void> {
    const others = await this.deposits.findByReference(this.prisma, paymentMethodId, reference);
    if (others.some((other) => other.id !== depositRequestId)) {
      throw new BusinessRuleError(
        DepositErrorCodes.REFERENCE_ALREADY_USED,
        'That payment reference is already attached to another deposit.',
        { externalReference: reference },
      );
    }
  }

  /** fixed + bps of the claim, rounded HALF_UP. Fees are computed once and stored on the row. */
  private feeFor(method: ResolvedPaymentMethod, amountMinor: bigint): bigint {
    if (method.rail === PaymentRail.INTERNAL) return 0n;
    return method.feeFixedMinor + applyBps(amountMinor, method.feeBps);
  }

  /** Read model for a deposit that already exists; instructions come from the stored method row. */
  private destinationView(
    method: Pick<PaymentMethod, 'code' | 'displayName' | 'instructions' | 'requiresReference'>,
    destination: Pick<PaymentDestination, 'label' | 'accountIdentifier' | 'accountHolder'> | null,
  ): DepositDestinationView {
    return {
      methodCode: method.code,
      methodName: method.displayName,
      instructions: method.instructions,
      requiresReference: method.requiresReference,
      label: destination?.label ?? null,
      accountIdentifier: destination?.accountIdentifier ?? null,
      accountHolder: destination?.accountHolder ?? null,
    };
  }

  private async proofCounts(depositIds: readonly string[]): Promise<Map<string, number>> {
    if (depositIds.length === 0) return new Map();
    const grouped = await this.prisma.depositProof.groupBy({
      by: ['depositRequestId'],
      where: { depositRequestId: { in: [...depositIds] } },
      _count: { _all: true },
    });
    return new Map(grouped.map((row) => [row.depositRequestId, row._count._all]));
  }

  /** Risk flags recorded on the newest transition that carried them. */
  async riskFlagsFor(tx: Tx, depositRequestId: string): Promise<RiskFlag[]> {
    const rows = await this.deposits.findTransitionsWithMetadata(tx, depositRequestId);
    for (const row of rows) {
      const flags = readRiskFlags(row.metadata);
      if (flags.length > 0) return flags;
    }
    return [];
  }
}
