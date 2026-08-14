/**
 * Player-facing catalogue.
 *
 * WHY the currency is read from the PLAYER row rather than taken from a query parameter: a
 * client-supplied currency would let a player pull up methods settled in a currency their liability
 * account is not denominated in, and the resulting deposit could not be posted without an FX rate
 * we do not have. The only currency that can be right is the one on their own row.
 */
import { Controller, Get, Param } from '@nestjs/common';
import { Matches } from 'class-validator';
import { Transform } from 'class-transformer';

import { PlayerAuth } from '@common/decorators/auth.decorator';
import { CurrentPlayer } from '@common/decorators/current-principal.decorator';
import { NotFoundError } from '@common/exceptions/app.exception';
import { PrismaService } from '@core/prisma/prisma.service';

import { PaymentMethodErrorCodes } from '../payment-method.constants';
import { PaymentMethodService } from '../services/payment-method.service';
import { DestinationPickerService } from '../services/destination-picker.service';
import { toDestinationView } from '../services/payment-destination.service';
import type { PaymentMethodView } from '../dtos/payment-method.dto';
import type { PaymentDestinationView } from '../dtos/payment-destination.dto';

class MethodCodeParamDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z][A-Z0-9_]{1,47}$/, { message: 'code is not a valid payment method code' })
  code: string;
}

interface MethodWithDestination {
  method: PaymentMethodView;
  /** The account this player should pay into — sticky for 24 hours. */
  destination: PaymentDestinationView;
}

@Controller('v1/payment-methods')
export class PaymentMethodController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly methods: PaymentMethodService,
    private readonly picker: DestinationPickerService,
  ) {}

  @PlayerAuth()
  @Get()
  async list(@CurrentPlayer('playerId') playerId: string): Promise<PaymentMethodView[]> {
    return this.methods.listForPlayer(await this.currencyOf(playerId));
  }

  /**
   * Method detail plus the destination assigned to this player.
   *
   * Calling this ASSIGNS a destination (and pins it for 24 hours) — it is not a pure read. That is
   * deliberate: the player is about to be shown an account to pay into, and the assignment must be
   * the same one they see if they reload the page mid-payment.
   */
  @PlayerAuth()
  @Get(':code')
  async get(
    @CurrentPlayer('playerId') playerId: string,
    @Param() params: MethodCodeParamDto,
  ): Promise<MethodWithDestination> {
    const currencyCode = await this.currencyOf(playerId);
    const method = await this.methods.getActiveByCode(params.code);

    if (method.currencyCode !== currencyCode) {
      // Same response as a code that does not exist: a player has no business learning which
      // methods exist for other currencies.
      throw new NotFoundError(
        PaymentMethodErrorCodes.PAYMENT_METHOD_NOT_FOUND,
        'That payment method does not exist.',
      );
    }

    const destination = await this.picker.pickFor(method.id, playerId);

    return {
      method: this.methods.toPlayerView(method),
      destination: toDestinationView(destination),
    };
  }

  private async currencyOf(playerId: string): Promise<string> {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      select: { currencyCode: true },
    });
    if (player === null) {
      throw new NotFoundError(
        PaymentMethodErrorCodes.PAYMENT_METHOD_NOT_FOUND,
        'That payment method does not exist.',
      );
    }
    return player.currencyCode;
  }
}
