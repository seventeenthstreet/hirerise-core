'use strict';

/**
 * @file src/domain/studentProfile/studentProfile.mapper.js
 *
 * WP-STD-IMP-03A — Student Repository Foundation & Aggregate Reconstruction
 *
 * Canonical Mapper: five small, pure, independently-testable functions —
 * one per subdomain — each mapping a wrapped adapter's raw return shape
 * into the canonical shape WP-STD-IMP-01 v1.1 §3–§4 defines, per the
 * Canonical Schema Mapping Strategy in WP-STD-IMP-02 §11.
 *
 * PURE FUNCTIONS ONLY — no I/O, no DB, no logging. aggregateBuilder.js is
 * the only caller, and is responsible for fetching the raw adapter output
 * this module transforms.
 *
 * Mapping rule applied throughout (WP-STD-IMP-02 §11's "Design rule"):
 * where a source's shape already matches the canonical shape, the mapping
 * is a rename or direct passthrough — no transformation is invented beyond
 * what the frozen evidence (WP-STD-IMP-01 v1.1, WP-STD-IMP-01A, WP-STD-IMP-02)
 * already established as necessary. Where the raw source has no field
 * corresponding to a canonical sub-field, this mapper returns `null` for
 * that sub-field rather than inventing a value — every such gap is
 * disclosed in this file's comments and, in aggregate, in the Canonical
 * Mapping Summary deliverable.
 */

/**
 * Maps academic.repository.js's fetchAcademicData() output plus the legacy
 * adapter's row into the canonical Academic Information subdomain.
 *
 * Field-level precedence (WP-STD-IMP-02 §6.3, §12.1): academicRecords[] and
 * legacyAcademicMarks come from two different, permanently un-reconciled
 * sources — no value from one is ever merged into the other.
 *
 * DISCLOSED MAPPING DECISION: the canonical `AcademicRecordSubject.score`
 * field has no single corresponding column in `student_academic_subjects`
 * — the table carries both `marks_obtained` and `percentage`. This mapper
 * prefers `marks_obtained`, falling back to `percentage`, so that `score`
 * is populated whenever either raw value exists. This is an approximate
 * mapping in the same disclosed spirit as WP-STD-IMP-02 §11's
 * `achievement_level`≈`achievementType` mapping — not a WP-STD-IMP-01
 * v1.1-specified rule, since that document does not go to sub-field
 * granularity for `academicRecords[].subjects[]`.
 *
 * @param {{ records: object[], subjects: object[] }} academicRaw - academic.repository.js#fetchAcademicData() output
 * @param {{ grade?: string|null, academic_marks?: * }|null} legacyRow - legacy student_career_profiles row (or null)
 * @returns {import('./studentProfile.types').AcademicInformation}
 */
function mapAcademicInformation(academicRaw, legacyRow) {
  const records = academicRaw?.records ?? [];
  const subjects = academicRaw?.subjects ?? [];

  const subjectsByYear = new Map();
  for (const s of subjects) {
    const list = subjectsByYear.get(s.academic_year) ?? [];
    list.push({
      subjectName: s.subject ?? null,
      score: s.marks_obtained ?? s.percentage ?? null,
    });
    subjectsByYear.set(s.academic_year, list);
  }

  const academicRecords = records.map((r) => ({
    academicYear: r.academic_year ?? null,
    subjects: subjectsByYear.get(r.academic_year) ?? [],
  }));

  return {
    currentGradeLevel: legacyRow?.grade ?? null,
    academicRecords,
    legacyAcademicMarks: legacyRow?.academic_marks ?? null,
  };
}

/**
 * Maps activity.repository.js's fetchStudentActivityData() `.activities`
 * array into the canonical Activities subdomain.
 *
 * DISCLOSED MAPPING DECISIONS (student_activities has no free-text
 * "name"/"role"/"duration"/"evidence" column set matching the canonical
 * field names one-for-one; WP-STD-IMP-01A did not trace sub-field-level
 * detail for this subdomain, and WP-STD-IMP-02 §11 asserts only
 * whole-field "direct passthrough" compatibility, not verified here):
 *   - `activityName`   ← `activity_key` (the taxonomy display_name requires
 *                        a second join, via fetchActivityTaxonomy(), that
 *                        this adapter's fetchStudentActivityData() does not
 *                        perform; activity_key is the best available
 *                        identifier without introducing a second read)
 *   - `activityType`   ← `activity_category`
 *   - `role`           ← `leadership_level`
 *   - `duration`       ← `duration_months`
 *   - `evidenceSource` ← always `null` — no corresponding column exists;
 *                        not invented, per this work package's governance
 *                        rule against papering over gaps with a default
 *
 * @param {object[]} activitiesRaw - activity.repository.js#fetchStudentActivityData().activities
 * @returns {import('./studentProfile.types').Activities}
 */
function mapActivities(activitiesRaw) {
  const rows = activitiesRaw ?? [];

  const activityRecords = rows.map((a) => ({
    activityName: a.activity_key ?? null,
    activityType: a.activity_category ?? null,
    role: a.leadership_level ?? null,
    duration: a.duration_months ?? null,
    evidenceSource: null,
  }));

  return { activityRecords };
}

