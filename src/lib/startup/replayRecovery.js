'use strict';

/**
 * replayRecovery.js — Wave 27: Replay-Safe Recovery Executor
 *
 * Executes a controlled, capped replay of a registered recoverable startup phase.
 *
 * Safety guarantees:
 *   - Skips replay if the validate hook reports the phase is already healthy.
 *   - Caps attempts at recoveryRegistry.maxReplayAttempts (default 3).
 *   - Never invokes a phase that has no replay handler.
 *   - All outcomes are recorded in the replay ledger and attempt log.
 */

const {
  getRecoverablePhase,
  recordReplayAttempt,
  recoveryRegistry,
} = require('./recoveryRegistry');

/**
 * Attempt to replay a single named startup phase.
 *
 * @param {string} name    - Startup phase identifier.
 * @param {object} context - Passed verbatim into validate/replay handlers.
 * @returns {Promise<{recovered: boolean, replayed?: boolean, result?: *, reason?: string}>}
 */
async function replayRecoverablePhase(name, context = {}) {
  const phase = getRecoverablePhase(name);

  if (!phase) {
    recordReplayAttempt(name, 'missing');
    return { recovered: false, reason: 'phase_not_registered' };
  }

  // Count only successful prior replays against the cap.
  const successfulReplays = recoveryRegistry.attempts.filter(
    (entry) => entry.name === name && entry.status === 'success'
  ).length;

  if (successfulReplays >= recoveryRegistry.maxReplayAttempts) {
    recordReplayAttempt(name, 'exhausted');
    return { recovered: false, reason: 'max_attempts_exceeded' };
  }

  try {
    // Validate hook: if the phase is already in a healthy state, skip replay.
    if (typeof phase.validate === 'function') {
      const alreadyValid = await phase.validate(context);

      if (alreadyValid === true) {
        recordReplayAttempt(name, 'already_valid');
        return { recovered: true, replayed: false };
      }
    }

    // Guard: phase must expose a replay handler to be replayed.
    if (typeof phase.replay !== 'function') {
      recordReplayAttempt(name, 'non_replayable');
      return { recovered: false, reason: 'no_replay_handler' };
    }

    const result = await phase.replay(context);

    // Update registry state on success.
    phase.lastRecoveredAt = Date.now();

    recoveryRegistry.replayLedger.set(name, {
      ts: Date.now(),
      result,
    });

    recordReplayAttempt(name, 'success');

    return {
      recovered: true,
      replayed: true,
      result,
    };
  } catch (error) {
    recordReplayAttempt(name, 'failed', error.message);

    return {
      recovered: false,
      reason: error.message,
    };
  }
}

module.exports = { replayRecoverablePhase };