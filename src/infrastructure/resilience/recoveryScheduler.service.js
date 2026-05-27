'use strict';

/**
 * recoveryScheduler.service.js — STUB
 *
 * Missing file — would crash server at startup (line 5133).
 *
 * API surface used by server.js:
 *   - startRecoveryScheduler()
 *   - stopRecoveryScheduler()
 */

let _running = false;

function startRecoveryScheduler() {
  _running = true;
}

function stopRecoveryScheduler() {
  _running = false;
}

module.exports = {
  startRecoveryScheduler,
  stopRecoveryScheduler,
};
