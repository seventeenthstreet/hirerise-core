'use strict';

/**
 * pressureBalancer.worker.js — STUB
 *
 * Missing file — would crash server at startup (line 5140).
 *
 * API surface used by server.js:
 *   - startPressureBalancerWorker()
 *   - stopPressureBalancerWorker()
 */

let _running = false;

function startPressureBalancerWorker() {
  _running = true;
}

function stopPressureBalancerWorker() {
  _running = false;
}

module.exports = {
  startPressureBalancerWorker,
  stopPressureBalancerWorker,
};
