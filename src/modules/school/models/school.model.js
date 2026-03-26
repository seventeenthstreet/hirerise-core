'use strict';

/**
 * models/school.model.js
 *
 * Firestore collection names and document builders for the
 * School & Counselor Platform (multi-tenant layer).
 *
 * Collections (all prefixed sch_ to stay isolated from other modules):
 *   sch_schools        — one doc per school, keyed by auto-ID
 *   sch_school_users   — school staff (admin / counselor) membership docs
 *   sch_school_students— links student user IDs to a school
 *
 * Role definitions:
 *   school_admin   — manages school, adds counselors, imports students
 *   counselor      — views results, runs assessments, generates reports
 *   student        — personal career dashboard only (no school UI)
 *
 * Data isolation guarantee:
 *   Every service and repository MUST filter by school_id.
 *   No query should ever return data across school boundaries.
 */

// ─── Collection names ──────────────────────────────────────────────────────────

const COLLECTIONS = {
  SCHOOLS:         'sch_schools',
  SCHOOL_USERS:    'sch_school_users',
  SCHOOL_STUDENTS: 'sch_school_students',
};

// ─── Enums ────────────────────────────────────────────────────────────────────

const SCHOOL_ROLES = {
  ADMIN:     'school_admin',
  COUNSELOR: 'counselor',
};

// ─── Document builders ────────────────────────────────────────────────────────

/**
 * sch_schools/{schoolId}
 *
 *   id           — Firestore auto-ID (also stored as field)
 *   school_name  — string
 *   location     — string (city / district)
 *   created_by   — user ID of the user who created the school
 *   created_at   — serverTimestamp
 *   updated_at   — serverTimestamp
 */
function buildSchoolDoc(createdBy, fields) {
  return {
    school_name: fields.school_name || null,
    location:    fields.location    || null,
    created_by:  createdBy,
    created_at:  null, // set by repository
    updated_at:  null,
  };
}

/**
 * sch_school_users/{autoId}
 *
 *   school_id  — sch_schools doc ID
 *   user_id    — user ID of the counselor / admin
 *   role       — SCHOOL_ROLES value
 *   created_at — serverTimestamp
 */
function buildSchoolUserDoc(schoolId, userId, role) {
  return {
    school_id:  schoolId,
    user_id:    userId,
    role,
    created_at: null,
  };
}

/**
 * sch_school_students/{autoId}
 *
 *   school_id  — sch_schools doc ID
 *   student_id — user ID from edu_students
 *   class      — string  e.g. "11", "12"
 *   section    — string  e.g. "A", "B"
 *   created_at — serverTimestamp
 */
function buildSchoolStudentDoc(schoolId, studentId, fields = {}) {
  return {
    school_id:  schoolId,
    student_id: studentId,
    class:      fields.class   || null,
    section:    fields.section || null,
    created_at: null,
  };
}

module.exports = {
  COLLECTIONS,
  SCHOOL_ROLES,
  buildSchoolDoc,
  buildSchoolUserDoc,
  buildSchoolStudentDoc,
};









