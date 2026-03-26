/**
 * src/modules/education/hooks/useEducationForm.js
 *
 * Central form-state hook for the Education Intelligence onboarding wizard.
 *
 * Responsibilities:
 *   - Stores all step data in a single state object
 *   - Persists to localStorage so a page refresh never loses progress
 *   - Provides per-field setters consumed by each step page
 *   - Exposes a reset() to clear everything after successful submission
 *
 * Shape of persisted state:
 * {
 *   profile:    { name, email, education_level } | null
 *   academics:  [{ subject, class_level, marks }]
 *   activities: [{ activity_name, activity_level }]   (legacy row format)
 *   selectedActivities: string[]                      (chip-selector format)
 *   cognitive:  { analytical_score, logical_score, memory_score,
 *                 communication_score, creativity_score, raw_answers }  | null
 * }
 */

import { useState, useEffect, useCallback } from 'react';

// ─── constants ────────────────────────────────────────────────────────────────

const STORAGE_KEY  = 'edu_onboarding_form_v1';

const EMPTY_STATE = {
  profile:            null,
  academics:          [{ subject: '', class_level: '', marks: '' }],
  activities:         [{ activity_name: '', activity_level: '' }],
  selectedActivities: [],
  cognitive:          {
    analytical_score:    50,
    logical_score:       50,
    memory_score:        50,
    communication_score: 50,
    creativity_score:    50,
    raw_answers:         {},
  },
};

// ─── helpers ─────────────────────────────────────────────────────────────────

function loadFromStorage() {
  if (typeof window === 'undefined') return EMPTY_STATE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_STATE;
    return { ...EMPTY_STATE, ...JSON.parse(raw) };
  } catch {
    return EMPTY_STATE;
  }
}

function saveToStorage(state) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // quota exceeded — fail silently
  }
}

// ─── hook ────────────────────────────────────────────────────────────────────

export function useEducationForm() {
  const [form, setFormRaw] = useState(loadFromStorage);

  // Persist every change to localStorage
  useEffect(() => {
    saveToStorage(form);
  }, [form]);

  // Generic setter — merges a partial update into the top-level form state
  const setForm = useCallback((updater) => {
    setFormRaw((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater };
      return next;
    });
  }, []);

  // ── Step-specific setters ─────────────────────────────────────────────────

  /** Save profile step data (name, email, education_level) */
  const setProfile = useCallback((profile) => {
    setForm((f) => ({ ...f, profile }));
  }, [setForm]);

  /** Replace the full academics rows array */
  const setAcademics = useCallback((academics) => {
    setForm((f) => ({ ...f, academics }));
  }, [setForm]);

  /** Update a single academic row by index */
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
      academics: [...f.academics, { subject: '', class_level: '', marks: '' }],
    }));
  }, [setForm]);

  const removeAcademicRow = useCallback((index) => {
    setForm((f) => ({
      ...f,
      academics: f.academics.length > 1
        ? f.academics.filter((_, i) => i !== index)
        : f.academics,
    }));
  }, [setForm]);

  /** Replace selected activity names (chip-selector format) */
  const setSelectedActivities = useCallback((selectedActivities) => {
    setForm((f) => ({ ...f, selectedActivities }));
  }, [setForm]);

  /** Replace the legacy activity rows array (row-input format) */
  const setActivities = useCallback((activities) => {
    setForm((f) => ({ ...f, activities }));
  }, [setForm]);

  /** Merge cognitive score fields */
  const setCognitive = useCallback((cognitive) => {
    setForm((f) => ({ ...f, cognitive: { ...f.cognitive, ...cognitive } }));
  }, [setForm]);

  /** Set a single cognitive score key */
  const setCognitiveScore = useCallback((key, value) => {
    setForm((f) => ({
      ...f,
      cognitive: { ...f.cognitive, [key]: Number(value) },
    }));
  }, [setForm]);

  /** Store raw aptitude question answers */
  const setRawAnswers = useCallback((raw_answers) => {
    setForm((f) => ({
      ...f,
      cognitive: { ...f.cognitive, raw_answers },
    }));
  }, [setForm]);

  /** Wipe localStorage + reset to empty state after successful submission */
  const reset = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    setFormRaw(EMPTY_STATE);
  }, []);

  // ── Derived helpers ───────────────────────────────────────────────────────

  const isProfileComplete = Boolean(
    form.profile?.name?.trim() &&
    form.profile?.email?.trim() &&
    form.profile?.education_level
  );

  const isAcademicsComplete = form.academics.length > 0 &&
    form.academics.every((r) => r.subject && r.class_level && r.marks !== '');

  const isActivitiesComplete =
    form.selectedActivities.length > 0 ||
    (form.activities.length > 0 && form.activities.every((r) => r.activity_name?.trim() && r.activity_level));

  const isCognitiveComplete = Boolean(form.cognitive);

  return {
    // Raw state
    form,

    // Per-section data (convenience destructure)
    profile:            form.profile,
    academics:          form.academics,
    activities:         form.activities,
    selectedActivities: form.selectedActivities,
    cognitive:          form.cognitive,

    // Setters
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

    // Validation flags
    isProfileComplete,
    isAcademicsComplete,
    isActivitiesComplete,
    isCognitiveComplete,
  };
}








