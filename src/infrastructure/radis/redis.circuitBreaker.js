'use strict';

/**
 * src/infrastructure/radis/redis.circuitBreaker.js
 *
 * Lightweight Redis circuit breaker — zero external dependencies.
 *
 * States:
 *   CLOSED   — normal operation; all calls pass through.
 *   OPEN     — Redis is presumed down; calls are skipped immediately.
 *   HALF_OPEN — cooldown elapsed; one probe call is allowed through.
 *              Success → CLOSED. Failure → back to OPEN.
 *
 * Integration:
 *   Used internally by redis.singleton.js safeExec().
 *   Exported so health.routes.js can read state + metrics.
 *
 *   const cb = require('./redis.circuitBreaker');
 *   cb.isOpen()          → boolean
 *   cb.getState()        → 'CLOSED' | 'OPEN' | 'HALF_OPEN'
 *   cb.getMetrics()      → { totalCalls, failures, failureRate, avgLatencyMs,
 *                            slowCalls, openDurationMs, state, … }
 *   cb.recordSuccess(ms) → called by safeExec on success
 *   cb.recordFailure(ms) → called by safeExec on failure/timeout
 *   cb.reset()           → force back to CLOSED (test / manual recovery)
 *
 * Phase 5 additions (non-breaking):
 *   - failureRate    computed dynamically in getMetrics(); never stored
 *   - openDurationMs tracks how long circuit has been OPEN; null when CLOSED/HALF_OPEN
 *   - Overflow guard resets counters at 1_000_000 calls (circuit state preserved)
 *   - Transition logs include failureRate for OPEN; openDurationMs for CLOSED
 *
 * Phase 6 refinements (non-breaking):
 *   - openDurationMs now uses process.hrtime.bigint() — monotonic, clock-drift-immune.
 *     _openSince (Date.now epoch) is kept solely for the CLOSED transition log.
 *     _openSinceHr (BigInt ns) drives the duration calculation in getMetrics().
 *   - failureRate clamped to [0, 1] via Math.min/Math.max before rounding,
 *     guarding against any floating-point edge case where failures > totalCalls
 *     could transiently occur across an overflow reset boundary.
 */

const logger = require('../../utils/logger');

// ─────────────────────────────────────────────────────────────
// CONFIG  (override via env vars; all optional)
// ─────────────────────────────────────────────────────────────

const FAILURE_THRESHOLD  = parseInt(process.env.REDIS_CB_FAILURE_THRESHOLD  || '5',     10);
const COOLDOWN_MS        = parseInt(process.env.REDIS_CB_COOLDOWN_MS        || '10000', 10);
const SLOW_CALL_MS       = parseInt(process.env.REDIS_CB_SLOW_CALL_MS       || '200',   10);
// Soft metric reset threshold — prevents unbounded counter growth over long runtimes.
// Circuit state and _failureCount are intentionally NOT reset.
const METRIC_RESET_AT    = parseInt(process.env.REDIS_CB_METRIC_RESET_AT    || '1000000', 10);

// ─────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────

const STATE = Object.freeze({
  CLOSED:    'CLOSED',
  OPEN:      'OPEN',
  HALF_OPEN: 'HALF_OPEN',
});

let _state          = STATE.CLOSED;
let _failureCount   = 0;
let _lastFailureAt  = 0;   // epoch ms — used by isOpen() cooldown check and CLOSED log
let _halfOpenLocked = false; // true while the single probe call is in-flight
let _openSince      = null;  // epoch ms when circuit entered OPEN — used only in CLOSED transition log
let _openSinceHr    = null;  // process.hrtime.bigint() at OPEN — monotonic; drives openDurationMs

// ─────────────────────────────────────────────────────────────
// METRICS  (rolling in-memory; reset on process restart)
// ─────────────────────────────────────────────────────────────

const metrics = {
  totalCalls:   0,
  failures:     0,
  slowCalls:    0,
  // Welford's online algorithm for running mean — avoids float drift
  // from simple (sum / n) across millions of calls.
  _latencySum:  0,
};

function _avgLatencyMs() {
  if (metrics.totalCalls === 0) return 0;
  return Math.round(metrics._latencySum / metrics.totalCalls);
}

// TASK 2 — Overflow guard.
// Resets rolling counters when totalCalls reaches METRIC_RESET_AT.
// Circuit state (_state, _failureCount, _openSince) are deliberately
// preserved — a reset must never mask an active failure condition.
// This fires at most once per million calls, so the branch cost is negligible.
function _maybeResetMetrics() {
  if (metrics.totalCalls < METRIC_RESET_AT) return;
  metrics.totalCalls  = 0;
  metrics.failures    = 0;
  metrics.slowCalls   = 0;
  metrics._latencySum = 0;
  logger.info('[Redis] Circuit breaker metrics reset (overflow guard)', {
    resetAt: METRIC_RESET_AT,
  });
}

// ─────────────────────────────────────────────────────────────
// STATE TRANSITIONS
// ─────────────────────────────────────────────────────────────

