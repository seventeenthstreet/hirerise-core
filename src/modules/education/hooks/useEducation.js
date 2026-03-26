/**
 * src/modules/education/hooks/useEducation.js
 *
 * Central state hook for the Education Intelligence onboarding flow.
 *
 * UPDATED (Step 5):
 *  - submitCognitive() now redirects to /education/results/:uid after saving
 *  - next/router → next/navigation (App Router compatible)
 */

import { useState, useCallback } from 'react';
import { useRouter }             from 'next/navigation';
import { educationApi }          from '../services/education.api';

const STEPS = ['profile', 'academics', 'activities', 'cognitive', 'complete'];

export function useEducation() {
  const router = useRouter();

  const [currentStep, setCurrentStep] = useState('profile');
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState(null);
  const [profile,     setProfile]     = useState(null);

  const clearError = useCallback(() => setError(null), []);

  const _wrap = useCallback(async (fn) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fn();
      return result;
    } catch (err) {
      const msg = err?.message || 'Something went wrong. Please try again.';
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const submitProfile = useCallback((payload) => _wrap(async () => {
    const { data } = await educationApi.createStudent(payload);
    setCurrentStep('academics');
    return data;
  }), [_wrap]);

  const submitAcademics = useCallback((records) => _wrap(async () => {
    const { data } = await educationApi.saveAcademics(records);
    setCurrentStep('activities');
    return data;
  }), [_wrap]);

  const submitActivities = useCallback((activities) => _wrap(async () => {
    const { data } = await educationApi.saveActivities(activities);
    setCurrentStep('cognitive');
    return data;
  }), [_wrap]);

  /**
   * Saves cognitive scores then redirects to /education/results/:studentId.
   * The backend fires the AI pipeline in the background — the results page
   * polls until the recommendation is ready.
   */
  const submitCognitive = useCallback((payload) => _wrap(async () => {
    const { data } = await educationApi.saveCognitive(payload);
    setCurrentStep('complete');

    const studentId =
      profile?.student?.id ||
      data?.cognitive?.student_id;

    if (studentId) {
      router.push(`/education/results/${studentId}`);
    } else {
      router.push('/education/results/me');
    }

    return data;
  }), [_wrap, router, profile]);

  const loadProfile = useCallback((userId) => _wrap(async () => {
    try {
      const { data } = await educationApi.getStudentProfile(userId);
      setProfile(data);
      if (data?.student?.onboarding_step) {
        setCurrentStep(data.student.onboarding_step);
      }
      return data;
    } catch (err) {
      if (err?.statusCode === 404 || err?.status === 404) {
        setCurrentStep('profile');
        return null;
      }
      throw err;
    }
  }), [_wrap]);

  const goBack = useCallback(() => {
    const idx = STEPS.indexOf(currentStep);
    if (idx > 0) setCurrentStep(STEPS[idx - 1]);
  }, [currentStep]);

  const stepIndex   = STEPS.indexOf(currentStep);
  const totalSteps  = STEPS.length - 1;
  const progressPct = Math.round(Math.min((stepIndex / totalSteps) * 100, 100));

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
    loadProfile,
    goBack,
    clearError,
  };
}








