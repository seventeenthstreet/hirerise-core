/**
 * src/lib/polling/resumePoller.js
 *
 * Framework-agnostic core polling engine for async resume processing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Canonical endpoint:  GET /api/v1/resumes/:resumeId/status
 * Identifier:          resumeId   (NEVER jobId — see docs/frontend-contract.md)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POLLING PARAMETERS  (all values enforced — do not override arbitrarily)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   POLL_INTERVAL_MS        5 000 ms   (5 s between each attempt)
 *   MAX_ATTEMPTS            18         (~90 s total at 5 s cadence)
 *   MAX_DURATION_MS         90 000 ms  (hard wall-clock ceiling)
 *   NETWORK_RETRY_MAX       3          (consecutive network failures before abort)
 *   NETWORK_BACKOFF_BASE_MS 5 000 ms   (first retry delay; doubles each time)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STATUS HANDLING
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   pending | processing  →  continue polling
 *   done                  →  stop, deliver result
 *   failed                →  stop, deliver error
 *   [timeout / max]       →  stop, deliver TIMEOUT error
 *   [network error ×3]    →  stop, deliver NETWORK_ERROR
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEDUPLICATION
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Only ONE active poller per resumeId is allowed globally.
 * Calling createResumePoller() for a resumeId that is already polling returns
 * the existing instance without starting a second loop.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   import { createResumePoller } from '@/lib/polling/resumePoller';
 *
 *   const poller = createResumePoller(resumeId, fetchFn, {
 *     onPending:  ({ attempt, maxAttempts }) => setProgress(...),
 *     onDone:     (result)  => handleResult(result),
 *     onFailed:   (error)   => handleError(error),
 *     onTimeout:  ()        => handleTimeout(),
 *   });
 *
 *   poller.start();
 *
 *   // on component unmount:
 *   poller.stop();
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Milliseconds between each polling tick. */
export const POLL_INTERVAL_MS = 5_000;

/**
 * Maximum number of poll attempts before giving up.
 * At 5 s/attempt this gives ~90 s total.
 */
export const MAX_ATTEMPTS = 18;

/** Hard wall-clock ceiling regardless of attempt count. */
export const MAX_DURATION_MS = 90_000;

/** How many consecutive network errors to tolerate before aborting. */
export const NETWORK_RETRY_MAX = 3;

/** Base backoff delay for network retries (doubles each time). */
export const NETWORK_BACKOFF_BASE_MS = 5_000;

// ─── Terminal status values ───────────────────────────────────────────────────

const TERMINAL_SUCCESS = 'done';
const TERMINAL_FAILURE = 'failed';
const CONTINUE_STATUSES = new Set(['pending', 'processing']);

// ─────────────────────────────────────────────────────────────────────────────
// Status normalization (backward compatibility)
//
// The DB and some older API endpoints write 'complete' as the completion state.
// The canonical public contract uses 'done' only.
// This function maps 'complete' → 'done' at the poller boundary so the rest
// of the poller logic only ever sees the four canonical values.
//
// Canonical values: pending | processing | done | failed
// Deprecated value: 'complete' → silently mapped to 'done'
// ─────────────────────────────────────────────────────────────────────────────
function normalizeApiStatus(raw) {
  if (raw === 'complete') return 'done';
  return raw;
}

// ─── Global deduplication registry ───────────────────────────────────────────
// Prevents more than one active poller per resumeId across the entire app.

const _activePollers = new Map(); // resumeId → poller instance

// ─── Helpers ─────────────────────────────────────────────────────────────────

