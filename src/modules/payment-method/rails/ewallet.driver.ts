/**
 * Mobile money / e-wallet (Syriatel Cash, MTN Cash and friends).
 *
 * WHY the sending number matters more here than on any other rail: a wallet transfer is
 * irreversible and near-instant, and the ONLY identity attached to it is the sending MSISDN. If a
 * player mistypes it we cannot tie their payment to their account, and the money sits in suspense.
 */
import { Injectable } from '@nestjs/common';
import type { PaymentRail } from '@prisma/client';

import { ManualRailDriver } from './manual-rail.driver';
import type { RailInstructionInput, RailProofField } from './rail.interface';

@Injectable()
export class EwalletDriver extends ManualRailDriver {
  readonly key: PaymentRail = 'MOBILE_WALLET';

  readonly requiredProofFields: readonly RailProofField[] = Object.freeze([
    'REFERENCE',
    'SENDER_ACCOUNT',
    'RECEIPT_IMAGE',
  ] as RailProofField[]);

  protected destinationLines(input: RailInstructionInput): string[] {
    const destination = input.destination;
    if (destination === null) return ['', 'No wallet number is available right now.'];

    const lines = [
      '',
      `Wallet: ${destination.label}`,
      `Send to: <code>${destination.accountIdentifier}</code>`,
    ];
    if (destination.accountHolder !== null)
      lines.push(`Registered to: ${destination.accountHolder}`);
    if (destination.notes !== null) lines.push(destination.notes);
    return lines;
  }

  protected override warningLines(_input: RailInstructionInput): string[] {
    return [
      'Enter the number you sent FROM exactly as it appears on your receipt — it is how we identify',
      'your payment.',
    ];
  }
}
