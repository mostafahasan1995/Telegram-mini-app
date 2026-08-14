import { REQUEST_ADMIN_KEY, REQUEST_PLAYER_KEY } from '@common/decorators/auth.types';

import {
  findUnmatchedRules,
  matchRule,
  normalizePath,
  throttleTracker,
  THROTTLE_RULES,
} from './throttle-routes';

describe('throttle rules', () => {
  describe('matchRule', () => {
    it.each([
      ['POST', '/v1/auth/telegram', 'auth-exchange'],
      ['POST', '/v1/auth/refresh', 'auth-exchange'],
      ['POST', '/v1/deposits', 'deposit-create'],
      ['POST', '/v1/deposits/01ARZ3NDEK/proof', 'proof-upload'],
    ])('%s %s is throttled by %s', (method, path, expected) => {
      expect(matchRule(method, path)?.name).toBe(expected);
    });

    it.each([
      // Reading is never throttled: a player polling their deposit list, and an admin working
      // through the review queue, must not be rate limited.
      ['GET', '/v1/deposits'],
      ['GET', '/v1/deposits/01ARZ3NDEK'],
      ['GET', '/v1/me'],
      ['GET', '/health/ready'],
      ['POST', '/v1/admin/deposits/abc/approve'],
      ['POST', '/v1/deposits/01ARZ3NDEK/cancel'],
      ['POST', '/telegram/webhook/token'],
    ])('%s %s is NOT throttled', (method, path) => {
      expect(matchRule(method, path)).toBeUndefined();
    });

    it('ignores the query string and a trailing slash', () => {
      expect(matchRule('POST', '/v1/deposits?retry=1')?.name).toBe('deposit-create');
      expect(matchRule('POST', '/v1/deposits/')?.name).toBe('deposit-create');
    });

    it('is case-insensitive about the HTTP method only', () => {
      expect(matchRule('post', '/v1/deposits')?.name).toBe('deposit-create');
      expect(matchRule('POST', '/V1/DEPOSITS')).toBeUndefined();
    });

    it('does not let a deeper path smuggle past the deposit-create rule', () => {
      // `^/v1/deposits$` is anchored: /v1/deposits/x must not be counted as a create.
      expect(matchRule('POST', '/v1/deposits/x')).toBeUndefined();
    });

    it('survives a missing method or url', () => {
      expect(matchRule(undefined, '/v1/deposits')).toBeUndefined();
      expect(matchRule('POST', undefined)).toBeUndefined();
      expect(matchRule('POST', '')).toBeUndefined();
    });
  });

  describe('normalizePath', () => {
    it('keeps a bare slash intact', () => {
      expect(normalizePath('/')).toBe('/');
    });
    it('returns empty for a non-string', () => {
      expect(normalizePath(undefined)).toBe('');
      expect(normalizePath(42)).toBe('');
    });
  });

  describe('throttleTracker', () => {
    it('prefers the authenticated player, so carrier NAT cannot punish a whole city', () => {
      const request = { [REQUEST_PLAYER_KEY]: { playerId: 'p1' }, ip: '1.2.3.4' };
      expect(throttleTracker(request)).toBe('player:p1');
    });

    it('falls back to the admin, then to the proxied client IP, then to the socket IP', () => {
      expect(throttleTracker({ [REQUEST_ADMIN_KEY]: { adminUserId: 'a1' } })).toBe('admin:a1');
      expect(throttleTracker({ ips: ['9.9.9.9', '10.0.0.1'], ip: '10.0.0.1' })).toBe('ip:9.9.9.9');
      expect(throttleTracker({ ip: '10.0.0.1' })).toBe('ip:10.0.0.1');
    });

    it('never returns an empty key', () => {
      // An empty tracker would put every anonymous caller in one bucket AND make the storage key
      // collide across routes.
      expect(throttleTracker({})).toBe('ip:unknown');
      expect(throttleTracker(null)).toBe('ip:unknown');
      expect(throttleTracker({ ips: [], ip: '' })).toBe('ip:unknown');
    });
  });

  describe('findUnmatchedRules', () => {
    it('reports nothing when every rule matches a registered route', () => {
      const routes = [
        { method: 'post', path: '/v1/auth/telegram' },
        { method: 'post', path: '/v1/auth/refresh' },
        { method: 'post', path: '/v1/deposits' },
        { method: 'post', path: '/v1/deposits/{shortId}/proof' },
      ];
      expect(findUnmatchedRules(routes)).toEqual([]);
    });

    it('understands the express :param dialect as well as OpenAPI {param}', () => {
      const routes = [
        { method: 'post', path: '/v1/auth/telegram' },
        { method: 'post', path: '/v1/deposits' },
        { method: 'post', path: '/v1/deposits/:shortId/proof' },
      ];
      expect(findUnmatchedRules(routes)).toEqual([]);
    });

    it('catches a renamed route — the silent failure this exists for', () => {
      const routes = [
        { method: 'post', path: '/v1/auth/telegram' },
        { method: 'post', path: '/v1/deposits' },
        // proof moved to /v1/deposits/{shortId}/receipt and nobody updated the rule
        { method: 'post', path: '/v1/deposits/{shortId}/receipt' },
      ];
      expect(findUnmatchedRules(routes).map((rule) => rule.name)).toEqual(['proof-upload']);
    });

    it('every rule ships with a sample path its own pattern accepts', () => {
      // Otherwise the boot-time self-check could never go green.
      for (const rule of THROTTLE_RULES) {
        expect(rule.pattern.test(rule.samplePath)).toBe(true);
      }
    });

    it('no rule matches a route with the wrong method', () => {
      const routes = THROTTLE_RULES.map((rule) => ({ method: 'get', path: rule.samplePath }));
      expect(findUnmatchedRules(routes)).toHaveLength(THROTTLE_RULES.length);
    });
  });
});
