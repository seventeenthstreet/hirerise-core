'use strict';

/**
 * core/src/modules/student-onboarding/repositories/academic.repository.js
 *
 * DATABASE ACCESS LAYER — Academic Signal Collection
 * ────────────────────────────────────────────────────
 * All Supabase queries for student_academic_records and
 * student_academic_subjects live here. Zero business logic.
 *
 * PATTERN:
 *   Every function accepts a supabase client (service-role) and a userId.
 *   This keeps the repository testable via dependency injection.
 *
 * UPSERT STRATEGY:
 *   • student_academic_records → upsert on (user_id, academic_year)
 *   • student_academic_subjects → upsert on (user_id, academic_year, subject)
 *   Both use onConflict to safely handle re-saves (partial → full commits).
 */

// ─────────────────────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches all academic records + subjects for a student.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<{ records: Object[], subjects: Object[] }>}
 */
async function fetchAcademicData(supabase, userId) {
  const [recordsResult, subjectsResult] = await Promise.all([
    supabase
      .from('student_academic_records')
      .select('*')
      .eq('user_id', userId)
      .order('academic_year', { ascending: true }),

    supabase
      .from('student_academic_subjects')
      .select('*')
      .eq('user_id', userId)
      .order('academic_year', { ascending: true }),
  ]);

  if (recordsResult.error) throw recordsResult.error;
  if (subjectsResult.error) throw subjectsResult.error;

  return {
    records:  recordsResult.data  ?? [],
    subjects: subjectsResult.data ?? [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// UPSERT RECORD (year header row)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upserts a single student_academic_records row.
 * Safe to call multiple times — uses ON CONFLICT DO UPDATE.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {Object} record
 * @param {string}  record.user_id
 * @param {string}  record.academic_year
 * @param {string}  record.board_type
 * @param {boolean} record.is_partial
 * @param {boolean} record.is_predicted
 * @param {number}  record.subject_count
 * @returns {Promise<Object>}  The upserted row.
 */
async function upsertAcademicRecord(supabase, record) {
  const payload = {
    user_id:       record.user_id,
    academic_year: record.academic_year,
    board_type:    record.board_type,
    is_partial:    record.is_partial,
    is_predicted:  record.is_predicted,
    subject_count: record.subject_count,
    completed_at:  record.is_partial ? null : new Date().toISOString(),
    updated_at:    new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('student_academic_records')
    .upsert(payload, {
      onConflict:        'user_id,academic_year',
      ignoreDuplicates:  false,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// UPSERT SUBJECTS (batch)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upserts all subjects for a given academic year in a single batch call.
 * Safe to call multiple times — uses ON CONFLICT DO UPDATE.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string}   userId
 * @param {string}   academicYear
 * @param {string}   recordId      FK → student_academic_records.id
 * @param {Object[]} subjects      Normalized subject entries
 * @returns {Promise<Object[]>}    Upserted rows.
 */
async function upsertAcademicSubjects(supabase, userId, academicYear, recordId, subjects) {
  if (!subjects || subjects.length === 0) return [];

  const rows = subjects.map((s) => ({
    record_id:      recordId,
    user_id:        userId,
    academic_year:  academicYear,
    subject:        s.subject,
    marks_obtained: s.marks_obtained ?? null,
    max_marks:      s.max_marks      ?? null,
    grade:          s.grade          ?? null,
    percentage:     s.percentage     ?? null,
    source_type:    s.source_type    ?? 'manual',
    is_predicted:   s.is_predicted   ?? false,
    updated_at:     new Date().toISOString(),
  }));

  const { data, error } = await supabase
    .from('student_academic_subjects')
    .upsert(rows, {
      onConflict:       'user_id,academic_year,subject',
      ignoreDuplicates: false,
    })
    .select();

  if (error) throw error;
  return data ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE stale subjects
// When a student removes a subject from a year during re-save,
// we delete subjects no longer in the payload for that year.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deletes subject rows for a year that are NOT in the keepSubjects list.
 * Used to handle subject removal during re-saves.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string}   userId
 * @param {string}   academicYear
 * @param {string[]} keepSubjects  Subject names to retain.
 * @returns {Promise<void>}
 */
async function deleteRemovedSubjects(supabase, userId, academicYear, keepSubjects) {
  // If keepSubjects is empty, delete ALL subjects for this year
  // (student cleared the year — rare but valid for partial saves)
  let query = supabase
    .from('student_academic_subjects')
    .delete()
    .eq('user_id', userId)
    .eq('academic_year', academicYear);

  if (keepSubjects.length > 0) {
    query = query.not('subject', 'in', `(${keepSubjects.join(',')})`);
  }

  const { error } = await query;
  if (error) throw error;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHAPE HELPERS
// Transform raw DB rows into API response shape.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Groups flat records + subjects arrays into a years map.
 *
 * Output shape:
 * {
 *   class_10: {
 *     academic_year: 'class_10',
 *     board_type: 'cbse',
 *     is_partial: false,
 *     is_predicted: false,
 *     subject_count: 5,
 *     completed_at: '...',
 *     subjects: [ { subject: 'mathematics', marks_obtained: 88, ... }, ... ]
 *   },
 *   ...
 * }
 *
 * @param {Object[]} records
 * @param {Object[]} subjects
 * @returns {Record<string, Object>}
 */
function groupAcademicData(records, subjects) {
  // Index subjects by academic_year for O(1) grouping
  const subjectsByYear = {};
  for (const s of subjects) {
    if (!subjectsByYear[s.academic_year]) {
      subjectsByYear[s.academic_year] = [];
    }
    subjectsByYear[s.academic_year].push({
      id:             s.id,
      subject:        s.subject,
      marks_obtained: s.marks_obtained,
      max_marks:      s.max_marks,
      grade:          s.grade,
      percentage:     s.percentage,
      source_type:    s.source_type,
      is_predicted:   s.is_predicted,
    });
  }

  const yearsMap = {};
  for (const r of records) {
    yearsMap[r.academic_year] = {
      academic_year: r.academic_year,
      board_type:    r.board_type,
      is_partial:    r.is_partial,
      is_predicted:  r.is_predicted,
      subject_count: r.subject_count,
      completed_at:  r.completed_at,
      subjects:      subjectsByYear[r.academic_year] ?? [],
    };
  }

  return yearsMap;
}

/**
 * Builds the year summaries array required by evaluateAcademicSignalQuality.
 *
 * @param {Object[]} records
 * @returns {import('../services/academic-signal-quality').AcademicYearSummary[]}
 */
function buildYearSummaries(records) {
  return records.map((r) => ({
    academic_year: r.academic_year,
    subject_count: r.subject_count ?? 0,
    is_partial:    r.is_partial    ?? true,
  }));
}

module.exports = {
  fetchAcademicData,
  upsertAcademicRecord,
  upsertAcademicSubjects,
  deleteRemovedSubjects,
  groupAcademicData,
  buildYearSummaries,
};
