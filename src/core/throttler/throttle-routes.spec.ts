import { createHash } from 'node:crypto';

import type { ExecutionContext } from '@nestjs/common';

import { REQUEST_ADMIN_KEY, REQUEST_PLAYER_KEY } from '@common/decorators/auth.types';

import {
  findUnmatchedRules,
  matchRule,
  normalizePath,
  throttleKey,
  throttleTracker,
  THROTTLE_RULES,
} from './throttle-routes';

/** Two controller classes and handlers, as the guard would see them for two different routes. */
class AdminAuthController {
  signIn(this: void): void {}
  signInWithAgent(this: void): void {}
}
class DepositController {
  create(this: void): void {}
  uploadProof(this: void): void {}
}

function httpContext(
  method: string,
  url: string,
  classRef: new () => object,
  handler: () => void,
): ExecutionContext {
  const context = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ method, originalUrl: url }) }),
    getClass: () => classRef,
    getHandler: () => handler,
  };
  return context as unknown as ExecutionContext;
}

/** @nestjs/throttler 6's own ThrottlerGuard.generateKey, restated so a change there is noticed here. */
function libraryDefaultKey(context: ExecutionContext, tracker: string, name: string): string {
  return createHash('sha256')
    .update(`${context.getClass().name}-${context.getHandler().name}-${name}-${tracker}`)
    .digest('hex');
}

describe('throttle rules', () => {
  describe('matchRule', () => {
    it.each([
      ['POST', '/v1/auth/telegram', 'auth-exchange'],
      ['POST', '/v1/auth/refresh', 'auth-exchange'],
      ['POST', '/v1/admin/auth/credentials', 'admin-sign-in'],
      ['POST', '/v1/admin/auth/ichancy', 'admin-sign-in'],
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
      // The retired bot-code door has no route and therefore no rule.
      ['POST', '/v1/admin/auth/bot-code'],
    ])('%s %s is NOT throttled', (method, path) => {
      expect(matchRule(method, path)).toBeUndefined();
    });

    it('limits console sign-in to 10 a minute and blocks for 15 minutes', () => {
      // A password does not expire on its own the way a bot code did; the block is what makes a
      // patient guessing loop hopeless rather than merely slow (API-CONTRACT.md §2a).
      expect(matchRule('POST', '/v1/admin/auth/credentials')).toMatchObject({
        limit: 10,
        ttlMs: 60_000,
        blockMs: 15 * 60_000,
      });
    });

    it('does not let a deeper path smuggle past the admin sign-in rule', () => {
      expect(matchRule('POST', '/v1/admin/auth/credentials/x')).toBeUndefined();
      expect(matchRule('POST', '/v1/admin/auth/credentialsx')).toBeUndefined();
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

  describe('throttleKey', () => {
    const tracker = 'ip:203.0.113.7';

    it('puts both admin sign-in doors in ONE bucket per caller', () => {
      const credentials = httpContext(
        'POST',
        '/v1/admin/auth/credentials',
        AdminAuthController,
        AdminAuthController.prototype.signIn,
      );
      const ichancy = httpContext(
        'POST',
        '/v1/admin/auth/ichancy',
        AdminAuthController,
        AdminAuthController.prototype.signInWithAgent,
      );

      expect(throttleKey(credentials, tracker, 'default')).toBe(
        throttleKey(ichancy, tracker, 'default'),
      );
      // Still one bucket per caller, and not the per-route key the library would have used.
      expect(throttleKey(credentials, 'ip:198.51.100.1', 'default')).not.toBe(
        throttleKey(credentials, tracker, 'default'),
      );
      expect(throttleKey(credentials, tracker, 'default')).not.toBe(
        libraryDefaultKey(credentials, tracker, 'default'),
      );
    });

    it("keeps every other rule's per-route bucket, byte-identical to the library default", () => {
      const create = httpContext(
        'POST',
        '/v1/deposits',
        DepositController,
        DepositController.prototype.create,
      );
      const proof = httpContext(
        'POST',
        '/v1/deposits/01ARZ3NDEK/proof',
        DepositController,
        DepositController.prototype.uploadProof,
      );

      expect(throttleKey(create, tracker, 'default')).toBe(
        libraryDefaultKey(create, tracker, 'default'),
      );
      expect(throttleKey(proof, tracker, 'default')).toBe(
        libraryDefaultKey(proof, tracker, 'default'),
      );
      expect(throttleKey(create, tracker, 'default')).not.toBe(
        throttleKey(proof, tracker, 'default'),
      );
    });

    it('only the admin sign-in rule shares a bucket', () => {
      expect(
        THROTTLE_RULES.filter((rule) => rule.sharedAcrossRoutes === true).map((rule) => rule.name),
      ).toEqual(['admin-sign-in']);
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
        { method: 'post', path: '/v1/auth/bot-code' },
        { method: 'post', path: '/v1/admin/auth/credentials' },
        { method: 'post', path: '/v1/deposits' },
        { method: 'post', path: '/v1/deposits/{shortId}/proof' },
      ];
      expect(findUnmatchedRules(routes)).toEqual([]);
    });

    it('understands the express :param dialect as well as OpenAPI {param}', () => {
      const routes = [
        { method: 'post', path: '/v1/auth/telegram' },
        { method: 'post', path: '/v1/auth/bot-code' },
        { method: 'post', path: '/v1/admin/auth/credentials' },
        { method: 'post', path: '/v1/deposits' },
        { method: 'post', path: '/v1/deposits/:shortId/proof' },
      ];
      expect(findUnmatchedRules(routes)).toEqual([]);
    });

    it('catches a renamed route — the silent failure this exists for', () => {
      const routes = [
        { method: 'post', path: '/v1/auth/telegram' },
        { method: 'post', path: '/v1/auth/bot-code' },
        { method: 'post', path: '/v1/admin/auth/credentials' },
        { method: 'post', path: '/v1/deposits' },
        // proof moved to /v1/deposits/{shortId}/receipt and nobody updated the rule
        { method: 'post', path: '/v1/deposits/{shortId}/receipt' },
      ];
      expect(findUnmatchedRules(routes).map((rule) => rule.name)).toEqual(['proof-upload']);
    });

    it('reports the admin sign-in rule as INACTIVE if only the retired bot-code route existed', () => {
      const routes = [
        { method: 'post', path: '/v1/auth/telegram' },
        { method: 'post', path: '/v1/auth/bot-code' },
        { method: 'post', path: '/v1/admin/auth/bot-code' },
        { method: 'post', path: '/v1/deposits' },
        { method: 'post', path: '/v1/deposits/{shortId}/proof' },
      ];
      expect(findUnmatchedRules(routes).map((rule) => rule.name)).toEqual(['admin-sign-in']);
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
