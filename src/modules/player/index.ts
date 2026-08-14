/**
 * Import surface for the root module. Other FEATURE modules must not import from here —
 * eslint-plugin-boundaries enforces that. Cross-module needs go through PLAYER_LINK_PORT.
 */
export * from './player.module';
export * from './player.constants';
export * from './player-link.port';
export * from './dtos/player.view';
export * from './dtos/auth.dto';
export * from './services/player.service';
export * from './services/player-access.service';
export * from './services/player-auth.service';
export * from './services/player-link.service';
export * from './services/referral.service';
export * from './repositories/player.repository';
export * from './telegram/player.handlers';
