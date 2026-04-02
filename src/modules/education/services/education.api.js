/**
 * src/modules/education/services/education.api.js
 *
 * Production-hardened Education Intelligence API service.
 *
 * Supabase-safe improvements:
 * - zero Firebase legacy assumptions
 * - stable REST response normalization
 * - URL-safe studentId encoding
 * - shared request builders
 * - cleaner query param handling
 * - stronger null safety
 * - easier Edge Function compatibility
 */

import { apiFetch } from '@/services/apiClient';

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────

function safeId(value) {
  return encodeURIComponent(String(value || 'me'));
}

function jsonPost(path, payload) {
  return apiFetch(path, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

function buildQuery(params = {}) {
  const search = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      search.set(key, String(value));
    }
  });

  const query = search.toString();
  return query ? `?${query}` : '';
}

// ───────────────────────────────────────────────────────────────────────────────
// Student lifecycle
// ───────────────────────────────────────────────────────────────────────────────

export function createStudent(payload = {}) {
  return jsonPost('/education/student', payload);
}

export function getStudentProfile(userId) {
  return apiFetch(`/education/student/${safeId(userId)}`);
}

// ───────────────────────────────────────────────────────────────────────────────
// Step data saves
// ───────────────────────────────────────────────────────────────────────────────

export function saveAcademics(records = []) {
  return jsonPost('/education/academics', {
    records: Array.isArray(records) ? records : [],
  });
}

export function saveActivities(activities = []) {
  return jsonPost('/education/activities', {
    activities: Array.isArray(activities) ? activities : [],
  });
}

export function saveCognitive(payload = {}) {
  return jsonPost('/education/cognitive', payload);
}

// ───────────────────────────────────────────────────────────────────────────────
// Analysis
// ───────────────────────────────────────────────────────────────────────────────

export function getAnalysisResult(studentId) {
  return apiFetch(
    `/education/analyze/${safeId(studentId)}`
  );
}

export function triggerAnalysis(
  studentId,
  { requireComplete = true } = {}
) {
  return apiFetch(
    `/education/analyze/${safeId(studentId)}${buildQuery({
      requireComplete,
    })}`,
    { method: 'POST' }
  );
}

// ───────────────────────────────────────────────────────────────────────────────
// Career prediction
// ───────────────────────────────────────────────────────────────────────────────

export function triggerCareerPrediction(studentId) {
  return apiFetch(
    `/education/career-prediction/${safeId(studentId)}`,
    { method: 'POST' }
  );
}

export function getCareerPredictions(studentId) {
  return apiFetch(
    `/education/career-prediction/${safeId(studentId)}`
  );
}

// ───────────────────────────────────────────────────────────────────────────────
// Named service bundle
// ───────────────────────────────────────────────────────────────────────────────

export const educationApi = Object.freeze({
  createStudent,
  saveAcademics,
  saveActivities,
  saveCognitive,
  getStudentProfile,
  getAnalysisResult,
  triggerAnalysis,
  triggerCareerPrediction,
  getCareerPredictions,
});