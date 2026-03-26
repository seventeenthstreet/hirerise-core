/**
 * src/modules/education/hooks/useAnalysisResult.js
 *
 * Fetches the stream analysis result for a given studentId.
 *
 * Behaviour:
 *   1. On mount, calls GET /education/analyze/:studentId (cached result).
 *   2. If the backend returns 404 (pipeline still running), polls every
 *      POLL_INTERVAL_MS until a result appears or MAX_POLLS is reached.
 *   3. Exposes loading, error, result, and a manual refetch() trigger.
 *
 * The polling covers the fire-and-forget pipeline window —
 * saveCognitive() triggers the pipeline in the background, so by the
 * time the user lands on the results page it may not be ready yet.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { educationApi } from '../services/education.api';

const POLL_INTERVAL_MS = 2000;   // retry every 2 s
const MAX_POLLS        = 15;     // give up after 30 s total

export function useAnalysisResult(studentId) {
  const [result,  setResult]  = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [polling, setPolling] = useState(false);

  const pollCount  = useRef(0);
  const pollTimer  = useRef(null);
  const mounted    = useRef(true);

  // ── Clear poll timer on unmount ───────────────────────────────────────────
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  // ── Core fetch ────────────────────────────────────────────────────────────
  const fetchResult = useCallback(async (isPoll = false) => {
    if (!studentId) return;

    if (!isPoll) {
      setLoading(true);
      setError(null);
      pollCount.current = 0;
    }

    try {
      const data = await educationApi.getAnalysisResult(studentId);

      if (!mounted.current) return;

      // Success — stop polling
      if (pollTimer.current) clearTimeout(pollTimer.current);
      setResult(data);
      setLoading(false);
      setPolling(false);
      pollCount.current = 0;

    } catch (err) {
      if (!mounted.current) return;

      // 404 = pipeline still running → poll
      const isNotReady = err?.status === 404 || err?.statusCode === 404 ||
                         err?.code === 'ANALYSIS_NOT_FOUND';

      if (isNotReady && pollCount.current < MAX_POLLS) {
        pollCount.current += 1;
        setPolling(true);
        setLoading(true);

        pollTimer.current = setTimeout(() => {
          if (mounted.current) fetchResult(true);
        }, POLL_INTERVAL_MS);

      } else {
        // Real error or gave up polling
        if (pollTimer.current) clearTimeout(pollTimer.current);
        setPolling(false);
        setLoading(false);

        if (isNotReady) {
          setError(
            'Analysis is taking longer than expected. ' +
            'Please refresh the page or try again in a moment.'
          );
        } else {
          setError(
            err?.message ||
            'We could not load your analysis results. Please try again.'
          );
        }
      }
    }
  }, [studentId]);

  // ── Initial fetch ─────────────────────────────────────────────────────────
  useEffect(() => {
    fetchResult(false);
  }, [fetchResult]);

  // ── Manual refetch (e.g. "Try Again" button) ──────────────────────────────
  const refetch = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollCount.current = 0;
    fetchResult(false);
  }, [fetchResult]);

  // ── Derived helpers ───────────────────────────────────────────────────────

  // Percentage through polling window (for loading progress bar)
  const pollProgress = polling
    ? Math.round((pollCount.current / MAX_POLLS) * 100)
    : loading ? 5 : 100;

  return {
    result,
    loading,
    polling,
    pollProgress,
    error,
    refetch,
  };
}








