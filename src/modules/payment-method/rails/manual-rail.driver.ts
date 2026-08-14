/**
 * Shared behaviour for every v1 rail. All four are MANUAL: a human reads the proof.
 *
 * WHY validation is staged (see RailStage in rail.interface.ts): the rules that make a submission
 * COMPLETE and the rules that make an intent OPENABLE are different rules. A receipt image is
 * uploaded after the deposit exists, so demanding one at creation is unsatisfiable by construction.
 * The split is required-ness only: every FORMAT rule (length bounds, the ReDoS guard, the
 * operator-configured pattern), the amount bounds and the destination check run identically at both
 * stages, and every proof field this driver CAN see — REFERENCE, SENDER_ACCOUNT, RECEIPT_IMAGE —
 * is still enforced at SUBMIT.
 *
 * What this driver cannot enforce, said plainly rather than implied away: `requiredProofFields` may
 * also list SENDER_NAME, TX_HASH and NETWORK, and `RailSubmission` carries no field for any of
 * them, so they are checked by the reviewing human and by nothing here — at either stage. That is
 * how it behaved before the stage split too; see the LIMIT note in rail.interface.ts.
 *
 * WHY the reference regex is length-bounded before it is tested, and compiled defensively:
 * `referencePattern` is free text an ADMIN types into a form, and it is then run against a string a
 * PLAYER controls. That is the exact shape of a ReDoS: a pattern like `(a+)+$` against a long input
 * pins the event loop of a single-threaded process — and Node has no regex timeout. Two cheap
 * guards make it a non-issue: refuse absurd input lengths before matching at all, and treat an
 * uncompilable pattern as "no pattern" instead of throwing a 500 into the deposit flow.
 *
 * WHY `tryAutoVerify` is not `async`: with `async` and no `await`, eslint's require-await rule fires
 * and the honest fix is to say what we mean — this returns an already-resolved null, it never waits
 * for anything.
 */
import { formatMinorToDecimal } from '@common/helpers/money.util';

import {
  RailIssueCodes,
  type RailAutoVerification,
  type RailDriver,
  type RailInstructionInput,
  type RailProofField,
  type RailStage,
  type RailSubmission,
  type RailValidation,
  type RailValidationIssue,
} from './rail.interface';

/**
 * Longer than any real bank reference or tx hash (a Bitcoin txid is 64 chars, an IBAN 34). Anything
 * past this is not a reference, and refusing it before the regex runs is what makes the regex safe.
 */
const MAX_REFERENCE_LENGTH = 128;
const MAX_SENDER_ACCOUNT_LENGTH = 128;

export abstract class ManualRailDriver implements RailDriver {
  abstract readonly key: RailDriver['key'];
  abstract readonly requiredProofFields: readonly RailProofField[];

  /** Rail-specific lines describing WHERE to send the money. */
  protected abstract destinationLines(input: RailInstructionInput): string[];

  /** Rail-specific closing warnings. Empty by default. */
  protected warningLines(_input: RailInstructionInput): string[] {
    return [];
  }

  validateSubmission(submission: RailSubmission): RailValidation {
    const issues: RailValidationIssue[] = [];
    const { method, amountMinor } = submission;
    // FAIL CLOSED, and closed against MORE than an omitted argument. Testing for the permissive
    // stage (rather than `=== 'SUBMIT'`) means an undefined, a null, or a string that got past the
    // type system at a JSON boundary all land on the strict path: only a literal 'CREATE' turns
    // required-ness off, and it has to be asked for out loud.
    const stage: RailStage | undefined = submission.stage;
    const proofIsDue = stage !== 'CREATE';

    if (amountMinor <= 0n) {
      issues.push({
        field: 'amount',
        code: RailIssueCodes.AMOUNT_NOT_POSITIVE,
        message: 'The amount must be greater than zero.',
      });
    } else {
      if (amountMinor < method.minAmountMinor) {
        issues.push({
          field: 'amount',
          code: RailIssueCodes.AMOUNT_BELOW_MINIMUM,
          message: `The minimum for ${method.displayName} is ${formatMinorToDecimal(
            method.minAmountMinor,
          )} ${method.currencyCode}.`,
        });
      }
      if (amountMinor > method.maxAmountMinor) {
        issues.push({
          field: 'amount',
          code: RailIssueCodes.AMOUNT_ABOVE_MAXIMUM,
          message: `The maximum for ${method.displayName} is ${formatMinorToDecimal(
            method.maxAmountMinor,
          )} ${method.currencyCode}.`,
        });
      }
    }

    if (submission.destination === null) {
      issues.push({
        field: 'destination',
        code: RailIssueCodes.DESTINATION_MISSING,
        message: 'No payment destination is available for this method right now.',
      });
    }

    issues.push(...this.validateReference(submission, proofIsDue));

    if (this.requiredProofFields.includes('SENDER_ACCOUNT')) {
      const sender = submission.senderAccount?.trim() ?? '';
      if (sender.length === 0) {
        // Missing is only a problem once the player claims to have paid; at CREATE they have not
        // seen their receipt yet.
        if (proofIsDue) {
          issues.push({
            field: 'senderAccount',
            code: RailIssueCodes.SENDER_ACCOUNT_REQUIRED,
            message: 'Please tell us which account or number you sent from.',
          });
        }
      } else if (sender.length > MAX_SENDER_ACCOUNT_LENGTH) {
        // A value that WAS supplied must be well-formed at both stages: storing a 10KB "account
        // number" on the deposit row and only noticing at submission helps nobody. The code says
        // MALFORMED, not REQUIRED — the player supplied one, and a client that renders the code
        // would otherwise ask them for the thing they just gave us.
        issues.push({
          field: 'senderAccount',
          code: RailIssueCodes.SENDER_ACCOUNT_MALFORMED,
          message: 'That sender account is too long.',
        });
      }
    }

    if (
      proofIsDue &&
      this.requiredProofFields.includes('RECEIPT_IMAGE') &&
      submission.proofCount < 1
    ) {
      issues.push({
        field: 'proof',
        code: RailIssueCodes.PROOF_REQUIRED,
        message: 'Please attach a photo of your payment receipt.',
      });
    }

    return issues.length === 0 ? { ok: true } : { ok: false, issues };
  }

