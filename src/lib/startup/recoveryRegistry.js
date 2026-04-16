'use strict';

/**
 * recoveryRegistry.js — Wave 27: Deterministic Startup Self-Healing
 *
 * Maintains a registry of named startup phases that are safe to replay
 * after an incomplete or interrupted bootstrap cycle.
 *
 * Safety contract:
 *   - Only idempotent phases may be registered.
 *   - Replay attempts are capped at maxReplayAttempts.
 *   - Validate hooks prevent replaying already-healthy phases.
 */

const recoveryRegistry = {
  phases: new Map(),
  replayLedger: new Map(),
  attempts: [],
  maxReplayAttempts: 3,
};

/**
 * Register a named phase as recoverable.
 *
 * @param {string} name - Startup phase identifier (must match startupBarrier key).
 * @param {object} handlers
 * @param {Function|null} handlers.replay    - Async fn to re-execute the phase.
 * @param {Function|null} handlers.validate  - Async fn; return true if phase is already healthy.
 * @param {boolean}       handlers.idempotent - Default true; set false to block registration.
 * @param {boolean}       handlers.critical   - If true, recovery failure is fatal.
 */
function registerRecoverablePhase(name, handlers = {}) {
  if (handlers.idempotent === false) {
    // Non-idempotent phases must never be registered — enforce at call site.
    throw new Error(
      `[recoveryRegistry] Refused to register non-idempotent phase: "${name}". ` +
      'Only idempotent phases may be declared recoverable.'
    );
  }

  recoveryRegistry.phases.set(name, {
    replay: handlers.replay || null,
    validate: handlers.validate || null,
    idempotent: true, // always true — non-idempotent registration is blocked above
    critical: !!handlers.critical,
    lastRecoveredAt: null,
  });
}

/**
 * Retrieve a registered recoverable phase by name.
 * Returns null if the phase has not been registered.
 *
 * @param {string} name
 * @returns {object|null}
 */
function getRecoverablePhase(name) {
  return recoveryRegistry.phases.get(name) || null;
}

/**
 * Append a replay attempt record to the audit log.
 *
 * @param {string}      name   - Phase name.
 * @param {string}      status - 'success'|'failed'|'missing'|'exhausted'|'already_valid'|'non_replayable'
 * @param {string|null} reason - Optional failure reason / error message.
 */
function recordReplayAttempt(name, status, reason = null) {
  recoveryRegistry.attempts.push({
    name,
    status,
    reason,
    ts: Date.now(),
  });
}

module.exports = {
  recoveryRegistry,
  registerRecoverablePhase,
  getRecoverablePhase,
  recordReplayAttempt,
};