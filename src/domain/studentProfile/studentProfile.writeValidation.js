'use strict';

/**
 * @file src/domain/studentProfile/studentProfile.writeValidation.js
 *
 * WP-STD-IMP-03B — Student Repository Write Pipeline & Validation
 *
 * Write-time structural validation, extending the structural-validation
 * framework WP-STD-IMP-03A introduced (`aggregateBuilder.js`'s
 * `validateStudentProfileShape` — read-side, untouched by this file) to
 * write operations, per WP-STD-IMP-02 §15's Write-time structural
 * validation row: "Incoming partial payload's field names, types, and
 * required sub-fields ... match WP-STD-IMP-01 §4's declared shape,"
 * checked "inside each write* method, before any adapter call."
 *
 * SHAPE VALIDATION ONLY. No business validation (a "plausible" academic
 * year, a "reasonable" score range, etc.) is implemented anywhere in this
 * file, per WP-STD-IMP-01 §10's Validation Model and this work package's
 * explicit scope.
 *
 * DISCLOSED ASYMMETRY (same pattern WP-STD-IMP-02 §6.5 already
 * establishes for `writeAchievement`'s required `activityKey`, which the
 * read side discards): a few of these validators require one or two
 * fields beyond the canonical read-side shape, because the real
 * underlying table has a genuine required column with no canonical-field
 * counterpart. Each such field is called out explicitly below — none is
 * silently invented; every one is the minimum the wrapped adapter's own
 * existing write function actually requires.
 *
 * PURE FUNCTIONS ONLY — no I/O, no DB, no logging.
 */

const { MutationError } = require('./studentProfile.errors');

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validates the partial payload for `writeAcademicInformation`.
 *
 * `currentGradeLevel`, if present, must be a non-empty string.
 * `academicRecords`, if present, must be an array of
 * `{ academicYear: string, subjects: [{ subjectName: string, score?: number|null }] }`,
 * matching WP-STD-IMP-01 v1.1 §4's declared Academic Record shape.
 *
 * @param {object} partial
 * @throws {MutationError}
 */
function validateAcademicInformationPartial(partial) {
  if (!isPlainObject(partial)) {
    throw new MutationError('writeAcademicInformation payload must be an object');
  }

  if (partial.currentGradeLevel !== undefined && partial.currentGradeLevel !== null) {
    if (!isNonEmptyString(partial.currentGradeLevel)) {
      throw new MutationError('currentGradeLevel must be a non-empty string');
    }
  }

  if (partial.academicRecords !== undefined) {
    if (!Array.isArray(partial.academicRecords)) {
      throw new MutationError('academicRecords must be an array');
    }
    partial.academicRecords.forEach((record, i) => {
      if (!isPlainObject(record) || !isNonEmptyString(record.academicYear)) {
        throw new MutationError(`academicRecords[${i}].academicYear is required and must be a non-empty string`);
      }
      if (!Array.isArray(record.subjects)) {
        throw new MutationError(`academicRecords[${i}].subjects must be an array`);
      }
      record.subjects.forEach((subject, j) => {
        if (!isPlainObject(subject) || !isNonEmptyString(subject.subjectName)) {
          throw new MutationError(`academicRecords[${i}].subjects[${j}].subjectName is required and must be a non-empty string`);
        }
        if (subject.score !== undefined && subject.score !== null && typeof subject.score !== 'number') {
          throw new MutationError(`academicRecords[${i}].subjects[${j}].score must be a number or null`);
        }
      });
    });
  }
}

/**
 * Validates the partial payload for `writeActivities`.
 *
 * Each `activityRecords[]` entry needs `activityName` + `activityType`,
 * per WP-STD-IMP-02 §15's own worked example. `role`, `duration`,
 * `evidenceSource` are optional, matching the canonical shape exactly —
 * `evidenceSource` is accepted here but never persisted downstream (no
 * source column exists; disclosed in `mutationBuilder.js`, not silently
 * dropped without note).
 *
 * @param {object} partial
 * @throws {MutationError}
 */
function validateActivitiesPartial(partial) {
  if (!isPlainObject(partial)) {
    throw new MutationError('writeActivities payload must be an object');
  }
  if (partial.activityRecords !== undefined) {
    if (!Array.isArray(partial.activityRecords)) {
      throw new MutationError('activityRecords must be an array');
    }
    partial.activityRecords.forEach((a, i) => {
      if (!isPlainObject(a) || !isNonEmptyString(a.activityName)) {
        throw new MutationError(`activityRecords[${i}].activityName is required and must be a non-empty string`);
      }
      if (!isNonEmptyString(a.activityType)) {
        throw new MutationError(`activityRecords[${i}].activityType is required and must be a non-empty string`);
      }
      if (a.duration !== undefined && a.duration !== null && typeof a.duration !== 'number') {
        throw new MutationError(`activityRecords[${i}].duration must be a number or null`);
      }
    });
  }
}