function calcNetworkBackoff(retryCount) {
  return NETWORK_BACKOFF_BASE_MS * Math.pow(2, retryCount); // 5s, 10s, 20s
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * createResumePoller
 *
 * @param {string} resumeId       - The resume's stable UUID.
 * @param {Function} fetchStatus  - () => Promise<{ success, data: { resume: { status, result?, error? } } }>
 * @param {object}  callbacks
 * @param {Function} callbacks.onPending  - ({ attempt, maxAttempts, progressPct }) => void
 * @param {Function} callbacks.onDone     - (result: object) => void
 * @param {Function} callbacks.onFailed   - ({ code, message, raw? }) => void
 * @param {Function} callbacks.onTimeout  - () => void
 * @returns {{ start: Function, stop: Function, isActive: () => boolean }}
 */
export function createResumePoller(resumeId, fetchStatus, callbacks = {}) {
  // ── Deduplication guard ──────────────────────────────────────────────────
  if (_activePollers.has(resumeId)) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        `[ResumePoller] Poller already active for resumeId="${resumeId}". ` +
        'Returning existing instance — no duplicate loop started.'
      );
    }
    return _activePollers.get(resumeId);
  }

  // ── Internal state ───────────────────────────────────────────────────────
  let active            = false;
  let attempt           = 0;
  let networkErrorCount = 0;
  let timerId           = null;
  let wallClockTimerId  = null;

  const { onPending, onDone, onFailed, onTimeout } = callbacks;

  // ── Cleanup ──────────────────────────────────────────────────────────────
  function _clearTimers() {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    if (wallClockTimerId !== null) {
      clearTimeout(wallClockTimerId);
      wallClockTimerId = null;
    }
  }

  function _teardown() {
    active = false;
    _clearTimers();
    _activePollers.delete(resumeId);
  }

  // ── Single tick ──────────────────────────────────────────────────────────
  async function _tick() {
    if (!active) return;

    attempt += 1;

    // Attempt-count ceiling
    if (attempt > MAX_ATTEMPTS) {
      _teardown();
      onTimeout?.();
      return;
    }

    let json;

    try {
      json = await fetchStatus();
      networkErrorCount = 0; // reset on any successful HTTP response
    } catch (networkErr) {
      // ── Network failure path ─────────────────────────────────────────────
      networkErrorCount += 1;

      if (networkErrorCount > NETWORK_RETRY_MAX) {
        _teardown();
        onFailed?.({
          code:    'NETWORK_ERROR',
          message: 'Network error after maximum retries. Please check your connection.',
          raw:     networkErr,
        });
        return;
      }

      // Exponential backoff before next attempt
      const backoff = calcNetworkBackoff(networkErrorCount - 1);

      if (!active) return;

      timerId = setTimeout(_tick, backoff);
      return;
    }

    if (!active) return;

    // ── Response validation ──────────────────────────────────────────────
    if (!json?.success) {
      _teardown();
      onFailed?.({
        code:    'RESPONSE_ERROR',
        message: json?.error ?? json?.message ?? 'Unexpected response from server.',
        raw:     json,
      });
      return;
    }

    const resume = json?.data?.resume;

    if (!resume) {
      _teardown();
      onFailed?.({
        code:    'MALFORMED_RESPONSE',
        message: 'Response missing data.resume shape.',
        raw:     json,
      });
      return;
    }

    // normalizeApiStatus maps deprecated 'complete' → canonical 'done'.
    // All downstream logic only ever sees: pending | processing | done | failed.
    const status = normalizeApiStatus(resume.status);

    // ── Terminal: success ────────────────────────────────────────────────
    if (status === TERMINAL_SUCCESS) {
      _teardown();
      onDone?.(resume.result ?? resume);
      return;
    }

    // ── Terminal: failure ────────────────────────────────────────────────
    if (status === TERMINAL_FAILURE) {
      _teardown();
      onFailed?.({
        code:    resume.error?.code    ?? 'PROCESSING_FAILED',
        message: resume.error?.message ?? 'Resume processing failed.',
        raw:     resume.error,
      });
      return;
    }

    // ── Safety guard: unknown status ─────────────────────────────────────
    // Any value not in CONTINUE_STATUSES that was not caught above is a
    // contract violation. Stop polling immediately to prevent infinite loops.
    // Log at error level in all environments so it surfaces in observability.
    if (!CONTINUE_STATUSES.has(status)) {
      console.error(
        `[ResumePoller] CONTRACT_VIOLATION: unknown status="${status}" ` +
        `for resumeId="${resumeId}" — stopping poll and treating as failure.`
      );
      _teardown();
      onFailed?.({
        code:    'UNKNOWN_STATUS',
        message: `Unexpected processing status received: "${status}". ` +
                 'Please contact support if this persists.',
        raw:     { status, resumeId },
      });
      return;
    }

    // ── Continue polling ─────────────────────────────────────────────────
    const progressPct = Math.min(Math.round((attempt / MAX_ATTEMPTS) * 100), 99);

    onPending?.({ attempt, maxAttempts: MAX_ATTEMPTS, progressPct, status });

    if (!active) return;

    timerId = setTimeout(_tick, POLL_INTERVAL_MS);
  }

  // ── Public API ───────────────────────────────────────────────────────────
  const poller = {
    start() {
      if (active) return this; // idempotent

      active = true;
      attempt = 0;
      networkErrorCount = 0;
      _activePollers.set(resumeId, this);

      // Hard wall-clock ceiling — fires regardless of attempt state
      wallClockTimerId = setTimeout(() => {
        if (!active) return;
        _teardown();
        onTimeout?.();
      }, MAX_DURATION_MS);

      // Kick off first tick immediately
      timerId = setTimeout(_tick, 0);

      return this;
    },

    stop() {
      _teardown();
      return this;
    },

    isActive() {
      return active;
    },
  };

  return poller;
}

/**
 * isResumePolling
 * Returns true if there is an active poller for this resumeId.
 * Useful for preventing duplicate start() calls from different components.
 *
 * @param {string} resumeId
 * @returns {boolean}
 */
export function isResumePolling(resumeId) {
  return _activePollers.has(resumeId);
}

/**
 * stopAllPollers
 * Emergency cleanup — stops every active poller.
 * Use on global error boundaries or app teardown.
 */
export function stopAllPollers() {
  for (const poller of _activePollers.values()) {
    poller.stop();
  }
}