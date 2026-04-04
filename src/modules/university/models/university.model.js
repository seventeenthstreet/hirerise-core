'use strict';

/**
 * src/modules/university/models/university.model.js
 *
 * Supabase/Postgres schema constants + row payload builders
 * for the University Integration Layer.
 *
 * Tables:
 *   uni_universities
 *   uni_university_users
 *   uni_programs
 *   uni_student_matches
 *
 * Notes:
 * - IDs are DB-generated UUIDs
 * - created_at / updated_at handled by SQL defaults + triggers
 * - All row payloads are normalized before repository writes
 */

// ─────────────────────────────────────────────────────────────
// Table Names
// ─────────────────────────────────────────────────────────────

const TABLES = Object.freeze({
  UNIVERSITIES: 'uni_universities',
  UNIVERSITY_USERS: 'uni_university_users',
  PROGRAMS: 'uni_programs',
  STUDENT_MATCHES: 'uni_student_matches',
});

// ─────────────────────────────────────────────────────────────
// Role Constants
// ─────────────────────────────────────────────────────────────

const UNIVERSITY_ROLES = Object.freeze({
  ADMIN: 'university_admin',
  STAFF: 'university_staff',
});

// ─────────────────────────────────────────────────────────────
// Row Payload Builders
// Supabase/Postgres row-safe normalization
// ─────────────────────────────────────────────────────────────

function buildUniversityRow(createdBy, fields = {}) {
  return {
    university_name: String(fields.university_name || '').trim(),
    country: String(fields.country || '').trim() || null,
    website: String(fields.website || '').trim() || null,
    created_by: createdBy,
  };
}

function buildUniversityUserRow(universityId, userId, role) {
  return {
    university_id: universityId,
    user_id: userId,
    role,
  };
}

function buildProgramRow(universityId, fields = {}) {
  return {
    university_id: universityId,
    program_name: String(fields.program_name || '').trim(),
    degree_type: String(fields.degree_type || '').trim() || null,
    duration_years:
      Number.isFinite(Number(fields.duration_years))
        ? Number(fields.duration_years)
        : 4,
    tuition_cost:
      Number.isFinite(Number(fields.tuition_cost))
        ? Number(fields.tuition_cost)
        : 0,
    streams: Array.isArray(fields.streams) ? fields.streams : [],
    career_outcomes: Array.isArray(fields.career_outcomes)
      ? fields.career_outcomes
      : [],
  };
}

// ─────────────────────────────────────────────────────────────
// Patch Sanitizer
// Prevents accidental null overwrite / malformed updates
// Useful for updateProgram() repository flows
// ─────────────────────────────────────────────────────────────

function sanitizeProgramPatch(fields = {}) {
  const patch = {};

  if (fields.program_name !== undefined) {
    patch.program_name = String(fields.program_name).trim();
  }

  if (fields.degree_type !== undefined) {
    patch.degree_type = String(fields.degree_type).trim() || null;
  }

  if (fields.duration_years !== undefined) {
    patch.duration_years = Number(fields.duration_years);
  }

  if (fields.tuition_cost !== undefined) {
    patch.tuition_cost = Number(fields.tuition_cost);
  }

  if (fields.streams !== undefined) {
    patch.streams = Array.isArray(fields.streams) ? fields.streams : [];
  }

  if (fields.career_outcomes !== undefined) {
    patch.career_outcomes = Array.isArray(fields.career_outcomes)
      ? fields.career_outcomes
      : [];
  }

  return patch;
}

module.exports = {
  TABLES,
  UNIVERSITY_ROLES,
  buildUniversityRow,
  buildUniversityUserRow,
  buildProgramRow,
  sanitizeProgramPatch,
};