/**
 * src/modules/education/hooks/useAnalysisResult.js
 *
 * Production-hardened analysis result polling hook.
 *
 * Improvements:
 * - stale request protection
 * - duplicate timer prevention
 * - unmount-safe async flow
 * - studentId change safety
 * - stable polling lifecycle
 * - improved error normalization
 * - derived progress memoization
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { educationApi } from '../services/education.api';

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 15;

function normalizeError(err) {
  return (
    err?.message ||
    err?.error?.message ||
    'We could not load your analysis results. Please try again.'
  );
}

function isAnalysisPendingError(err) {
  return (
    err?.status === 404 ||
    err?.statusCode === 404 ||
    err?.response?.status === 404 ||
    err?.code === 'ANALYSIS_NOT_FOUND'
  );
}

export function useAnalysisResult(studentId) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(Boolean(studentId));
  const [error, setError] = useState(null);
  const [polling, setPolling] = useState(false);

  const pollCountRef = useRef(0);
  const pollTimerRef = useRef(null);
  const mountedRef = useRef(false);
  const requestIdRef = useRef(0);

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      clearPollTimer();
    };
  }, [clearPollTimer]);

  const fetchResult = useCallback(
    async (isPoll = false) => {
      if (!studentId) {
        setLoading(false);
        setPolling(false);
        setResult(null);
        setError(null);
        return;
      }

      const requestId = ++requestIdRef.current;

      if (!isPoll) {
        clearPollTimer();
        pollCountRef.current = 0;
        setLoading(true);
        setPolling(false);
        setError(null);
      }

      try {
        const data = await educationApi.getAnalysisResult(studentId);

        if (!mountedRef.current || requestId !== requestIdRef.current) {
          return;
        }

        clearPollTimer();
        pollCountRef.current = 0;

        setResult(data);
        setLoading(false);
        setPolling(false);
        setError(null);
      } catch (err) {
        if (!mountedRef.current || requestId !== requestIdRef.current) {
          return;
        }

        const pending = isAnalysisPendingError(err);

        if (pending && pollCountRef.current < MAX_POLLS) {
          pollCountRef.current += 1;

          setPolling(true);
          setLoading(true);

          clearPollTimer();

          pollTimerRef.current = window.setTimeout(() => {
            if (mountedRef.current) {
              fetchResult(true);
            }
          }, POLL_INTERVAL_MS);

          return;
        }

        clearPollTimer();
        setPolling(false);
        setLoading(false);

        if (pending) {
          setError(
            'Analysis is taking longer than expected. Please refresh the page or try again in a moment.'
          );
        } else {
          setError(normalizeError(err));
        }
      }
    },
    [studentId, clearPollTimer]
  );

  useEffect(() => {
    fetchResult(false);
  }, [fetchResult]);

  const refetch = useCallback(() => {
    requestIdRef.current += 1;
    clearPollTimer();
    pollCountRef.current = 0;
    fetchResult(false);
  }, [fetchResult, clearPollTimer]);

  const pollProgress = useMemo(() => {
    if (polling) {
      return Math.round((pollCountRef.current / MAX_POLLS) * 100);
    }

    if (loading) return 5;
    return 100;
  }, [polling, loading, result]);

  return {
    result,
    loading,
    polling,
    pollProgress,
    error,
    refetch,
  };
}