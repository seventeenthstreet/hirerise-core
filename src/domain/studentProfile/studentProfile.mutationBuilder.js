'use strict';

/**
 * @file src/domain/studentProfile/studentProfile.mutationBuilder.js
 *
 * WP-STD-IMP-03B — Student Repository Write Pipeline & Validation
 *
 * Mutation orchestration for every write method in the Repository Public
 * Interface (WP-STD-IMP-02 §4.2). This module IS the "Student Repository
 * is the orchestration layer, not the persistence layer" instruction made
 * concrete: every function below either (a) delegates the actual write to
 * an existing, unmodified subdomain adapter
 * (`academic.repository.js` / `activity.repository.js` /
 * `cognitive.repository.js`), or (b) rejects with a typed
 * `PersistenceError` when no write adapter exists for the requested field
 * at all (`currentGradeLevel`, every `writeCareerAspirations` field —
 * WP-STD-IMP-02 §10: "no write adapter, since none exists to wrap"). No
 * function in this file opens a Supabase connection to write anything
 * itself.
 *
 * studentProfile.repository.js is the only intended caller of this module.
 * The read pipeline (`studentProfile.aggregateBuilder.js`) is not
 * imported, called, or modified by anything here.
 */

const { supabase } = require('../../config/supabase');
const logger = require('../../utils/logger');

const academicRepository = require('../../modules/student-onboarding/repositories/academic.repository');
const activityRepository = require('../../modules/student-onboarding/repositories/activity.repository');
const cognitiveRepository = require('../../modules/student-onboarding/repositories/cognitive.repository');

const {
  validateAcademicInformationPartial,
  validateActivitiesPartial,
  validateAchievementPayload,
  validateDeleteAchievementArgs,
  validateAssessmentsPartial,
  validateCareerAspirationsPartial,
} = require('./studentProfile.writeValidation');
const { MutationError, PersistenceError } = require('./studentProfile.errors');

