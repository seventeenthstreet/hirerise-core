/**
 * src/modules/education/hooks/useEducationForm.js
 *
 * Production-hardened central form-state hook for Education onboarding.
 *
 * Improvements:
 * - SSR-safe localStorage hydration
 * - schema-safe storage migration
 * - immutable empty state factory
 * - stale closure safe setters
 * - row array safety
 * - numeric score normalization
 * - derived validation memoization
 */

import { useState, useEffect, useCallback, useMemo } from 'react';

// ───────────────────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'edu_onboarding_form_v1';

function createEmptyState() {
  return {
    profile: null,
    academics: [{ subject: '', class_level: '', marks: '' }],
    activities: [{ activity_name: '', activity_level: '' }],
    selectedActivities: [],
    cognitive: {
      analytical_score: 50,
      logical_score: 50,
      memory_score: 50,
      communication_score: 50,
      creativity_score: 50,
      raw_answers: {},
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────

function safeArray(value, fallback) {
  return Array.isArray(value) ? value : fallback;
}

function normalizeStoredState(raw) {
  const base = createEmptyState();
  const data = raw && typeof raw === 'object' ? raw : {};

  return {
    ...base,
    ...data,
    academics: safeArray(data.academics, base.academics),
    activities: safeArray(data.activities, base.activities),
    selectedActivities: safeArray(
      data.selectedActivities,
      base.selectedActivities
    ),
    cognitive: {
      ...base.cognitive,
      ...(data.cognitive || {}),
      raw_answers:
        data?.cognitive?.raw_answers &&
        typeof data.cognitive.raw_answers === 'object'
          ? data.cognitive.raw_answers
          : {},
    },
  };
}

function loadFromStorage() {
  if (typeof window === 'undefined') {
    return createEmptyState();
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return createEmptyState();

    return normalizeStoredState(JSON.parse(raw));
  } catch {
    return createEmptyState();
  }
}

function saveToStorage(state) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(state)
    );
  } catch {
    // quota exceeded / private mode — fail silently
  }
}

function clampScore(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return 50;
  return Math.max(0, Math.min(100, num));
}

// ───────────────────────────────────────────────────────────────────────────────
// Hook
// ───────────────────────────────────────────────────────────────────────────────

export function useEducationForm() {
  const [form, setFormRaw] = useState(loadFromStorage);

  useEffect(() => {
    saveToStorage(form);
  }, [form]);

  const setForm = useCallback((updater) => {
    setFormRaw((prev) => {
      const next =
        typeof updater === 'function'
          ? updater(prev)
          : { ...prev, ...updater };

      return normalizeStoredState(next);
    });
  }, []);

  const setProfile = useCallback((profile) => {
    setForm((f) => ({ ...f, profile }));
  }, [setForm]);

  const setAcademics = useCallback((academics) => {
    setForm((f) => ({
      ...f,
      academics: safeArray(academics, f.academics),
    }));
  }, [setForm]);

  const updateAcademicRow = useCallback((index, field, value) => {
    setForm((f) => ({
      ...f,
      academics: f.academics.map((row, i) =>
        i === index ? { ...row, [field]: value } : row
      ),
    }));
  }, [setForm]);

  const addAcademicRow = useCallback(() => {
    setForm((f) => ({
      ...f,
      academics: [
        ...f.academics,
        { subject: '', class_level: '', marks: '' },
      ],
    }));
  }, [setForm]);

  const removeAcademicRow = useCallback((index) => {
    setForm((f) => ({
      ...f,
      academics:
        f.academics.length > 1
          ? f.academics.filter((_, i) => i !== index)
          : f.academics,
    }));
  }, [setForm]);

  const setSelectedActivities = useCallback((selectedActivities) => {
    setForm((f) => ({
      ...f,
      selectedActivities: safeArray(
        selectedActivities,
        f.selectedActivities
      ),
    }));
  }, [setForm]);

  const setActivities = useCallback((activities) => {
    setForm((f) => ({
      ...f,
      activities: safeArray(activities, f.activities),
    }));
  }, [setForm]);

  const setCognitive = useCallback((cognitive) => {
    setForm((f) => ({
      ...f,
      cognitive: {
        ...f.cognitive,
        ...(cognitive || {}),
      },
    }));
  }, [setForm]);

  const setCognitiveScore = useCallback((key, value) => {
    setForm((f) => ({
      ...f,
      cognitive: {
        ...f.cognitive,
        [key]: clampScore(value),
      },
    }));
  }, [setForm]);

  const setRawAnswers = useCallback((raw_answers) => {
    setForm((f) => ({
      ...f,
      cognitive: {
        ...f.cognitive,
        raw_answers:
          raw_answers && typeof raw_answers === 'object'
            ? raw_answers
            : {},
      },
    }));
  }, [setForm]);

  const reset = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(STORAGE_KEY);
    }

    setFormRaw(createEmptyState());
  }, []);

  const validation = useMemo(() => {
    const isProfileComplete = Boolean(
      form.profile?.name?.trim() &&
      form.profile?.email?.trim() &&
      form.profile?.education_level
    );

    const isAcademicsComplete =
      form.academics.length > 0 &&
      form.academics.every(
        (row) =>
          row.subject &&
          row.class_level &&
          row.marks !== ''
      );

    const isActivitiesComplete =
      form.selectedActivities.length > 0 ||
      (
        form.activities.length > 0 &&
        form.activities.every(
          (row) =>
            row.activity_name?.trim() &&
            row.activity_level
        )
      );

    const isCognitiveComplete = Boolean(form.cognitive);

    return {
      isProfileComplete,
      isAcademicsComplete,
      isActivitiesComplete,
      isCognitiveComplete,
    };
  }, [form]);

  return {
    form,

    profile: form.profile,
    academics: form.academics,
    activities: form.activities,
    selectedActivities: form.selectedActivities,
    cognitive: form.cognitive,

    setProfile,
    setAcademics,
    updateAcademicRow,
    addAcademicRow,
    removeAcademicRow,
    setSelectedActivities,
    setActivities,
    setCognitive,
    setCognitiveScore,
    setRawAnswers,
    reset,

    ...validation,
  };
}