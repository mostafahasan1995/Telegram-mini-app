/**
 * WHY `excludeExtraneousValues: true` is not optional here: this interceptor is the thing standing
 * between `prisma.player.findUnique()` and the wire. That row carries `ichancyPasswordEnc` and
 * `ichancyLogin`. An allow-list serializer (only @Expose()d fields survive) fails safe; a
 * deny-list one leaks every column somebody adds later.
 *
 * Applied through @TransformDto(Dto) rather than used directly.
 */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor, Type } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { map, type Observable } from 'rxjs';
import { CursorResult, PaginatedResult } from '../dtos/paginated.dto';

@Injectable()
export class SerializeInterceptor implements NestInterceptor {
  constructor(private readonly dto: Type<unknown>) {}

  private toDto(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    return plainToInstance(this.dto, value, {
      excludeExtraneousValues: true,
      // Dates and BigInts must reach the DTO intact so an @Expose()/@Transform() pair can format
      // them; class-transformer would otherwise try to rebuild them from their own output.
      enableImplicitConversion: false,
    });
  }

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((payload: unknown): unknown => {
        // Page results are rebuilt so the interceptor ordering (serialize -> transform) does not
        // matter: the page shape survives serialization either way.
        if (payload instanceof PaginatedResult) {
          return new PaginatedResult(
            payload.data.map((row) => this.toDto(row)),
            payload.meta,
          );
        }
        if (payload instanceof CursorResult) {
          return new CursorResult(
            payload.data.map((row) => this.toDto(row)),
            payload.meta,
          );
        }
        if (Array.isArray(payload)) {
          return payload.map((row) => this.toDto(row));
        }
        return this.toDto(payload);
      }),
    );
  }
}
