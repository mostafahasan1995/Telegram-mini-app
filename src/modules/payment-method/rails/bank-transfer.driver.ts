/**
 * Bank transfer. The rail with the strongest paper trail and the slowest settlement — a transfer
 * can be "sent" hours before it lands, which is why the reference AND the sender account are both
 * required: they are what lets a human match a statement line to this request.
 */
import { Injectable } from '@nestjs/common';
import type { PaymentRail } from '@prisma/client';

import { ManualRailDriver } from './manual-rail.driver';
import type { RailInstructionInput, RailProofField } from './rail.interface';

@Injectable()
export class BankTransferDriver extends ManualRailDriver {
  readonly key: PaymentRail = 'BANK_TRANSFER';

  readonly requiredProofFields: readonly RailProofField[] = Object.freeze([
    'REFERENCE',
    'SENDER_ACCOUNT',
    'SENDER_NAME',
    'RECEIPT_IMAGE',
  ] as RailProofField[]);

  protected destinationLines(input: RailInstructionInput): string[] {
    const destination = input.destination;
    if (destination === null) return ['', 'No bank account is available right now.'];

    const lines = [
      '',
      `Bank: ${destination.label}`,
      `Account: <code>${destination.accountIdentifier}</code>`,
    ];
    if (destination.accountHolder !== null)
      lines.push(`Account name: ${destination.accountHolder}`);
    if (destination.notes !== null) lines.push(destination.notes);
    return lines;
  }

  protected override warningLines(_input: RailInstructionInput): string[] {
    return [
      'Send from an account in your own name — third-party transfers cannot be credited and have',
      'to be returned.',
    ];
  }
}
