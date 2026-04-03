'use strict';

/**
 * src/modules/education-intelligence/services/student.service.js
 *
 * Business logic for Education Intelligence onboarding.
 *
 * Features:
 * - student onboarding progression
 * - atomic academic/activity replacement
 * - cognitive save + background analysis trigger
 * - aggregated profile retrieval
 */

const repository = require('../repositories/student.repository');
const orchestrator = require('../orchestrator/education.orchestrator');
const logger = require('../../../utils/logger');

const STEP_AFTER = Object.freeze({
  profile: 'academics',
  academics: 'activities',
  activities: 'cognitive',
  cognitive: 'complete',
});

/**
 * In-memory dedupe for background orchestration triggers.
 * Prevents repeated parallel analysis for same student in hot retry scenarios.
 */
const activeBackgroundRuns = new Set();

// ─────────────────────────────────────────────────────────────────────────────
// Student profile
// ─────────────────────────────────────────────────────────────────────────────

async function createStudent(userId, { name, email, education_level }) {
  const student = await repository.upsertStudent(userId, {
    name,
    email,
    education_level,
  });

  await repository.initStreamScores(userId);

  logger.info({ userId }, '[EduIntel] Student profile upserted');

  return { student };
}

// ─────────────────────────────────────────────────────────────────────────────
// Academic records
// ─────────────────────────────────────────────────────────────────────────────

async function saveAcademics(userId, records = []) {
  await requireStudent(userId, 'Cannot save academics — student profile not found.');

  const saved = await repository.replaceAcademicRecords(userId, records);

  await repository.setOnboardingStep(
    userId,
    STEP_AFTER.academics
  );

  logger.info(
    { userId, count: records.length },
    '[EduIntel] Academic records saved'
  );

  return {
    records: saved,
    onboarding_step: STEP_AFTER.academics,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Activities
// ─────────────────────────────────────────────────────────────────────────────

async function saveActivities(userId, activities = []) {
  await requireStudent(userId, 'Cannot save activities — student profile not found.');

  const saved = await repository.replaceActivities(userId, activities);

  await repository.setOnboardingStep(
    userId,
    STEP_AFTER.activities
  );

  logger.info(
    { userId, count: activities.length },
    '[EduIntel] Activities saved'
  );

  return {
    activities: saved,
    onboarding_step: STEP_AFTER.activities,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cognitive
// ─────────────────────────────────────────────────────────────────────────────

async function saveCognitive(userId, fields = {}) {
  await requireStudent(
    userId,
    'Cannot save cognitive results — student profile not found.'
  );

  const cognitive = await repository.upsertCognitive(userId, fields);

  await repository.setOnboardingStep(
    userId,
    STEP_AFTER.cognitive
  );

  logger.info(
    { userId },
    '[EduIntel] Cognitive results saved. Triggering background analysis'
  );

  triggerBackgroundAnalysis(userId);

  return {
    cognitive,
    onboarding_step: STEP_AFTER.cognitive,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregated profile
// ─────────────────────────────────────────────────────────────────────────────

async function getStudentProfile(userId) {
  const student = await repository.getStudent(userId);

  if (!student) {
    const error = new Error(
      `Student profile not found for user ${userId}.`
    );
    error.statusCode = 404;
    error.name = 'NotFoundError';
    throw error;
  }

  const [
    academics,
    activities,
    cognitive,
    stream_scores,
  ] = await Promise.all([
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

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

async function requireStudent(userId, message) {
  const student = await repository.getStudent(userId);

  if (!student) {
    const error = new Error(message || 'Student profile not found.');
    error.statusCode = 404;
    error.name = 'NotFoundError';
    throw error;
  }

  return student;
}

function triggerBackgroundAnalysis(userId) {
  if (activeBackgroundRuns.has(userId)) {
    logger.info(
      { userId },
      '[EduIntel] Background analysis already in progress'
    );
    return;
  }

  activeBackgroundRuns.add(userId);

  Promise.resolve()
    .then(() => orchestrator.run(userId))
    .catch((error) => {
      logger.error(
        { userId, err: error.message },
        '[EduIntel] Background analysis failed after cognitive save'
      );
    })
    .finally(() => {
      activeBackgroundRuns.delete(userId);
    });
}

module.exports = {
  createStudent,
  saveAcademics,
  saveActivities,
  saveCognitive,
  getStudentProfile,
};