  /**
   * Every v1 rail is verified by a human, so this is always null. It is not a stub: null is the
   * value the deposit flow is written to handle, and a rail that gains automation later changes
   * only its own file.
   */
  tryAutoVerify(_submission: RailSubmission): Promise<RailAutoVerification | null> {
    return Promise.resolve(null);
  }

  renderInstructions(input: RailInstructionInput): string {
    const { method, amountMinor, shortId } = input;
    const amount = `${formatMinorToDecimal(amountMinor)} ${method.currencyCode}`;

    const lines: string[] = [
      `<b>${method.displayName}</b>`,
      '',
      `Amount to send: <b>${amount}</b>`,
      ...this.destinationLines(input),
      '',
      `Payment reference: <code>${shortId}</code>`,
      'Include that reference with your payment if the form allows it — it is how we match your',
      'transfer to this request.',
    ];

    // Operator-authored copy goes last so it can add to, but never silently replace, the
    // machine-generated destination details above.
    if (method.instructions !== null && method.instructions.trim().length > 0) {
      lines.push('', method.instructions.trim());
    }

    const warnings = this.warningLines(input);
    if (warnings.length > 0) lines.push('', ...warnings);

    lines.push('', 'After paying, upload your receipt in the app so our team can verify it.');
    return lines.join('\n');
  }

  /**
   * `proofIsDue` is the ONLY thing the stage changes here: an absent reference is an issue at
   * SUBMIT, and merely not-yet-supplied at CREATE. A reference that IS present is checked exactly
   * the same way at both stages — including the length bound that makes the regex safe.
   */
  private validateReference(
    submission: RailSubmission,
    proofIsDue: boolean,
  ): RailValidationIssue[] {
    const { method } = submission;
    const needsReference =
      method.requiresReference || this.requiredProofFields.includes('REFERENCE');

    const raw = submission.externalReference?.trim() ?? '';

    if (raw.length === 0) {
      return needsReference && proofIsDue
        ? [
            {
              field: 'externalReference',
              code: RailIssueCodes.REFERENCE_REQUIRED,
              message: 'Please enter the reference number shown on your payment receipt.',
            },
          ]
        : [];
    }

    // Bound BEFORE matching — this is the ReDoS guard, not a cosmetic limit.
    if (raw.length > MAX_REFERENCE_LENGTH) {
      return [
        {
          field: 'externalReference',
          code: RailIssueCodes.REFERENCE_MALFORMED,
          message: 'That reference is too long to be valid.',
        },
      ];
    }

    const pattern = this.compilePattern(method.referencePattern);
    if (pattern !== null && !pattern.test(raw)) {
      return [
        {
          field: 'externalReference',
          code: RailIssueCodes.REFERENCE_MALFORMED,
          message: 'That reference does not look like a valid one for this payment method.',
        },
      ];
    }

    return [];
  }

  /** An admin's typo in a regex must fail the CONFIG, not every player's deposit. */
  private compilePattern(pattern: string | null): RegExp | null {
    if (pattern === null || pattern.trim().length === 0) return null;
    try {
      return new RegExp(pattern);
    } catch {
      return null;
    }
  }
}
