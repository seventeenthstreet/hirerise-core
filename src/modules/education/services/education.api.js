/**
 * src/modules/education/services/education.api.js
 *
 * All API calls for the Education Intelligence module.
 * Uses apiFetch from services/apiClient.ts — auth headers handled automatically.
 *
 * Never constructs Authorization headers manually.
 * Never includes uid in request payloads — backend reads from req.user.uid.
 *
 * UPDATED (Step 5):
 *   - Added getAnalysisResult()  → GET  /education/analyze/:studentId
 *   - Added triggerAnalysis()    → POST /education/analyze/:studentId
 */

import { apiFetch } from '@/services/apiClient';

// ─── POST /api/v1/education/student ──────────────────────────────────────────

export function createStudent(payload) {
  return apiFetch('/education/student', {
    method: 'POST',
    body:   JSON.stringify(payload),
  });
}

// ─── POST /api/v1/education/academics ────────────────────────────────────────

export function saveAcademics(records) {
  return apiFetch('/education/academics', {
    method: 'POST',
    body:   JSON.stringify({ records }),
  });
}

// ─── POST /api/v1/education/activities ───────────────────────────────────────

export function saveActivities(activities) {
  return apiFetch('/education/activities', {
    method: 'POST',
    body:   JSON.stringify({ activities }),
  });
}

// ─── POST /api/v1/education/cognitive ────────────────────────────────────────

export function saveCognitive(payload) {
  return apiFetch('/education/cognitive', {
    method: 'POST',
    body:   JSON.stringify(payload),
  });
}

// ─── GET /api/v1/education/student/:id ───────────────────────────────────────

export function getStudentProfile(userId) {
  return apiFetch(`/education/student/${userId}`);
}

// ─── GET /api/v1/education/analyze/:studentId ────────────────────────────────
/**
 * Returns the most recently cached stream analysis result.
 * Does NOT re-run the pipeline.
 *
 * @param {string} studentId
 * @returns {{
 *   recommended_stream:  string,
 *   recommended_label:   string,
 *   confidence:          number,
 *   alternative_stream:  string,
 *   alternative_label:   string,
 *   stream_scores: { engineering, medical, commerce, humanities },
 *   rationale:           string,
 *   _debug: { academic, cognitive, activity }
 * }}
 */
export function getAnalysisResult(studentId) {
  return apiFetch(`/education/analyze/${studentId}`);
}

// ─── POST /api/v1/education/analyze/:studentId ───────────────────────────────
/**
 * Triggers (or re-triggers) the full AI pipeline for a student.
 * Returns the fresh recommendation immediately.
 *
 * @param {string} studentId
 * @param {{ requireComplete?: boolean }} options
 */
export function triggerAnalysis(studentId, { requireComplete = true } = {}) {
  return apiFetch(
    `/education/analyze/${studentId}?requireComplete=${requireComplete}`,
    { method: 'POST' }
  );
}

// ─── POST /api/v1/education/career-prediction/:studentId ─────────────────────
/**
 * Runs the Career Success Probability Engine for a student.
 * Returns top 5 ranked careers with probability scores.
 *
 * @param {string} studentId
 * @returns {{ top_careers: [{career: string, probability: number}] }}
 */
export function triggerCareerPrediction(studentId) {
  return apiFetch(`/education/career-prediction/${studentId}`, { method: 'POST' });
}

// ─── GET /api/v1/education/career-prediction/:studentId ──────────────────────
/**
 * Returns previously stored career predictions (no re-run).
 *
 * @param {string} studentId
 */
export function getCareerPredictions(studentId) {
  return apiFetch(`/education/career-prediction/${studentId}`);
}

// ─── Named export bundle ──────────────────────────────────────────────────────

export const educationApi = {
  createStudent,
  saveAcademics,
  saveActivities,
  saveCognitive,
  getStudentProfile,
  getAnalysisResult,
  triggerAnalysis,
  triggerCareerPrediction,
  getCareerPredictions,
};








