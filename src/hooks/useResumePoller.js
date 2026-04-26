/**
 * src/hooks/useResumePoller.js
 *
 * React hook — production-safe polling for async resume processing.
 *
 * Wraps the core resumePoller engine with:
 *   - React state management
 *   - Strict single-loop deduplication (one active poller per resumeId)
 *   - Automatic cleanup on unmount and resumeId change
 *   - Stale-request protection (ignores callbacks after unmount / resumeId swap)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POLLING PARAMETERS  (from resumePoller.js — do not re-declare here)
 * ─────────────────────────────────────────────────────────────────────────────
 *   Interval:      5 s
 *   Max attempts:  18  (~90 s)
 *   Max duration:  90 s (hard ceiling)
 *   Net retries:   3   (with exponential backoff: 5 s → 10 s → 20 s)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * USAGE
 * ─────
 *   const {
 *     status,           // 'idle' | 'polling' | 'done' | 'failed' | 'timeout' | 'network_error'
 *     result,           // object when status === 'done'
 *     error,            // { code, message } when status is terminal-error
 *     progressPct,      // 0–100 for progress bar
 *     attempt,          // current attempt number
 *     restart,          // () => void — manually restart polling
 *   } = useResumePoller(resumeId, apiFetchFn);
 *
 *   // apiFetchFn: () => Promise<ApiResponse>
 *   // Pass null/undefined for resumeId to keep the hook idle.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { createResumePoller, MAX_ATTEMPTS } from '../lib/polling/resumePoller';

// ─── Status constants (exported so callers can import rather than hard-code strings)

export const POLL_STATUS = Object.freeze({
  IDLE:          'idle',
  POLLING:       'polling',
  DONE:          'done',
  FAILED:        'failed',
  TIMEOUT:       'timeout',
  NETWORK_ERROR: 'network_error',
});

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * @param {string|null|undefined} resumeId
 * @param {Function|null|undefined} fetchStatus  - () => Promise<ApiResponse>
 * @param {object} [opts]
 * @param {boolean} [opts.autoStart=true]  - start polling as soon as resumeId is set
 */
export function useResumePoller(resumeId, fetchStatus, opts = {}) {
  const { autoStart = true } = opts;

  const [status, setStatus]       = useState(POLL_STATUS.IDLE);
  const [result, setResult]       = useState(null);
  const [error, setError]         = useState(null);
  const [progressPct, setProgress] = useState(0);
  const [attempt, setAttempt]     = useState(0);

  // Refs that survive re-renders without triggering them
  const mountedRef   = useRef(false);
  const pollerRef    = useRef(null);
  const resumeIdRef  = useRef(resumeId);

  // ── Mount / unmount tracking ───────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ── Core start function ────────────────────────────────────────────────
  const startPolling = useCallback((id, fetcher) => {
    if (!id || !fetcher) return;

    // Tear down any poller from a previous resumeId
    if (pollerRef.current) {
      pollerRef.current.stop();
      pollerRef.current = null;
    }

    setStatus(POLL_STATUS.POLLING);
    setResult(null);
    setError(null);
    setProgress(0);
    setAttempt(0);

    const poller = createResumePoller(id, fetcher, {
      onPending({ attempt: a, progressPct: pct }) {
        if (!mountedRef.current) return;
        setAttempt(a);
        setProgress(pct);
        // status stays 'polling'
      },

      onDone(res) {
        if (!mountedRef.current) return;
        setResult(res);
        setProgress(100);
        setStatus(POLL_STATUS.DONE);
        pollerRef.current = null;
      },

      onFailed(err) {
        if (!mountedRef.current) return;
        const isNetwork = err?.code === 'NETWORK_ERROR';
        setError(err);
        setStatus(isNetwork ? POLL_STATUS.NETWORK_ERROR : POLL_STATUS.FAILED);
        pollerRef.current = null;
      },

      onTimeout() {
        if (!mountedRef.current) return;
        setError({
          code:    'TIMEOUT',
          message: 'Processing is taking longer than expected. Please try again in a moment.',
        });
        setStatus(POLL_STATUS.TIMEOUT);
        pollerRef.current = null;
      },
    });

    pollerRef.current = poller;
    poller.start();
  }, []); // no deps — stable across renders

  // ── Auto-start on resumeId change ─────────────────────────────────────
  useEffect(() => {
    resumeIdRef.current = resumeId;

    if (!resumeId || !fetchStatus) {
      // No resumeId — reset to idle, stop any running poller
      if (pollerRef.current) {
        pollerRef.current.stop();
        pollerRef.current = null;
      }
      setStatus(POLL_STATUS.IDLE);
      return;
    }

    if (autoStart) {
      startPolling(resumeId, fetchStatus);
    }

    // Cleanup: stop the poller when resumeId changes or component unmounts
    return () => {
      if (pollerRef.current) {
        pollerRef.current.stop();
        pollerRef.current = null;
      }
    };
  }, [resumeId, fetchStatus, autoStart, startPolling]);

  // ── Expose manual restart ──────────────────────────────────────────────
  const restart = useCallback(() => {
    const id      = resumeIdRef.current;
    const fetcher = fetchStatus;
    if (id && fetcher) {
      startPolling(id, fetcher);
    }
  }, [fetchStatus, startPolling]);

  // ── Expose manual stop ────────────────────────────────────────────────
  const stop = useCallback(() => {
    if (pollerRef.current) {
      pollerRef.current.stop();
      pollerRef.current = null;
    }
    setStatus(POLL_STATUS.IDLE);
  }, []);

  // ── Derived helpers ───────────────────────────────────────────────────
  const isPolling  = status === POLL_STATUS.POLLING;
  const isTerminal = status === POLL_STATUS.DONE ||
                     status === POLL_STATUS.FAILED ||
                     status === POLL_STATUS.TIMEOUT ||
                     status === POLL_STATUS.NETWORK_ERROR;

  return {
    status,
    result,
    error,
    progressPct,
    attempt,
    maxAttempts: MAX_ATTEMPTS,
    isPolling,
    isTerminal,
    restart,
    stop,
  };
}