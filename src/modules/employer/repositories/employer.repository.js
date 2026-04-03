'use strict';

/**
 * src/modules/employer/repositories/employer.repository.js
 *
 * Supabase repository for Employer Integration Layer
 * -------------------------------------------------
 * Production-grade repository:
 * - Supabase row-based access
 * - RLS-friendly query shapes
 * - single-query relational fetches
 * - DB-managed timestamps
 * - safe partial updates with empty-patch guard
 * - normalized null handling
 *
 * Schema requirements (all verified and migrated):
 * - emp_employers       : id, company_name, industry, website, created_by, created_at, updated_at
 * - emp_employer_users  : id, employer_id (FK → emp_employers.id), user_id, role, created_at
 * - emp_job_roles       : id, employer_id, role_name, salary_range (jsonb), experience_years (jsonb),
 *                         required_skills (text[]), streams (text[]), active, created_at, updated_at
 */

const { supabase } = require('../../../config/supabase');

const {
  TABLES,
  buildEmployerRow,
  buildEmployerUserRow,
  buildJobRoleRow,
} = require('../models/employer.model');

// ─────────────────────────────────────────────────────────────────────────────
// Employers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new employer record.
 * @param {string} createdBy  - User ID of the creator.
 * @param {object} fields     - Employer fields (company_name, industry, website, etc.).
 * @returns {object} Inserted employer row.
 */
async function createEmployer(createdBy, fields) {
  const row = buildEmployerRow(createdBy, fields);

  const { data, error } = await supabase
    .from(TABLES.EMPLOYERS)
    .insert(row)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Fetch a single employer by ID.
 * @param {string} employerId
 * @returns {object|null}
 */
async function getEmployer(employerId) {
  const { data, error } = await supabase
    .from(TABLES.EMPLOYERS)
    .select('*')
    .eq('id', employerId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

/**
 * List all employers, ordered by most recently created.
 * @param {number} limit - Max rows to return (default 200).
 * @returns {object[]}
 */
async function listEmployers(limit = 200) {
  const { data, error } = await supabase
    .from(TABLES.EMPLOYERS)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Employer Membership
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add a user to an employer as a member with a given role.
 * @param {string} employerId
 * @param {string} userId
 * @param {string} role
 * @returns {object} Inserted membership row.
 */
async function addEmployerUser(employerId, userId, role) {
  const row = buildEmployerUserRow(employerId, userId, role);

  const { data, error } = await supabase
    .from(TABLES.EMPLOYER_USERS)
    .insert(row)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Fetch a specific employer membership record.
 * @param {string} employerId
 * @param {string} userId
 * @returns {object|null}
 */
async function getEmployerUser(employerId, userId) {
  const { data, error } = await supabase
    .from(TABLES.EMPLOYER_USERS)
    .select('*')
    .eq('employer_id', employerId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

/**
 * List all employers a user belongs to.
 * Uses a single relational query via the FK on employer_id → emp_employers.id.
 * @param {string} userId
 * @returns {object[]} Array of employer rows.
 */
async function getMyEmployers(userId) {
  const { data, error } = await supabase
    .from(TABLES.EMPLOYER_USERS)
    .select(`
      employer_id,
      employer:${TABLES.EMPLOYERS} (
        *
      )
    `)
    .eq('user_id', userId);

  if (error) throw error;

  return (data ?? [])
    .map(row => row.employer)
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// Job Roles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new job role for an employer.
 * @param {string} employerId
 * @param {object} fields - Role fields (role_name, salary_min/max, required_skills, streams, etc.).
 * @returns {object} Inserted job role row.
 */
async function createJobRole(employerId, fields) {
  const row = buildJobRoleRow(employerId, fields);

  const { data, error } = await supabase
    .from(TABLES.JOB_ROLES)
    .insert(row)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Fetch a single job role by ID.
 * @param {string} roleId
 * @returns {object|null}
 */
async function getJobRole(roleId) {
  const { data, error } = await supabase
    .from(TABLES.JOB_ROLES)
    .select('*')
    .eq('id', roleId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

/**
 * List all active job roles for a given employer, newest first.
 * @param {string} employerId
 * @returns {object[]}
 */
async function listJobRoles(employerId) {
  const { data, error } = await supabase
    .from(TABLES.JOB_ROLES)
    .select('*')
    .eq('employer_id', employerId)
    .eq('active', true)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data ?? [];
}

/**
 * List all active job roles across all employers, newest first.
 * @param {number} limit - Max rows to return (default 500).
 * @returns {object[]}
 */
async function listAllActiveJobRoles(limit = 500) {
  const { data, error } = await supabase
    .from(TABLES.JOB_ROLES)
    .select('*')
    .eq('active', true)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

/**
 * Build a safe partial update object for a job role.
 * Only includes fields explicitly provided in the input.
 * Handles type coercion and array filtering.
 *
 * @param {object} fields - Raw update input.
 * @returns {object} Validated patch object (may be empty if no recognised fields).
 */
function buildSafeJobRolePatch(fields = {}) {
  const patch = {};

  if (fields.role_name !== undefined) {
    patch.role_name = String(fields.role_name).trim();
  }

  if (Array.isArray(fields.required_skills)) {
    patch.required_skills = fields.required_skills.filter(Boolean);
  }

  if (Array.isArray(fields.streams)) {
    patch.streams = fields.streams.filter(Boolean);
  }

  if (
    fields.salary_min !== undefined ||
    fields.salary_max !== undefined ||
    fields.currency !== undefined
  ) {
    patch.salary_range = {
      min: Number(fields.salary_min) || 0,
      max: Number(fields.salary_max) || 0,
      currency: fields.currency || 'USD',
    };
  }

  if (
    fields.exp_min !== undefined ||
    fields.exp_max !== undefined
  ) {
    patch.experience_years = {
      min: Number(fields.exp_min) || 0,
      max: Number(fields.exp_max) || 5,
    };
  }

  if (fields.active !== undefined) {
    patch.active = Boolean(fields.active);
  }

  return patch;
}

/**
 * Partially update a job role with safe field-level patching.
 * If no recognised fields are present in `fields`, returns the current
 * role state without issuing an empty UPDATE to the database.
 *
 * @param {string} roleId
 * @param {object} fields - Fields to update.
 * @returns {object} Updated (or unchanged) job role row.
 */
async function updateJobRole(roleId, fields) {
  const patch = buildSafeJobRolePatch(fields);

  // Guard: if nothing to update, return current state without a DB write.
  if (Object.keys(patch).length === 0) {
    return getJobRole(roleId);
  }

  const { data, error } = await supabase
    .from(TABLES.JOB_ROLES)
    .update(patch)
    .eq('id', roleId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Deactivate a job role (soft delete).
 * @param {string} roleId
 * @returns {void}
 */
async function deactivateJobRole(roleId) {
  const { error } = await supabase
    .from(TABLES.JOB_ROLES)
    .update({ active: false })
    .eq('id', roleId);

  if (error) throw error;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Employers
  createEmployer,
  getEmployer,
  listEmployers,
  // Membership
  addEmployerUser,
  getEmployerUser,
  getMyEmployers,
  // Job Roles
  createJobRole,
  getJobRole,
  listJobRoles,
  listAllActiveJobRoles,
  updateJobRole,
  deactivateJobRole,
};