'use strict';

/**
 * services/student.service.js
 *
 * Business logic for the Education Intelligence module.
 *
 * UPDATED (Step 4):
 *   - saveCognitive() now auto-triggers education.orchestrator.run() after saving.
 *     Pipeline runs in the background (fire-and-forget) — the HTTP response
 *     returns immediately with the saved cognitive data; the stream recommendation
 *     appears in edu_stream_scores once the pipeline completes (~200–500ms).
 */

const repository   = require('../repositories/student.repository');
const orchestrator = require('../orchestrator/education.orchestrator');
const logger       = require('../../../utils/logger');

const STEP_AFTER = {
  profile:   'academics',
  academics: 'activities',
  activities:'cognitive',
  cognitive: 'complete',
};

// ─── createStudent ────────────────────────────────────────────────────────────

async function createStudent(userId, { name, email, education_level }) {
  const student = await repository.upsertStudent(userId, { name, email, education_level });
  await repository.initStreamScores(userId);
  logger.info({ userId }, '[EduIntel] Student profile upserted');
  return { student };
}

// ─── saveAcademics ────────────────────────────────────────────────────────────

async function saveAcademics(userId, records) {
  await _requireStudent(userId, 'Cannot save academics — student profile not found.');
  const saved = await repository.replaceAcademicRecords(userId, records);
  await repository.setOnboardingStep(userId, STEP_AFTER.academics);
  logger.info({ userId, count: records.length }, '[EduIntel] Academic records saved');
  return { records: saved, onboarding_step: STEP_AFTER.academics };
}

// ─── saveActivities ───────────────────────────────────────────────────────────

async function saveActivities(userId, activities) {
  await _requireStudent(userId, 'Cannot save activities — student profile not found.');
  const saved = await repository.replaceActivities(userId, activities);
  await repository.setOnboardingStep(userId, STEP_AFTER.activities);
  logger.info({ userId, count: activities.length }, '[EduIntel] Activities saved');
  return { activities: saved, onboarding_step: STEP_AFTER.activities };
}

// ─── saveCognitive ────────────────────────────────────────────────────────────

/**
 * Saves cognitive test scores and marks onboarding complete.
 * Then fires the AI pipeline in the background (non-blocking).
 *
 * The HTTP response is returned immediately — the frontend does NOT need to
 * wait for stream analysis. It can poll GET /education/analyze/:studentId
 * to check when results are ready.
 */
async function saveCognitive(userId, fields) {
  await _requireStudent(userId, 'Cannot save cognitive results — student profile not found.');

  const cognitive = await repository.upsertCognitive(userId, fields);
  await repository.setOnboardingStep(userId, STEP_AFTER.cognitive);

  logger.info({ userId }, '[EduIntel] Cognitive results saved. Onboarding complete. Triggering analysis...');

  // ── Fire-and-forget pipeline trigger ─────────────────────────────────────
  // Does not block the HTTP response. Errors are logged but not surfaced.
  orchestrator.run(userId).catch(err => {
    logger.error({ userId, err: err.message },
      '[EduIntel] Background analysis failed after cognitive save');
  });

  return { cognitive, onboarding_step: STEP_AFTER.cognitive };
}

// ─── getStudentProfile ────────────────────────────────────────────────────────

async function getStudentProfile(userId) {
  const student = await repository.getStudent(userId);
  if (!student) {
    const err = new Error(`Student profile not found for user ${userId}.`);
    err.statusCode = 404;
    err.name = 'NotFoundError';
    throw err;
  }

  const [academics, activities, cognitive, stream_scores] = await Promise.all([
    repository.getAcademicRecords(userId),
    repository.getActivities(userId),
    repository.getCognitive(userId),
    repository.getStreamScores(userId),
  ]);

  return {
    student,
    academics,
    activities,
    cognitive,
    stream_scores,
    onboarding_complete: student.onboarding_step === 'complete',
  };
}

// ─── Private ─────────────────────────────────────────────────────────────────

async function _requireStudent(userId, message) {
  const student = await repository.getStudent(userId);
  if (!student) {
    const err = new Error(message || 'Student profile not found.');
    err.statusCode = 404;
    err.name = 'NotFoundError';
    throw err;
  }
  return student;
}

module.exports = {
  createStudent,
  saveAcademics,
  saveActivities,
  saveCognitive,
  getStudentProfile,
};








