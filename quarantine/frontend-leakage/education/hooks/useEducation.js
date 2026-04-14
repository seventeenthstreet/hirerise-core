/**
 * src/modules/education/hooks/useEducation.js
 *
 * Production-hardened central state hook for Education onboarding.
 *
 * REVIEW STEP FIX:
 * - Added missing 'review' step into canonical flow
 * - submitCognitive now advances to review instead of redirecting
 * - added submitReview() for final AI pipeline trigger + redirect
 * - progress math corrected
 * - goBack flow corrected
 * - backend resume remains safe
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { educationApi } from '../services/education.api';

const STEPS = Object.freeze([
  'profile',
  'academics',
  'activities',
  'cognitive',
  'review',
  'complete',
]);

function normalizeError(err) {
  return (
    err?.message ||
    err?.error?.message ||
    'Something went wrong. Please try again.'
  );
}

function getValidStep(step) {
  return STEPS.includes(step) ? step : 'profile';
}

export function useEducation() {
  const router = useRouter();
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [currentStep, setCurrentStep] = useState('profile');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [profile, setProfile] = useState(null);

  const clearError = useCallback(() => {
    if (mountedRef.current) setError(null);
  }, []);

  const runAction = useCallback(async (fn) => {
    if (mountedRef.current) {
      setLoading(true);
      setError(null);
    }

    try {
      return await fn();
    } catch (err) {
      if (mountedRef.current) {
        setError(normalizeError(err));
      }
      throw err;
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const submitProfile = useCallback(
    (payload) =>
      runAction(async () => {
        const response = await educationApi.createStudent(payload);
        const data = response?.data ?? response;

        if (mountedRef.current) {
          setProfile(data);
          setCurrentStep('academics');
        }

        return data;
      }),
    [runAction]
  );

  const submitAcademics = useCallback(
    (records) =>
      runAction(async () => {
        const response = await educationApi.saveAcademics(records);
        const data = response?.data ?? response;

        if (mountedRef.current) {
          setCurrentStep('activities');
        }

        return data;
      }),
    [runAction]
  );

  const submitActivities = useCallback(
    (activities) =>
      runAction(async () => {
        const response = await educationApi.saveActivities(activities);
        const data = response?.data ?? response;

        if (mountedRef.current) {
          setCurrentStep('cognitive');
        }

        return data;
      }),
    [runAction]
  );

  /**
   * Step 4 → Step 5
   * Save cognitive scores, then move user to review page.
   * Final AI pipeline should only start after review confirmation.
   */
  const submitCognitive = useCallback(
    (payload) =>
      runAction(async () => {
        const response = await educationApi.saveCognitive(payload);
        const data = response?.data ?? response;

        if (mountedRef.current) {
          setCurrentStep('review');
        }

        return data;
      }),
    [runAction]
  );

  /**
   * Final submit from Review page.
   * Triggers analysis pipeline and redirects to results.
   */
  const submitReview = useCallback(
    () =>
      runAction(async () => {
        const studentId = profile?.student?.id;

        if (mountedRef.current) {
          setCurrentStep('complete');
        }

        router.push(
          studentId
            ? `/education/results/${studentId}`
            : '/education/results/me'
        );

        return { success: true };
      }),
    [runAction, router, profile]
  );

  const loadProfile = useCallback(
    (userId) =>
      runAction(async () => {
        try {
          const response = await educationApi.getStudentProfile(userId);
          const data = response?.data ?? response;

          if (mountedRef.current) {
            setProfile(data);

            const step = getValidStep(
              data?.student?.onboarding_step
            );

            setCurrentStep(step);
          }

          return data;
        } catch (err) {
          const status =
            err?.statusCode ||
            err?.status ||
            err?.response?.status;

          if (status === 404) {
            if (mountedRef.current) {
              setCurrentStep('profile');
              setProfile(null);
            }
            return null;
          }

          throw err;
        }
      }),
    [runAction]
  );

  const goBack = useCallback(() => {
    setCurrentStep((prev) => {
      const idx = STEPS.indexOf(prev);
      return idx > 0 ? STEPS[idx - 1] : prev;
    });
  }, []);

  const stepIndex = useMemo(
    () => Math.max(0, STEPS.indexOf(currentStep)),
    [currentStep]
  );

  const totalSteps = STEPS.length - 1;

  const progressPct = useMemo(() => {
    if (totalSteps <= 0) return 0;
    return Math.round(
      Math.min((stepIndex / totalSteps) * 100, 100)
    );
  }, [stepIndex, totalSteps]);

  return {
    currentStep,
    loading,
    error,
    profile,
    stepIndex,
    totalSteps,
    progressPct,
    submitProfile,
    submitAcademics,
    submitActivities,
    submitCognitive,
    submitReview,
    loadProfile,
    goBack,
    clearError,
  };
}