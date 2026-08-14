/**
 * The persistence core's public surface. Import from `@core/prisma` (or the individual file — both
 * resolve to the same symbols) and never reach into `@prisma/client` from a module.
 */
export * from './tx.type';
export * from './prisma.service';
export * from './prisma.module';
export * from './base.repository';
export * from './prisma-errors';
export * from './retry.util';
export * from './pool-config.util';
export * from './actor-stamp.extension';
