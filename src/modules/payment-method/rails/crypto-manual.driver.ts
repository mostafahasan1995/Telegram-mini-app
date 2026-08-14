/**
 * Crypto, verified by hand in v1.
 *
 * WHY this is MANUAL even though a blockchain is the one rail that could be checked automatically:
 * doing it properly means running or trusting a node, deciding a confirmation depth, handling
 * re-orgs, and mapping a token contract to our currency. Each of those is a way to credit money
 * that never arrived. Until that work is done, `tryAutoVerify` returns null like every other rail —
 * and the deposit is credited only after a human has looked at the explorer.
 *
 * WHY NETWORK is a required field: the same address string can exist on several chains, and a
 * transfer on the wrong one is unrecoverable. Knowing which chain the player used is what makes the
 * hash checkable at all.
 */
import { Injectable } from '@nestjs/common';
import type { PaymentRail } from '@prisma/client';

import { ManualRailDriver } from './manual-rail.driver';
import type { RailInstructionInput, RailProofField } from './rail.interface';

@Injectable()
export class CryptoManualDriver extends ManualRailDriver {
  readonly key: PaymentRail = 'CRYPTO';

  readonly requiredProofFields: readonly RailProofField[] = Object.freeze([
    'TX_HASH',
    'NETWORK',
    'SENDER_ACCOUNT',
    'RECEIPT_IMAGE',
  ] as RailProofField[]);

  protected destinationLines(input: RailInstructionInput): string[] {
    const destination = input.destination;
    if (destination === null) return ['', 'No deposit address is available right now.'];

    const lines = [
      '',
      `Network: ${destination.label}`,
      `Address: <code>${destination.accountIdentifier}</code>`,
    ];
    if (destination.notes !== null) lines.push(destination.notes);
    return lines;
  }

  protected override warningLines(_input: RailInstructionInput): string[] {
    return [
      'Send only on the network shown above. A transfer on a different network cannot be recovered',
      'by anyone, including us.',
    ];
  }
}