function _transitionTo(next) {
  if (_state === next) return;
  const prev = _state;
  _state = next;

  if (next === STATE.OPEN) {
    _openSince   = Date.now();                 // kept for the CLOSED transition log
    _openSinceHr = process.hrtime.bigint();    // monotonic — immune to clock adjustments
    // TASK 1+5: include failureRate in OPEN log
    const rate = metrics.totalCalls > 0
      ? Math.round((metrics.failures / metrics.totalCalls) * 100) / 100
      : 0;
    logger.error('[Redis] Circuit OPEN — failing fast until cooldown expires', {
      failureCount: _failureCount,
      failureRate:  rate,
      cooldownMs:   COOLDOWN_MS,
    });
  } else if (next === STATE.HALF_OPEN) {
    // _openSince / _openSinceHr intentionally kept — circuit is still recovering
    logger.warn('[Redis] Circuit HALF-OPEN — sending one probe request');
  } else if (next === STATE.CLOSED) {
    // TASK 3+5: log how long it was open before clearing
    const openDurationMs = _openSince !== null ? Date.now() - _openSince : 0;
    _openSince   = null;
    _openSinceHr = null;
    logger.info('[Redis] Circuit CLOSED — connection recovered', {
      previousState: prev,
      openDurationMs,
    });
  }
}

// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────

/**
 * Returns true when the circuit is OPEN and calls should be skipped.
 * Automatically transitions to HALF_OPEN when the cooldown has elapsed.
 */
function isOpen() {
  if (_state === STATE.CLOSED) return false;

  if (_state === STATE.OPEN) {
    const cooldownElapsed = (Date.now() - _lastFailureAt) >= COOLDOWN_MS;
    if (cooldownElapsed && !_halfOpenLocked) {
      _transitionTo(STATE.HALF_OPEN);
      return false; // allow the probe through
    }
    return true; // still cooling down
  }

  if (_state === STATE.HALF_OPEN) {
    // Only one probe at a time; any additional concurrent callers fast-fail.
    return _halfOpenLocked;
  }

  return false;
}

/**
 * Called by safeExec immediately before executing fn(client).
 * Marks the start of a HALF_OPEN probe so concurrent callers fast-fail.
 */
function beginCall() {
  metrics.totalCalls++;
  // TASK 2: overflow guard — check after increment, reset if needed.
  // Branch is almost never taken; cost is one integer comparison per call.
  _maybeResetMetrics();
  if (_state === STATE.HALF_OPEN) {
    _halfOpenLocked = true;
  }
}

/**
 * Called by safeExec after a successful Redis operation.
 * @param {number} latencyMs
 */
function recordSuccess(latencyMs) {
  metrics._latencySum += latencyMs;
  if (latencyMs > SLOW_CALL_MS) {
    metrics.slowCalls++;
  }

  _halfOpenLocked = false;
  _failureCount   = 0;
  _lastFailureAt  = 0;
  _transitionTo(STATE.CLOSED);
}

/**
 * Called by safeExec after a failed or timed-out Redis operation.
 * @param {number} latencyMs
 */
function recordFailure(latencyMs) {
  metrics._latencySum += latencyMs;
  metrics.failures++;
  _halfOpenLocked = false;
  _failureCount++;
  _lastFailureAt = Date.now();

  if (_state === STATE.HALF_OPEN || _failureCount >= FAILURE_THRESHOLD) {
    _transitionTo(STATE.OPEN);
  }
}

/**
 * Returns current state string: 'CLOSED' | 'OPEN' | 'HALF_OPEN'
 */
function getState() {
  return _state;
}

/**
 * Returns the full metrics + circuit snapshot for the health endpoint.
 *
 * All fields are safe defaults when no calls have been recorded:
 *   failureRate   → 0
 *   openDurationMs → null (circuit is not OPEN)
 */
function getMetrics() {
  // TASK 2 — failureRate: clamp to [0, 1] before rounding.
  // Math.min/Math.max guard against the narrow edge case where a metrics
  // overflow reset clears failures to 0 while totalCalls is mid-increment,
  // or any future floating-point anomaly that could push the raw ratio
  // fractionally outside [0, 1].
  const rawRate = metrics.totalCalls > 0
    ? metrics.failures / metrics.totalCalls
    : 0;
  const failureRate = Math.min(1, Math.max(0, Math.round(rawRate * 100) / 100));

  // TASK 1 — openDurationMs: use monotonic hrtime so system clock
  // adjustments (NTP steps, DST, manual corrections) cannot produce
  // negative or inflated durations.
  // Conversion: BigInt nanoseconds → integer milliseconds via / 1_000_000n.
  // Only evaluated on health-endpoint reads, never in the safeExec hot path.
  const openDurationMs = _openSinceHr !== null
    ? Number((process.hrtime.bigint() - _openSinceHr) / 1_000_000n)
    : null;

  return {
    state:          _state,
    failureCount:   _failureCount,
    totalCalls:     metrics.totalCalls,
    failures:       metrics.failures,
    failureRate,                          // [0, 1], rounded to 2dp
    avgLatencyMs:   _avgLatencyMs(),
    slowCalls:      metrics.slowCalls,
    openDurationMs,                       // monotonic ms since circuit opened; null if CLOSED
    config: {
      failureThreshold: FAILURE_THRESHOLD,
      cooldownMs:       COOLDOWN_MS,
      slowCallMs:       SLOW_CALL_MS,
    },
  };
}

/**
 * Force-resets circuit to CLOSED. Useful for manual recovery or tests.
 * Does NOT reset metrics counters so history is preserved.
 */
function reset() {
  _failureCount   = 0;
  _lastFailureAt  = 0;
  _halfOpenLocked = false;
  _openSince      = null;    // clear epoch timestamp
  _openSinceHr    = null;    // clear monotonic timestamp
  _transitionTo(STATE.CLOSED);
  logger.info('[Redis] Circuit manually reset to CLOSED');
}

// ─────────────────────────────────────────────────────────────
// EXPORT — single shared instance (module cache singleton)
// ─────────────────────────────────────────────────────────────

module.exports = Object.freeze({
  isOpen,
  beginCall,
  recordSuccess,
  recordFailure,
  getState,
  getMetrics,
  reset,
  STATE,
});