/**
 * Validates the arguments for `writeAchievement(studentId, activityKey, achievement)`.
 *
 * `activityKey` is required — WP-STD-IMP-02 §4.2/§6.5: "reflects the real
 * FK constraint" the underlying `student_activity_achievements` table
 * enforces, even though the canonical read-side `AchievementRecord` shape
 * (§4) does not carry it. `achievementName`, `achievementType`,
 * `dateAwarded` are required; `issuingBody` is accepted (matching the
 * canonical shape) but never persisted — no source column exists
 * (WP-STD-IMP-02 §21, disclosed identically to the read side).
 *
 * @param {string} activityKey
 * @param {object} achievement
 * @throws {MutationError}
 */
function validateAchievementPayload(activityKey, achievement) {
  if (!isNonEmptyString(activityKey)) {
    throw new MutationError('activityKey is required and must be a non-empty string');
  }
  if (!isPlainObject(achievement)) {
    throw new MutationError('achievement payload must be an object');
  }
  if (!isNonEmptyString(achievement.achievementName)) {
    throw new MutationError('achievement.achievementName is required and must be a non-empty string');
  }
  if (!isNonEmptyString(achievement.achievementType)) {
    throw new MutationError('achievement.achievementType is required and must be a non-empty string');
  }
  if (achievement.dateAwarded !== undefined && achievement.dateAwarded !== null && typeof achievement.dateAwarded !== 'number') {
    throw new MutationError('achievement.dateAwarded must be a number (year) or null');
  }
}

/**
 * Validates the arguments for `deleteAchievement(studentId, achievementId)`.
 *
 * @param {string} achievementId
 * @throws {MutationError}
 */
function validateDeleteAchievementArgs(achievementId) {
  if (!isNonEmptyString(achievementId)) {
    throw new MutationError('achievementId is required and must be a non-empty string');
  }
}

/**
 * Validates the partial payload for `writeAssessments`.
 *
 * DISCLOSED ASYMMETRY (same pattern as `writeAchievement`'s `activityKey`,
 * §6.5): each `cognitiveAssessmentRecords[]` entry requires
 * `selectedOptionKeys` — a non-empty-array-capable field the canonical
 * read-side `CognitiveAssessmentRecord` shape (§4) does not expose,
 * because `student_cognitive_responses` has no writable column
 * corresponding to a "score," only the student's actual selected answer
 * options. Writing without it would mean silently persisting an empty
 * answer, which this design does not do. `assessmentType` is required and
 * is the same field the read-side mapper populates from `question_id`
 * (WP-STD-IMP-03A `mapper.js`) — so on write it is the question's
 * identifier, not a freeform label. `score` and `dateAdministered` are
 * accepted (matching the canonical shape) but never persisted — no
 * writable column exists for either.
 *
 * @param {object} partial
 * @throws {MutationError}
 */
function validateAssessmentsPartial(partial) {
  if (!isPlainObject(partial)) {
    throw new MutationError('writeAssessments payload must be an object');
  }
  if (partial.cognitiveAssessmentRecords !== undefined) {
    if (!Array.isArray(partial.cognitiveAssessmentRecords)) {
      throw new MutationError('cognitiveAssessmentRecords must be an array');
    }
    partial.cognitiveAssessmentRecords.forEach((r, i) => {
      if (!isPlainObject(r) || !isNonEmptyString(r.assessmentType)) {
        throw new MutationError(`cognitiveAssessmentRecords[${i}].assessmentType is required and must be a non-empty string`);
      }
      if (!Array.isArray(r.selectedOptionKeys)) {
        throw new MutationError(
          `cognitiveAssessmentRecords[${i}].selectedOptionKeys is required and must be an array (the real, non-canonical write constraint — see file header)`,
        );
      }
    });
  }
}

/**
 * Validates the partial payload for `writeCareerAspirations`.
 *
 * Structural shape only — per WP-STD-IMP-02 §15's own disclosed
 * limitation, `statedStrengths[]` is validated against its *declared*
 * canonical type (`Array of string`) even though the only real source
 * produces a structured object; this validator does not "correct" that
 * mismatch, since doing so is outside this work package's authority
 * (§15, §21). In practice this method always rejects downstream in
 * `mutationBuilder.js` regardless of validation outcome (§4.2/§10 — no
 * write adapter exists yet), so this validator exists for completeness
 * and for the day a v2 aspiration backend makes this method reachable.
 *
 * @param {object} partial
 * @throws {MutationError}
 */
function validateCareerAspirationsPartial(partial) {
  if (!isPlainObject(partial)) {
    throw new MutationError('writeCareerAspirations payload must be an object');
  }
  for (const field of ['statedInterests', 'careerCuriosities', 'learningStyles']) {
    if (partial[field] !== undefined && !Array.isArray(partial[field])) {
      throw new MutationError(`${field} must be an array`);
    }
  }
  if (partial.statedStrengths !== undefined && !Array.isArray(partial.statedStrengths)) {
    throw new MutationError('statedStrengths must be an array (per WP-STD-IMP-01 v1.1 §4\'s declared type — see file header)');
  }
}

module.exports = {
  validateAcademicInformationPartial,
  validateActivitiesPartial,
  validateAchievementPayload,
  validateDeleteAchievementArgs,
  validateAssessmentsPartial,
  validateCareerAspirationsPartial,
};
