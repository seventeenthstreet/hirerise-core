'use strict';

/**
 * models/employer.model.js
 *
 * Firestore collections for the Employer Integration Layer.
 *
 * Collections (prefixed emp_ for namespace isolation):
 *   emp_employers      — one doc per registered employer
 *   emp_employer_users — employer staff membership
 *   emp_job_roles      — open/pipeline roles per employer
 *
 * Roles:
 *   employer_admin  — manages job roles, views talent pipeline
 *   employer_hr     — read-only talent pipeline access
 *
 * Privacy guarantee:
 *   Employers NEVER receive personally identifiable student data.
 *   Only anonymised aggregate signals and skill vectors are exposed.
 *   Consent flag (student.employer_discovery_consent) must be true
 *   before any student signal reaches employer queries.
 */

const COLLECTIONS = {
  EMPLOYERS:      'emp_employers',
  EMPLOYER_USERS: 'emp_employer_users',
  JOB_ROLES:      'emp_job_roles',
  TALENT_SIGNALS: 'emp_talent_signals',  // anonymised pipeline snapshots
};

const EMPLOYER_ROLES = {
  ADMIN: 'employer_admin',
  HR:    'employer_hr',
};

// ─── Document builders ────────────────────────────────────────────────────────

/**
 * emp_employers/{employerId}
 *
 *   id            — Firestore auto-ID
 *   company_name  — string
 *   industry      — string
 *   website       — string (URL)
 *   created_by    — user ID
 *   created_at    — serverTimestamp
 *   updated_at    — serverTimestamp
 */
function buildEmployerDoc(createdBy, fields) {
  return {
    company_name: fields.company_name,
    industry:     fields.industry || '',
    website:      fields.website  || '',
    created_by:   createdBy,
  };
}

/**
 * emp_employer_users/{autoId}
 *
 *   employer_id  — string
 *   user_id      — user ID
 *   role         — 'employer_admin' | 'employer_hr'
 *   created_at   — serverTimestamp
 */
function buildEmployerUserDoc(employerId, userId, role) {
  return {
    employer_id: employerId,
    user_id:     userId,
    role,
  };
}

/**
 * emp_job_roles/{roleId}
 *
 *   employer_id      — string
 *   role_name        — string
 *   required_skills  — string[]
 *   salary_range     — { min: number, max: number, currency: string }
 *   streams          — string[]   (preferred student streams)
 *   experience_years — { min: number, max: number }
 *   active           — boolean
 *   created_at       — serverTimestamp
 *   updated_at       — serverTimestamp
 */
function buildJobRoleDoc(employerId, fields) {
  return {
    employer_id:      employerId,
    role_name:        fields.role_name,
    required_skills:  fields.required_skills  || [],
    salary_range: {
      min:      Number(fields.salary_min)  || 0,
      max:      Number(fields.salary_max)  || 0,
      currency: fields.currency            || 'USD',
    },
    streams:          fields.streams          || [],
    experience_years: {
      min: Number(fields.exp_min) || 0,
      max: Number(fields.exp_max) || 5,
    },
    active: true,
  };
}

module.exports = {
  COLLECTIONS,
  EMPLOYER_ROLES,
  buildEmployerDoc,
  buildEmployerUserDoc,
  buildJobRoleDoc,
};









