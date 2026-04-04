'use strict';

/**
 * src/modules/school/models/school.model.js
 *
 * Supabase/Postgres schema contracts and row builders
 * for the School & Counselor Platform.
 *
 * Tables:
 *   sch_schools
 *   sch_school_users
 *   sch_school_students
 *
 * Notes:
 * - Fully removes Firestore terminology
 * - Row builders are SQL insert-safe
 * - Timestamps are DB-owned via DEFAULT now()
 * - No null timestamp placeholders
 * - Payloads are immutable and explicit
 */

/* ──────────────────────────────────────────────────────────────
 * Table names
 * ────────────────────────────────────────────────────────────── */
const TABLES = Object.freeze({
  SCHOOLS: 'sch_schools',
  SCHOOL_USERS: 'sch_school_users',
  SCHOOL_STUDENTS: 'sch_school_students',
});

/* ──────────────────────────────────────────────────────────────
 * Role enums
 * ────────────────────────────────────────────────────────────── */
const SCHOOL_ROLES = Object.freeze({
  ADMIN: 'school_admin',
  COUNSELOR: 'counselor',
});

/* ──────────────────────────────────────────────────────────────
 * Row builders
 * DB owns:
 * - created_at
 * - updated_at
 * via SQL defaults / triggers
 * ────────────────────────────────────────────────────────────── */

/**
 * Build insert payload for sch_schools
 */
function buildSchoolInsert(createdBy, fields = {}) {
  return {
    school_name: fields.school_name?.trim() || null,
    location: fields.location?.trim() || null,
    created_by: createdBy,
  };
}

/**
 * Build insert payload for sch_school_users
 */
function buildSchoolUserInsert(schoolId, userId, role) {
  return {
    school_id: schoolId,
    user_id: userId,
    role,
  };
}

/**
 * Build insert payload for sch_school_students
 */
function buildSchoolStudentInsert(schoolId, studentId, fields = {}) {
  return {
    school_id: schoolId,
    student_id: studentId,
    class: fields.class?.trim() || null,
    section: fields.section?.trim() || null,
  };
}

module.exports = {
  TABLES,
  SCHOOL_ROLES,
  buildSchoolInsert,
  buildSchoolUserInsert,
  buildSchoolStudentInsert,
};