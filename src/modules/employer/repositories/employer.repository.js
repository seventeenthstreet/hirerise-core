'use strict';

const { supabase } = require('../../../config/supabase');

const {
  COLLECTIONS,
  buildEmployerDoc,
  buildEmployerUserDoc,
  buildJobRoleDoc,
} = require('../models/employer.model');

// ─── Employers ────────────────────────────────────────

async function createEmployer(createdBy, fields) {
  const doc = buildEmployerDoc(createdBy, fields);

  const { data, error } = await supabase
    .from(COLLECTIONS.EMPLOYERS)
    .insert([
      {
        ...doc,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ])
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function getEmployer(employerId) {
  const { data, error } = await supabase
    .from(COLLECTIONS.EMPLOYERS)
    .select('*')
    .eq('id', employerId)
    .single();

  if (error) return null;
  return data;
}

async function listEmployers() {
  const { data, error } = await supabase
    .from(COLLECTIONS.EMPLOYERS)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) throw error;
  return data || [];
}

// ─── Employer Users ───────────────────────────────────

async function addEmployerUser(employerId, userId, role) {
  const doc = buildEmployerUserDoc(employerId, userId, role);

  const { data, error } = await supabase
    .from(COLLECTIONS.EMPLOYER_USERS)
    .insert([
      {
        ...doc,
        created_at: new Date(),
      },
    ])
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function getEmployerUser(employerId, userId) {
  const { data } = await supabase
    .from(COLLECTIONS.EMPLOYER_USERS)
    .select('*')
    .eq('employer_id', employerId)
    .eq('user_id', userId)
    .single();

  return data || null;
}

async function getMyEmployers(userId) {
  const { data: memberships } = await supabase
    .from(COLLECTIONS.EMPLOYER_USERS)
    .select('*')
    .eq('user_id', userId);

  if (!memberships || !memberships.length) return [];

  const ids = [...new Set(memberships.map(m => m.employer_id))];

  const { data: employers } = await supabase
    .from(COLLECTIONS.EMPLOYERS)
    .select('*')
    .in('id', ids);

  return employers || [];
}

// ─── Job Roles ────────────────────────────────────────

async function createJobRole(employerId, fields) {
  const doc = buildJobRoleDoc(employerId, fields);

  const { data, error } = await supabase
    .from(COLLECTIONS.JOB_ROLES)
    .insert([
      {
        ...doc,
        created_at: new Date(),
        updated_at: new Date(),
        active: true,
      },
    ])
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function getJobRole(roleId) {
  const { data, error } = await supabase
    .from(COLLECTIONS.JOB_ROLES)
    .select('*')
    .eq('id', roleId)
    .single();

  if (error) return null;
  return data;
}

async function listJobRoles(employerId) {
  const { data, error } = await supabase
    .from(COLLECTIONS.JOB_ROLES)
    .select('*')
    .eq('employer_id', employerId)
    .eq('active', true)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

async function listAllActiveJobRoles() {
  const { data, error } = await supabase
    .from(COLLECTIONS.JOB_ROLES)
    .select('*')
    .eq('active', true)
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) throw error;
  return data || [];
}

async function updateJobRole(roleId, fields) {
  const { data, error } = await supabase
    .from(COLLECTIONS.JOB_ROLES)
    .update({
      ...fields,
      updated_at: new Date(),
    })
    .eq('id', roleId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function deactivateJobRole(roleId) {
  const { error } = await supabase
    .from(COLLECTIONS.JOB_ROLES)
    .update({
      active: false,
      updated_at: new Date(),
    })
    .eq('id', roleId);

  if (error) throw error;
}

module.exports = {
  createEmployer,
  getEmployer,
  listEmployers,
  addEmployerUser,
  getEmployerUser,
  getMyEmployers,
  createJobRole,
  getJobRole,
  listJobRoles,
  listAllActiveJobRoles,
  updateJobRole,
  deactivateJobRole,
};
