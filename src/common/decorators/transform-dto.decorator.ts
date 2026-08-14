/**
 * WHY a decorator rather than "just return a DTO from the service": services return domain objects
 * and Prisma rows, and the shape that is safe to persist is not the shape that is safe to publish.
 * `@TransformDto(PlayerDto)` puts the allow-list at the controller — the exact place where data
 * leaves the process — so a reviewer can see what a route exposes without reading the service.
 *
 * The DTO must annotate every field it wants with @Expose(); nothing else survives.
 */
import { applyDecorators, UseInterceptors, type Type } from '@nestjs/common';
import { SerializeInterceptor } from '../interceptors/serialize.interceptor';

export const TransformDto = (dto: Type<unknown>): MethodDecorator & ClassDecorator =>
  applyDecorators(UseInterceptors(new SerializeInterceptor(dto)));
