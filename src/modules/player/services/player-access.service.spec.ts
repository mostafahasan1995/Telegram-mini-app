import { PlayerAccessService, SYSTEM_VIEWER, type PlayerViewer } from './player-access.service';
import { ForbiddenError } from '@common/exceptions/app.exception';

const PLAYER: PlayerViewer = { type: 'PLAYER', playerId: 'player-1' };
const ADMIN: PlayerViewer = { type: 'ADMIN', adminUserId: 'admin-1', role: 'FINANCE_ADMIN' };

describe('PlayerAccessService', () => {
  const access = new PlayerAccessService();

  describe('playerScope', () => {
    it('pins a player to their own row', () => {
      expect(access.playerScope(PLAYER)).toEqual({ id: 'player-1' });
    });

    it('does not constrain staff or the system', () => {
      expect(access.playerScope(ADMIN)).toEqual({});
      expect(access.playerScope(SYSTEM_VIEWER)).toEqual({});
    });
  });

  describe('ownedScope', () => {
    it('filters player-owned tables by playerId', () => {
      expect(access.ownedScope(PLAYER)).toEqual({ playerId: 'player-1' });
      expect(access.ownedScope(ADMIN)).toEqual({});
    });
  });

  describe('restrict', () => {
    it('ANDs the scope with the caller filter instead of merging keys', () => {
      // THE test for this file. A spread-based implementation would drop one of the two `id`
      // constraints depending on order, and a caller-supplied id would escape the scope.
      const restricted = access.restrict({ id: 'someone-else' }, access.playerScope(PLAYER));

      expect(restricted).toEqual({ AND: [{ id: 'someone-else' }, { id: 'player-1' }] });
    });

    it('cannot be widened by a caller filter', () => {
      const restricted = access.scopedPlayerWhere(PLAYER, { id: 'victim' });
      // Both constraints survive, so the query matches nothing — which is the safe outcome.
      expect(JSON.stringify(restricted)).toContain('player-1');
      expect(JSON.stringify(restricted)).toContain('victim');
    });

    it('returns the caller filter untouched when the scope is empty', () => {
      expect(access.restrict({ status: 'ACTIVE' }, {})).toEqual({ status: 'ACTIVE' });
    });

    it('returns the scope when there is no caller filter', () => {
      expect(access.restrict(undefined, { playerId: 'player-1' })).toEqual({
        playerId: 'player-1',
      });
      expect(access.restrict({}, { playerId: 'player-1' })).toEqual({ playerId: 'player-1' });
    });

    it('returns an empty filter when neither side constrains anything', () => {
      expect(access.restrict(undefined, {})).toEqual({});
    });
  });

  describe('canAccessPlayer', () => {
    it('lets a player see only themselves', () => {
      expect(access.canAccessPlayer(PLAYER, 'player-1')).toBe(true);
      expect(access.canAccessPlayer(PLAYER, 'player-2')).toBe(false);
    });

    it('lets staff and the system see anyone', () => {
      expect(access.canAccessPlayer(ADMIN, 'player-2')).toBe(true);
      expect(access.canAccessPlayer(SYSTEM_VIEWER, 'player-2')).toBe(true);
    });

    it('throws a Forbidden that does not confirm the other player exists', () => {
      expect(() => access.assertCanAccessPlayer(PLAYER, 'player-2')).toThrow(ForbiddenError);
      expect(() => access.assertCanAccessPlayer(PLAYER, 'player-1')).not.toThrow();
    });
  });
});
