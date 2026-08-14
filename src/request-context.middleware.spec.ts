/**
 * These tests pin the two integration defects this middleware exists to fix. Both were silent —
 * nothing threw, nothing logged, the data was just wrong — so a regression would be equally silent
 * without them.
 */
import { resolveActor } from '@core/actor-context/actor-context.interceptor';
import { CORRELATION_ID_HEADER } from '@common/interceptors/correlation-id.interceptor';
import { REQUEST_ADMIN_KEY, REQUEST_PLAYER_KEY } from '@common/decorators/auth.types';
import type { Actor } from '@common/types/actor.type';

import { actorFromPrincipals, requestContextMiddleware } from './request-context.middleware';

interface FakeRequest {
  headers: Record<string, string | string[] | undefined>;
  correlationId?: string;
  [REQUEST_PLAYER_KEY]?: { playerId?: unknown };
  [REQUEST_ADMIN_KEY]?: { adminUserId?: unknown };
  actor?: Actor;
}

function makeRequest(headers: Record<string, string> = {}): FakeRequest {
  return { headers };
}

function makeResponse(): { setHeader: jest.Mock; headersSent: boolean } {
  return { setHeader: jest.fn(), headersSent: false };
}

describe('requestContextMiddleware', () => {
  describe('actor bridge', () => {
    it("turns AuthGuard's player principal into a PLAYER actor", () => {
      const req = makeRequest();
      requestContextMiddleware(req, makeResponse(), jest.fn());

      // Exactly what AuthGuard writes: `playerId`, not `id`.
      req[REQUEST_PLAYER_KEY] = { playerId: 'player-uuid-1' };

      expect(resolveActor(req as never)).toEqual({ type: 'PLAYER', id: 'player-uuid-1' });
    });

    it("turns AuthGuard's admin principal into an ADMIN actor", () => {
      const req = makeRequest();
      requestContextMiddleware(req, makeResponse(), jest.fn());

      req[REQUEST_ADMIN_KEY] = { adminUserId: 'admin-uuid-1' };

      expect(resolveActor(req as never)).toEqual({ type: 'ADMIN', id: 'admin-uuid-1' });
    });

    it('is LAZY: the principal may be attached after the middleware has run', () => {
      // This is the whole reason it is a getter. AuthGuard runs after all middleware, so a value
      // computed eagerly here would always be undefined.
      const req = makeRequest();
      requestContextMiddleware(req, makeResponse(), jest.fn());

      expect(resolveActor(req as never)).toEqual({ type: 'SYSTEM', id: null });

      req[REQUEST_PLAYER_KEY] = { playerId: 'late-player' };
      expect(resolveActor(req as never)).toEqual({ type: 'PLAYER', id: 'late-player' });
    });

    it('leaves an anonymous request as SYSTEM rather than inventing an actor', () => {
      const req = makeRequest();
      requestContextMiddleware(req, makeResponse(), jest.fn());
      expect(actorFromPrincipals(req)).toBeUndefined();
      expect(resolveActor(req as never)).toEqual({ type: 'SYSTEM', id: null });
    });

    it('lets an explicit assignment win, so @core/auth can take this over later', () => {
      const req = makeRequest();
      requestContextMiddleware(req, makeResponse(), jest.fn());

      req[REQUEST_PLAYER_KEY] = { playerId: 'derived' };
      req.actor = { type: 'ADMIN', id: 'explicit' };

      expect(resolveActor(req as never)).toEqual({ type: 'ADMIN', id: 'explicit' });
    });

    it('does not throw when assigning to `actor` (a getter-only property would)', () => {
      const req = makeRequest();
      requestContextMiddleware(req, makeResponse(), jest.fn());
      expect(() => {
        req.actor = { type: 'SYSTEM', id: null };
      }).not.toThrow();
    });

    it('prefers the player over the admin when a request somehow carries both', () => {
      const req = makeRequest();
      requestContextMiddleware(req, makeResponse(), jest.fn());
      req[REQUEST_PLAYER_KEY] = { playerId: 'p1' };
      req[REQUEST_ADMIN_KEY] = { adminUserId: 'a1' };
      expect(resolveActor(req as never)).toEqual({ type: 'PLAYER', id: 'p1' });
    });
  });

  describe('correlation id', () => {
    it('pins a minted id into the headers so every downstream resolver agrees', () => {
      const req = makeRequest();
      const res = makeResponse();

      requestContextMiddleware(req, res, jest.fn());

      const pinned = req.headers[CORRELATION_ID_HEADER];
      expect(typeof pinned).toBe('string');
      // The @common resolver stamps the property; the @core/actor-context one reads ONLY the
      // header. Before this middleware they minted two different ids for the same request.
      expect(req.correlationId).toBe(pinned);
      expect(res.setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, pinned);
    });

    it('produces an id both resolvers accept as well-formed', () => {
      const req = makeRequest();
      requestContextMiddleware(req, makeResponse(), jest.fn());
      const pinned = req.headers[CORRELATION_ID_HEADER];

      // @common: /^[A-Za-z0-9._-]{8,128}$/   @core/actor-context: /^[\w.:-]{8,128}$/
      expect(pinned).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
      expect(pinned).toMatch(/^[\w.:-]{8,128}$/);
    });

    it('honours a sane upstream id instead of minting a new one', () => {
      const upstream = 'upstream-trace-0123456789';
      const req = makeRequest({ [CORRELATION_ID_HEADER]: upstream });

      requestContextMiddleware(req, makeResponse(), jest.fn());

      expect(req.headers[CORRELATION_ID_HEADER]).toBe(upstream);
      expect(req.correlationId).toBe(upstream);
    });

    it('replaces a hostile upstream id (log forging) but still pins one', () => {
      const req = makeRequest({ [CORRELATION_ID_HEADER]: 'bad\nid injected line' });

      requestContextMiddleware(req, makeResponse(), jest.fn());

      expect(req.correlationId).not.toContain('\n');
      // The header is only overwritten when it was absent, so the hostile value stays visible for
      // debugging — what matters is that req.correlationId, which is what gets logged, is clean.
      expect(req.correlationId).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
    });

    it('always calls next(), including for a non-object request', () => {
      const next = jest.fn();
      requestContextMiddleware(null, makeResponse(), next);
      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});
