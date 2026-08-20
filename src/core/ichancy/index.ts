/**
 * WHY: one import surface for the anti-corruption layer. Consumers should need only
 * `@core/ichancy` — the port, the token, the result helpers and (for tests) the fake.
 */
export * from './ichancy.types';
export * from './ichancy.port';
export * from './ichancy.wire';
export * from './money-codec';
export * from './error-map';
export * from './ichancy-call-log.service';
export * from './ichancy-health.service';
export * from './ichancy-session.store';
export * from './ichancy-session.service';
export * from './ichancy-http.client';
export * from './http-ichancy.adapter';
export * from './fake-ichancy.adapter';
export * from './ichancy.module';
