'use strict';

const {
  STATES,
  assertValidTransition,
  canTransition,
  isTerminal,
  isVerifiable,
  InvalidLifecycleTransitionError,
} = require('../adminLifecycle.states');

describe('adminLifecycle.states', () => {
  describe('grant', () => {
    it('is valid with no existing principal', () => {
      expect(assertValidTransition(null, 'grant')).toBe(STATES.ACTIVE);
    });

    it('is valid from revoked, expired, and suspended (re-grant)', () => {
      expect(assertValidTransition(STATES.REVOKED, 'grant')).toBe(STATES.ACTIVE);
      expect(assertValidTransition(STATES.EXPIRED, 'grant')).toBe(STATES.ACTIVE);
      expect(assertValidTransition(STATES.SUSPENDED, 'grant')).toBe(STATES.ACTIVE);
    });
  });

  describe('suspend', () => {
    it('is valid only from active', () => {
      expect(assertValidTransition(STATES.ACTIVE, 'suspend')).toBe(STATES.SUSPENDED);
    });

    it('rejects suspend from suspended, revoked, expired, or none', () => {
      expect(canTransition(STATES.SUSPENDED, 'suspend')).toBe(false);
      expect(canTransition(STATES.REVOKED, 'suspend')).toBe(false);
      expect(canTransition(STATES.EXPIRED, 'suspend')).toBe(false);
      expect(canTransition(null, 'suspend')).toBe(false);
    });
  });

  describe('reactivate', () => {
    it('is valid only from suspended', () => {
      expect(assertValidTransition(STATES.SUSPENDED, 'reactivate')).toBe(STATES.ACTIVE);
    });

    it('rejects reactivate from active, revoked, expired, or none', () => {
      expect(canTransition(STATES.ACTIVE, 'reactivate')).toBe(false);
      expect(canTransition(STATES.REVOKED, 'reactivate')).toBe(false);
      expect(canTransition(STATES.EXPIRED, 'reactivate')).toBe(false);
      expect(canTransition(null, 'reactivate')).toBe(false);
    });
  });

  describe('revoke', () => {
    it('is valid from active and suspended', () => {
      expect(assertValidTransition(STATES.ACTIVE, 'revoke')).toBe(STATES.REVOKED);
      expect(assertValidTransition(STATES.SUSPENDED, 'revoke')).toBe(STATES.REVOKED);
    });

    it('rejects revoke from revoked, expired, or none (terminal / nonexistent)', () => {
      expect(canTransition(STATES.REVOKED, 'revoke')).toBe(false);
      expect(canTransition(STATES.EXPIRED, 'revoke')).toBe(false);
      expect(canTransition(null, 'revoke')).toBe(false);
    });
  });

  describe('expire', () => {
    it('is valid from active and suspended', () => {
      expect(assertValidTransition(STATES.ACTIVE, 'expire')).toBe(STATES.EXPIRED);
      expect(assertValidTransition(STATES.SUSPENDED, 'expire')).toBe(STATES.EXPIRED);
    });

    it('rejects expire from revoked, expired, or none', () => {
      expect(canTransition(STATES.REVOKED, 'expire')).toBe(false);
      expect(canTransition(STATES.EXPIRED, 'expire')).toBe(false);
      expect(canTransition(null, 'expire')).toBe(false);
    });
  });

  it('throws InvalidLifecycleTransitionError with action/fromStatus context', () => {
    expect.assertions(3);
    try {
      assertValidTransition(STATES.REVOKED, 'suspend');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidLifecycleTransitionError);
      expect(err.action).toBe('suspend');
      expect(err.fromStatus).toBe(STATES.REVOKED);
    }
  });

  it('rejects unknown actions', () => {
    expect(canTransition(STATES.ACTIVE, 'delete')).toBe(false);
  });

  describe('isTerminal / isVerifiable', () => {
    it('revoked and expired are terminal; active and suspended are not', () => {
      expect(isTerminal(STATES.REVOKED)).toBe(true);
      expect(isTerminal(STATES.EXPIRED)).toBe(true);
      expect(isTerminal(STATES.ACTIVE)).toBe(false);
      expect(isTerminal(STATES.SUSPENDED)).toBe(false);
    });

    it('only active is verifiable', () => {
      expect(isVerifiable(STATES.ACTIVE)).toBe(true);
      expect(isVerifiable(STATES.SUSPENDED)).toBe(false);
      expect(isVerifiable(STATES.REVOKED)).toBe(false);
      expect(isVerifiable(STATES.EXPIRED)).toBe(false);
    });
  });
});
