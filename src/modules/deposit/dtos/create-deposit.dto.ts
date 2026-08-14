/**
 * WHY the amount is a MoneyDto and not a number: `{"amount": 10.07}` has already lost precision by
 * the time JSON.parse returns. `toMinor()` is the only sanctioned door into bigint minor units.
 *
 * WHY there is no `currencyCode` override here: this product is single-currency (NSP, frozen at
 * seed) and the payment method already declares its currency. Accepting one from the client would
 * create a path where a deposit's currency disagrees with its rail's.
 */
import { Type } from 'class-transformer';
import { IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';

import { MoneyDto } from '@common/dtos/money.dto';

export class CreateDepositDto {
  @IsUUID('4', { message: 'paymentMethodId must be a uuid' })
  paymentMethodId: string;

  /** Optional: the mini-app may let a player pick a destination, otherwise we rotate one in. */
  @IsOptional()
  @IsUUID('4', { message: 'paymentDestinationId must be a uuid' })
  paymentDestinationId?: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  amount: MoneyDto;

  /** The rail's own reference, when the payment method requires one. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  externalReference?: string;

  /** Account/number the player says they paid FROM; used to spot mismatched senders. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  senderAccount?: string;

  /** Where the request came from ("miniapp", "bot"). Recorded, never trusted. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  source?: string;
}
