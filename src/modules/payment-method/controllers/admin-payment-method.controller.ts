/**
 * Staff configuration of methods and destinations.
 *
 * WHY reads are open to SUPPORT and REVIEWER but writes are not: support staff need to see which
 * account a player was told to pay into in order to answer "where did my money go?". Changing that
 * routing moves real money and stays with the roles that own the float.
 *
 * WHY DELETE deactivates: both tables are referenced by historical deposits with onDelete:
 * Restrict. A real delete would be refused by the database or would destroy the trail explaining
 * where a past payment was sent.
 */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsBooleanString, IsOptional, IsUUID } from 'class-validator';

import { AdminAuth } from '@common/decorators/auth.decorator';
import { CurrentAdmin } from '@common/decorators/current-principal.decorator';
import { IdParamDto } from '@common/dtos/id-param.dto';

import {
  PAYMENT_METHOD_MANAGER_ROLES,
  PAYMENT_METHOD_READER_ROLES,
} from '../payment-method.constants';
import {
  CreatePaymentMethodDto,
  ListPaymentMethodsQueryDto,
  UpdatePaymentMethodDto,
  type AdminPaymentMethodView,
} from '../dtos/payment-method.dto';
import {
  CreatePaymentDestinationDto,
  UpdatePaymentDestinationDto,
  type AdminPaymentDestinationView,
} from '../dtos/payment-destination.dto';
import { PaymentMethodService } from '../services/payment-method.service';
import { PaymentDestinationService } from '../services/payment-destination.service';

class ListDestinationsQueryDto {
  /** Query values are strings; the service takes a boolean. */
  @IsOptional()
  @IsBooleanString()
  includeInactive?: string;
}

class MethodIdParamDto {
  @IsUUID(undefined, { message: 'id must be a UUID' })
  id: string;
}

@Controller('v1/admin')
export class AdminPaymentMethodController {
  constructor(
    private readonly methods: PaymentMethodService,
    private readonly destinations: PaymentDestinationService,
  ) {}

  // ---- methods --------------------------------------------------------------

  @AdminAuth(...PAYMENT_METHOD_READER_ROLES)
  @Get('payment-methods')
  list(@Query() query: ListPaymentMethodsQueryDto): Promise<AdminPaymentMethodView[]> {
    return this.methods.listForAdmin(query);
  }

  @AdminAuth(...PAYMENT_METHOD_READER_ROLES)
  @Get('payment-methods/:id')
  get(@Param() params: MethodIdParamDto): Promise<AdminPaymentMethodView> {
    return this.methods.getForAdmin(params.id);
  }

  @AdminAuth(...PAYMENT_METHOD_MANAGER_ROLES)
  @Post('payment-methods')
  create(
    @CurrentAdmin('adminUserId') actorAdminId: string,
    @Body() body: CreatePaymentMethodDto,
  ): Promise<AdminPaymentMethodView> {
    return this.methods.create(actorAdminId, body);
  }

  @AdminAuth(...PAYMENT_METHOD_MANAGER_ROLES)
  @Patch('payment-methods/:id')
  update(
    @CurrentAdmin('adminUserId') actorAdminId: string,
    @Param() params: MethodIdParamDto,
    @Body() body: UpdatePaymentMethodDto,
  ): Promise<AdminPaymentMethodView> {
    return this.methods.update(actorAdminId, params.id, body);
  }

  @AdminAuth(...PAYMENT_METHOD_MANAGER_ROLES)
  @Delete('payment-methods/:id')
  deactivate(
    @CurrentAdmin('adminUserId') actorAdminId: string,
    @Param() params: MethodIdParamDto,
  ): Promise<AdminPaymentMethodView> {
    return this.methods.deactivate(actorAdminId, params.id);
  }

  // ---- destinations ---------------------------------------------------------

  @AdminAuth(...PAYMENT_METHOD_READER_ROLES)
  @Get('payment-methods/:id/destinations')
  listDestinations(
    @Param() params: MethodIdParamDto,
    @Query() query: ListDestinationsQueryDto,
  ): Promise<AdminPaymentDestinationView[]> {
    return this.destinations.listForMethod(params.id, query.includeInactive === 'true');
  }

  @AdminAuth(...PAYMENT_METHOD_MANAGER_ROLES)
  @Post('payment-methods/:id/destinations')
  createDestination(
    @CurrentAdmin('adminUserId') actorAdminId: string,
    @Param() params: MethodIdParamDto,
    @Body() body: CreatePaymentDestinationDto,
  ): Promise<AdminPaymentDestinationView> {
    return this.destinations.create(actorAdminId, params.id, body);
  }

  @AdminAuth(...PAYMENT_METHOD_MANAGER_ROLES)
  @Patch('payment-destinations/:id')
  updateDestination(
    @CurrentAdmin('adminUserId') actorAdminId: string,
    @Param() params: IdParamDto,
    @Body() body: UpdatePaymentDestinationDto,
  ): Promise<AdminPaymentDestinationView> {
    return this.destinations.update(actorAdminId, params.id, body);
  }

  @AdminAuth(...PAYMENT_METHOD_MANAGER_ROLES)
  @Delete('payment-destinations/:id')
  deactivateDestination(
    @CurrentAdmin('adminUserId') actorAdminId: string,
    @Param() params: IdParamDto,
  ): Promise<AdminPaymentDestinationView> {
    return this.destinations.deactivate(actorAdminId, params.id);
  }
}