// ─────────────────────────────────────────────────────────────────────────────
// ACADEMIC INFORMATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delegates to `academic.repository.js`'s existing upsert functions.
 *
 * `currentGradeLevel` has **no write adapter** under this design
 * (WP-STD-IMP-02 §10 — only a read-only legacy adapter exists for
 * Academic Information's legacy half) and is therefore rejected up front,
 * before any adapter call — including when `academicRecords` is also
 * present in the same call, so a request never produces a silent partial
 * write (WP-STD-IMP-02 §18's "no partial write" principle, applied here
 * to persistence-target availability).
 *
 * For `academicRecords[]`: each entry's `academicYear`/`subjects[]` map
 * onto `upsertAcademicRecord`'s header row and `upsertAcademicSubjects`'
 * batch call. Fields the canonical shape does not carry
 * (`board_type`, `is_partial`, `is_predicted`, subject `max_marks`/
 * `grade`/`percentage`/`source_type`) are simply omitted from the payload
 * passed to those functions — both already default every one of those
 * fields internally (`?? null` / `?? 'manual'` / `?? false`, or the
 * underlying table's own `DEFAULT` when a key is entirely absent), so
 * omission is the correct behavior, not an invented value.
 *
 * @param {string} studentId
 * @param {{ currentGradeLevel?: string|null, academicRecords?: object[] }} partial
 * @returns {Promise<{ written: boolean, fields: string[] }>}
 */
async function writeAcademicInformation(studentId, partial) {
  validateAcademicInformationPartial(partial);

  if (partial.currentGradeLevel !== undefined) {
    throw new PersistenceError(
      'no write adapter exists for currentGradeLevel — the legacy adapter is read-only under this design (WP-STD-IMP-02 §10)',
      { studentId, field: 'currentGradeLevel' },
    );
  }

  if (!partial.academicRecords || partial.academicRecords.length === 0) {
    return { written: false, fields: [] };
  }

  for (const record of partial.academicRecords) {
    let upsertedRecord;
    try {
      upsertedRecord = await academicRepository.upsertAcademicRecord(supabase, {
        user_id: studentId,
        academic_year: record.academicYear,
      });
    } catch (cause) {
      throw new PersistenceError(`failed to upsert academic record for "${record.academicYear}": ${cause?.message ?? cause}`, {
        studentId,
        academicYear: record.academicYear,
      });
    }

    if (record.subjects && record.subjects.length > 0) {
      try {
        await academicRepository.upsertAcademicSubjects(
          supabase,
          studentId,
          record.academicYear,
          upsertedRecord.id,
          record.subjects.map((s) => ({ subject: s.subjectName, marks_obtained: s.score ?? null })),
        );
      } catch (cause) {
        throw new PersistenceError(`failed to upsert academic subjects for "${record.academicYear}": ${cause?.message ?? cause}`, {
          studentId,
          academicYear: record.academicYear,
        });
      }
    }
  }

  logger.info('[StudentProfileMutationBuilder] writeAcademicInformation: delegated to academic.repository.js', {
    studentId,
    years: partial.academicRecords.map((r) => r.academicYear),
  });

  return { written: true, fields: ['academicRecords'] };
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delegates to `activity.repository.js`'s `upsertStudentActivity`, one
 * call per entry (the underlying adapter's upsert is single-row; there is
 * no batch variant to reuse without inventing one, so this loops —
 * WP-STD-IMP-02 §8 designs partial updates, not batch semantics).
 * `evidenceSource`, if present, is accepted by validation but never
 * forwarded — no source column exists (disclosed identically to the read
 * side's `mapper.js`).
 *
 * @param {string} studentId
 * @param {{ activityRecords?: object[] }} partial
 * @returns {Promise<{ written: boolean, fields: string[] }>}
 */
async function writeActivities(studentId, partial) {
  validateActivitiesPartial(partial);

  if (!partial.activityRecords || partial.activityRecords.length === 0) {
    return { written: false, fields: [] };
  }

  for (const a of partial.activityRecords) {
    try {
      await activityRepository.upsertStudentActivity(supabase, {
        user_id: studentId,
        activity_key: a.activityName,
        activity_category: a.activityType,
        leadership_level: a.role ?? undefined,
        duration_months: a.duration ?? undefined,
      });
    } catch (cause) {
      throw new PersistenceError(`failed to upsert activity "${a.activityName}": ${cause?.message ?? cause}`, {
        studentId,
        activityName: a.activityName,
      });
    }
  }

  logger.info('[StudentProfileMutationBuilder] writeActivities: delegated to activity.repository.js', {
    studentId,
    activities: partial.activityRecords.map((a) => a.activityName),
  });

  return { written: true, fields: ['activityRecords'] };
}

// ─────────────────────────────────────────────────────────────────────────────
// ACHIEVEMENTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves `activityKey` to the owning `student_activities.id`, then
 * delegates to `activity.repository.js`'s `insertAchievement`. The lookup
 * reuses the existing `fetchStudentActivityData` read function rather
 * than a new targeted query, since no single-activity lookup is exported
 * by that module and adding one would modify a file WP-STD-IMP-03A/B both
 * require left unmodified — this is Wrap's read-time-composition cost
 * (§20), accepted here as it already is throughout the read pipeline.
 *
 * If no activity with `activityKey` exists for this student, this is the
 * real FK constraint surfacing at the boundary (WP-STD-IMP-02 §18,
 * §6.5) — rejected with `MutationError`, not a silent no-op.
 *
 * `issuingBody`, if present, is accepted by validation but never
 * forwarded — no column exists on `student_activity_achievements`
 * (WP-STD-IMP-02 §21, disclosed identically to the read side).
 *
 * @param {string} studentId
 * @param {string} activityKey
 * @param {{ achievementName: string, achievementType: string, dateAwarded?: number|null, issuingBody?: string|null }} achievement
 * @returns {Promise<{ written: boolean, achievementId: string }>}
 */
async function writeAchievement(studentId, activityKey, achievement) {
  validateAchievementPayload(activityKey, achievement);

  let activityData;
  try {
    activityData = await activityRepository.fetchStudentActivityData(supabase, studentId);
  } catch (cause) {
    throw new PersistenceError(`failed to resolve activityKey "${activityKey}": ${cause?.message ?? cause}`, { studentId, activityKey });
  }

  const matchingActivity = (activityData.activities ?? []).find((a) => a.activity_key === activityKey);
  if (!matchingActivity) {
    throw new MutationError(`activityKey "${activityKey}" does not correspond to an existing activity for this student`, {
      studentId,
      activityKey,
    });
  }

  let inserted;
  try {
    inserted = await activityRepository.insertAchievement(supabase, {
      user_id: studentId,
      student_activity_id: matchingActivity.id,
      achievement_title: achievement.achievementName,
      achievement_level: achievement.achievementType,
      achievement_year: achievement.dateAwarded ?? null,
    });
  } catch (cause) {
    throw new PersistenceError(`failed to insert achievement for activityKey "${activityKey}": ${cause?.message ?? cause}`, {
      studentId,
      activityKey,
    });
  }

  logger.info('[StudentProfileMutationBuilder] writeAchievement: delegated to activity.repository.js', {
    studentId,
    activityKey,
    achievementId: inserted.id,
  });

  return { written: true, achievementId: inserted.id };
}

/**
 * Delegates to `activity.repository.js`'s `deleteAchievement`.
 *
 * @param {string} studentId
 * @param {string} achievementId
 * @returns {Promise<{ deleted: boolean }>}
 */
async function deleteAchievement(studentId, achievementId) {
  validateDeleteAchievementArgs(achievementId);

  try {
    await activityRepository.deleteAchievement(supabase, studentId, achievementId);
  } catch (cause) {
    throw new PersistenceError(`failed to delete achievement "${achievementId}": ${cause?.message ?? cause}`, {
      studentId,
      achievementId,
    });
  }

  logger.info('[StudentProfileMutationBuilder] deleteAchievement: delegated to activity.repository.js', {
    studentId,
    achievementId,
  });

  return { deleted: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// ASSESSMENTS (COGNITIVE)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delegates to `cognitive.repository.js`'s `batchUpsertCognitiveResponses`.
 *
 * Each entry's `assessmentType` maps to `question_id` — the same field
 * the read-side mapper (WP-STD-IMP-03A `mapper.js`) populates
 * `assessmentType` from, so this is a rename, not a new mapping.
 * `selectedOptionKeys` maps to `selected_option_keys`, the disclosed
 * write-only field (see `writeValidation.js`'s file header). `score` and
 * `dateAdministered`, if present, are accepted by validation but never
 * forwarded — no writable column exists for either. `is_partial` is not
 * set by this method at all; it is omitted from the payload so the
 * underlying table's own `DEFAULT true` / existing-value-on-conflict
 * behavior applies, since no canonical or extended field carries that
 * intent today.
 *
 * @param {string} studentId
 * @param {{ cognitiveAssessmentRecords?: object[] }} partial
 * @returns {Promise<{ written: boolean, fields: string[] }>}
 */
async function writeAssessments(studentId, partial) {
  validateAssessmentsPartial(partial);

  if (!partial.cognitiveAssessmentRecords || partial.cognitiveAssessmentRecords.length === 0) {
    return { written: false, fields: [] };
  }

  try {
    await cognitiveRepository.batchUpsertCognitiveResponses(
      supabase,
      studentId,
      partial.cognitiveAssessmentRecords.map((r) => ({
        question_id: r.assessmentType,
        selected_option_keys: r.selectedOptionKeys,
        is_partial: undefined,
      })),
    );
  } catch (cause) {
    throw new PersistenceError(`failed to upsert cognitive responses: ${cause?.message ?? cause}`, { studentId });
  }

  logger.info('[StudentProfileMutationBuilder] writeAssessments: delegated to cognitive.repository.js', {
    studentId,
    count: partial.cognitiveAssessmentRecords.length,
  });

  return { written: true, fields: ['cognitiveAssessmentRecords'] };
}

// ─────────────────────────────────────────────────────────────────────────────
// CAREER ASPIRATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * No write adapter exists for any Career Aspirations field under this
 * design (WP-STD-IMP-02 §10, §12.3, §21: "writeCareerAspirations exists
 * as a ready integration point but has no current caller; this design
 * does not manufacture data where none exists"). This method validates
 * structurally (so the method behaves predictably and consistently with
 * every other write method up to that point) and then always rejects with
 * a `PersistenceError` naming this exact, documented gap — never a silent
 * no-op, never an invented write to the legacy table (which §13.1
 * requires stay untouched by this design).
 *
 * @param {string} studentId
 * @param {{ statedInterests?: string[], statedStrengths?: *, careerCuriosities?: string[], learningStyles?: string[] }} partial
 * @returns {Promise<never>}
 */
async function writeCareerAspirations(studentId, partial) {
  validateCareerAspirationsPartial(partial);

  throw new PersistenceError(
    'no write adapter exists for Career Aspirations — this method is a mechanical integration point for a future v2 aspiration backend (WP-STD-IMP-02 §4.2, §12.3, §21), not a functioning write path today',
    { studentId },
  );
}

module.exports = {
  writeAcademicInformation,
  writeActivities,
  writeAchievement,
  deleteAchievement,
  writeAssessments,
  writeCareerAspirations,
};