/**
 * Maps activity.repository.js's fetchStudentActivityData() `.achievements`
 * array (the child rows of the FK-coupled `student_activity_achievements`
 * table) into the canonical Achievements subdomain, flattening the
 * activity↔achievement linkage away per WP-STD-IMP-02 §6.5/§12.2: the
 * canonical shape carries no `activityKey`/`activityId` back-reference,
 * matching WP-STD-IMP-01 v1.1 §4 row 10's declared shape exactly.
 *
 * Mapping per WP-STD-IMP-02 §11 (given explicitly, not invented here):
 *   - `achievementName` ← `achievement_title`
 *   - `dateAwarded`     ← `achievement_year`
 *   - `achievementType` ← `achievement_level` (approximate — disclosed by
 *                          WP-STD-IMP-02 §11/§21, not a discrepancy this
 *                          mapper introduces)
 *   - `issuingBody`     ← always `null` — no source column exists
 *                          (WP-STD-IMP-01 v1.1 §11; WP-STD-IMP-02 §21).
 *                          Do not declare SPCE readiness against this
 *                          sub-field until a source is found.
 *
 * @param {object[]} achievementsRaw - activity.repository.js#fetchStudentActivityData().achievements
 * @returns {import('./studentProfile.types').Achievements}
 */
function mapAchievements(achievementsRaw) {
  const rows = achievementsRaw ?? [];

  const achievementRecords = rows.map((a) => ({
    achievementName: a.achievement_title ?? null,
    achievementType: a.achievement_level ?? null,
    dateAwarded: a.achievement_year ?? null,
    issuingBody: null,
  }));

  return { achievementRecords };
}

/**
 * Maps cognitive.repository.js's fetchStudentCognitiveData() `.responses`
 * array into the canonical Assessments subdomain.
 *
 * DISCLOSED MAPPING GAP: `student_cognitive_responses` rows are
 * selection-based (`selected_option_keys`), not scored — there is no
 * column corresponding to the canonical `score` sub-field for an
 * individual response. WP-STD-IMP-02 §11 asserts whole-field "direct
 * passthrough" for `cognitiveAssessmentRecords[]` but does not specify
 * sub-field mapping, and no other frozen document resolves this gap. This
 * mapper does not invent a score: `score` is always `null` for
 * response-sourced entries. `assessmentType` is approximated from
 * `question_id` (the best available identifier without an additional join
 * to `cognitive_questions`/`cognitive_taxonomy`, which this adapter's
 * fetchStudentCognitiveResponses() does not perform). `dateAdministered`
 * maps from the response row's `created_at`.
 *
 * This gap is carried forward as a named, disclosed risk (see the
 * Implementation Audit deliverable) — resolving it correctly would require
 * either a schema-design decision (does `cognitiveAssessmentRecords[]`
 * mean "raw responses" or "derived signal scores"?) or a join this design
 * does not introduce, consistent with this work package's instruction not
 * to invent new reconciliation rules.
 *
 * @param {object[]} responsesRaw - cognitive.repository.js#fetchStudentCognitiveData().responses
 * @returns {import('./studentProfile.types').Assessments}
 */
function mapAssessments(responsesRaw) {
  const rows = responsesRaw ?? [];

  const cognitiveAssessmentRecords = rows.map((r) => ({
    assessmentType: r.question_id ?? null,
    score: null,
    dateAdministered: r.created_at ?? null,
  }));

  return { cognitiveAssessmentRecords };
}

/**
 * Maps the legacy adapter's `student_career_profiles` row into the
 * canonical Career Aspirations subdomain. Direct field rename per
 * WP-STD-IMP-02 §11 — every sub-field here has a one-to-one legacy column.
 *
 * DISCLOSED, NOT RESOLVED (WP-STD-IMP-01 v1.1 §3.5/§11, WP-STD-IMP-02
 * §11/§15/§21): `statedStrengths[]` is declared `Array of string`, but its
 * only real source (`student_career_profiles.strengths`) is a structured
 * object of five 1–5 integer scores. Per governance, this mapper does
 * **not** invent a transformation to force it into an array — the raw
 * value is passed through as-is. Any consumer or validator built against
 * the literal declared type must account for this until a future,
 * properly-scoped schema-design decision resolves the mismatch.
 *
 * @param {{ interests?: string[], strengths?: *, career_curiosities?: string[], learning_styles?: string[] }|null} legacyRow
 * @returns {import('./studentProfile.types').CareerAspirations}
 */
function mapCareerAspirations(legacyRow) {
  return {
    statedInterests: Array.isArray(legacyRow?.interests) ? legacyRow.interests : [],
    // No transformation applied — disclosed type mismatch, see comment above.
    statedStrengths: legacyRow?.strengths ?? [],
    careerCuriosities: Array.isArray(legacyRow?.career_curiosities) ? legacyRow.career_curiosities : [],
    learningStyles: Array.isArray(legacyRow?.learning_styles) ? legacyRow.learning_styles : [],
  };
}

module.exports = {
  mapAcademicInformation,
  mapActivities,
  mapAchievements,
  mapAssessments,
  mapCareerAspirations,
};
