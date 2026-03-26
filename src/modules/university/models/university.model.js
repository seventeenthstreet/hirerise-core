'use strict';

/**
 * models/university.model.js
 *
 * Firestore collections for the University Integration Layer.
 *
 * Collections (prefixed uni_ for namespace isolation):
 *   uni_universities      — one doc per registered university
 *   uni_university_users  — university staff membership
 *   uni_programs          — academic programs offered by each university
 *
 * Roles:
 *   university_admin  — manages programs, views student matches
 *   university_staff  — read-only access to matches and analytics
 *
 * Data isolation guarantee:
 *   All queries MUST include university_id. Cross-university access is
 *   architecturally impossible through the repository layer.
 */

const COLLECTIONS = {
  UNIVERSITIES:      'uni_universities',
  UNIVERSITY_USERS:  'uni_university_users',
  PROGRAMS:          'uni_programs',
  STUDENT_MATCHES:   'uni_student_matches',   // aggregated match signals (no PII)
};

const UNIVERSITY_ROLES = {
  ADMIN: 'university_admin',
  STAFF: 'university_staff',
};

// ─── Document builders ────────────────────────────────────────────────────────

/**
 * uni_universities/{universityId}
 *
 *   id               — Firestore auto-ID
 *   university_name  — string
 *   country          — string
 *   website          — string (URL)
 *   created_by       — user ID
 *   created_at       — serverTimestamp
 *   updated_at       — serverTimestamp
 */
function buildUniversityDoc(createdBy, fields) {
  return {
    university_name: fields.university_name,
    country:         fields.country   || '',
    website:         fields.website   || '',
    created_by:      createdBy,
  };
}

/**
 * uni_university_users/{autoId}
 *
 *   university_id  — string
 *   user_id        — user ID
 *   role           — 'university_admin' | 'university_staff'
 *   created_at     — serverTimestamp
 */
function buildUniversityUserDoc(universityId, userId, role) {
  return {
    university_id: universityId,
    user_id:       userId,
    role,
  };
}

/**
 * uni_programs/{programId}
 *
 *   university_id   — string
 *   program_name    — string
 *   degree_type     — string  (e.g. "BTech", "BCA", "MBA")
 *   duration_years  — number
 *   tuition_cost    — number  (annual, in USD or local currency)
 *   streams         — string[] (e.g. ["Science", "Mathematics"])
 *   career_outcomes — string[] (expected roles)
 *   created_at      — serverTimestamp
 *   updated_at      — serverTimestamp
 */
function buildProgramDoc(universityId, fields) {
  return {
    university_id:   universityId,
    program_name:    fields.program_name,
    degree_type:     fields.degree_type     || '',
    duration_years:  Number(fields.duration_years)  || 4,
    tuition_cost:    Number(fields.tuition_cost)     || 0,
    streams:         fields.streams         || [],
    career_outcomes: fields.career_outcomes || [],
  };
}

module.exports = {
  COLLECTIONS,
  UNIVERSITY_ROLES,
  buildUniversityDoc,
  buildUniversityUserDoc,
  buildProgramDoc,
};









