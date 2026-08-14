'use strict';

/**
 * adminLifecycle.states.js — WP-ADMIN-04F-18B
 *
 * Pure, dependency-free lifecycle state machine for Administrator
 * Principals (admin_principals). No I/O, no Supabase, no Express.
 *
 * States (approved under WP-ADMIN-04F-17A):
 *   ACTIVE     — verification succeeds, admin can act
 *   SUSPENDED  — temporary hold; verification fails; reversible via reactivate
 *   REVOKED    — permanent removal; verification fails; terminal
 *   EXPIRED    — passed expires_at without renewal; verification fails; terminal
 *
 * Transitions (approved):
 *   grant       (none|revoked|expired) -> ACTIVE
 *   suspend     ACTIVE                 -> SUSPENDED
 *   reactivate  SUSPENDED              -> ACTIVE
 *   revoke      ACTIVE|SUSPENDED       -> REVOKED
 *   expire      ACTIVE|SUSPENDED       -> EXPIRED
 *
 * No other lifecycle concepts are introduced.
 */

const STATES = Object.freeze({
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
});

const ALL_STATES = Object.freeze(Object.values(STATES));

// Terminal states cannot transition to anything else.
const TERMINAL_STATES = Object.freeze([STATES.REVOKED, STATES.EXPIRED]);

// States in which an admin passes lifecycle verification.
const VERIFIABLE_STATES = Object.freeze([STATES.ACTIVE]);

/**
 * ACTIONS: action name -> { from: [validSourceStates], to: targetState }
 * `from: null` means the action is valid from "no existing row" as well
 * as the listed states (used by `grant`, which both creates and
 * re-activates a principal).
 */
const ACTIONS = Object.freeze({
  grant: {
    from: [null, STATES.REVOKED, STATES.EXPIRED, STATES.SUSPENDED],
    to: STATES.ACTIVE,
  },
  suspend: {
    from: [STATES.ACTIVE],
    to: STATES.SUSPENDED,
  },
  reactivate: {
    from: [STATES.SUSPENDED],
    to: STATES.ACTIVE,
  },
  revoke: {
    from: [STATES.ACTIVE, STATES.SUSPENDED],
    to: STATES.REVOKED,
  },
  expire: {
    from: [STATES.ACTIVE, STATES.SUSPENDED],
    to: STATES.EXPIRED,
  },
});

class InvalidLifecycleTransitionError extends Error {
  constructor(action, fromStatus) {
    super(
      `Invalid Administrator lifecycle transition: action "${action}" is not permitted from status "${fromStatus ?? 'none'}".`
    );
    this.name = 'InvalidLifecycleTransitionError';
    this.code = 'ADMIN_LIFECYCLE_INVALID_TRANSITION';
    this.action = action;
    this.fromStatus = fromStatus ?? null;
  }
}

/**
 * Returns the resulting status for `action` applied to `fromStatus`,
 * or throws InvalidLifecycleTransitionError if the transition is not
 * permitted.
 *
 * @param {string|null} fromStatus - current status, or null/undefined if
 *   the principal does not yet exist.
 * @param {string} action - one of grant|suspend|reactivate|revoke|expire
 * @returns {string} the resulting status
 */
function assertValidTransition(fromStatus, action) {
  const normalizedFrom = fromStatus ?? null;
  const definition = ACTIONS[action];

  if (!definition) {
    throw new InvalidLifecycleTransitionError(action, normalizedFrom);
  }

  const allowed = definition.from.includes(normalizedFrom);

  if (!allowed) {
    throw new InvalidLifecycleTransitionError(action, normalizedFrom);
  }

  return definition.to;
}

/**
 * Non-throwing check, useful for API-layer pre-validation / UI hints.
 */
function canTransition(fromStatus, action) {
  try {
    assertValidTransition(fromStatus, action);
    return true;
  } catch {
    return false;
  }
}

function isTerminal(status) {
  return TERMINAL_STATES.includes(status);
}

function isVerifiable(status) {
  return VERIFIABLE_STATES.includes(status);
}

function isValidStatus(status) {
  return ALL_STATES.includes(status);
}

module.exports = {
  STATES,
  ALL_STATES,
  TERMINAL_STATES,
  VERIFIABLE_STATES,
  ACTIONS,
  InvalidLifecycleTransitionError,
  assertValidTransition,
  canTransition,
  isTerminal,
  isVerifiable,
  isValidStatus,
};
