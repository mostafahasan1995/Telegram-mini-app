/**
 * Cash paid over the counter at an agent/office.
 *
 * WHY no sender account is required: there isn't one. Cash has no originating account, so the only
 * evidence is the office's own receipt number plus the physical slip. That makes the receipt IMAGE
 * non-negotiable here — on every other rail it corroborates a digital trail, on this one it IS the
 * trail.
 */
import { Injectable } from '@nestjs/common';
import type { PaymentRail } from '@prisma/client';

import { ManualRailDriver } from './manual-rail.driver';
import type { RailInstructionInput, RailProofField } from './rail.interface';

@Injectable()
export class CashAgentDriver extends ManualRailDriver {
  readonly key: PaymentRail = 'CASH_OFFICE';

  readonly requiredProofFields: readonly RailProofField[] = Object.freeze([
    'REFERENCE',
    'RECEIPT_IMAGE',
  ] as RailProofField[]);

  protected destinationLines(input: RailInstructionInput): string[] {
    const destination = input.destination;
    if (destination === null) return ['', 'No cash office is available right now.'];

    const lines = [
      '',
      `Office: ${destination.label}`,
      `Reference code: <code>${destination.accountIdentifier}</code>`,
    ];
    if (destination.accountHolder !== null) lines.push(`Ask for: ${destination.accountHolder}`);
    if (destination.notes !== null) lines.push(destination.notes);
    return lines;
  }

  protected override warningLines(_input: RailInstructionInput): string[] {
    return [
      'Keep your paper receipt until the deposit appears in your balance — it is the only proof a',
      'cash payment was made.',
    ];
  }
}
