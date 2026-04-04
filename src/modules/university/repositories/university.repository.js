'use strict';

const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');

const {
  TABLES,
  buildUniversityRow,
  buildUniversityUserRow,
  buildProgramRow,
  sanitizeProgramPatch,
} = require('../models/university.model');

// ─────────────────────────────────────────────────────────────
// Internal Helper
// ─────────────────────────────────────────────────────────────

function throwIfError(error, context) {
  if (!error) return;

  logger.error(
    {
      context,
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
    },
    `[UniversityRepository] ${context}`
  );

  throw error;
}

// ─────────────────────────────────────────────────────────────
// Universities
// ─────────────────────────────────────────────────────────────

async function createUniversity(createdBy, fields) {
  const row = buildUniversityRow(createdBy, fields);

  const { data, error } = await supabase
    .from(TABLES.UNIVERSITIES)
    .insert(row)
    .select()
    .single();

  throwIfError(error, 'createUniversity');
  return data;
}

async function getUniversity(universityId) {
  const { data, error } = await supabase
    .from(TABLES.UNIVERSITIES)
    .select('*')
    .eq('id', universityId)
    .maybeSingle();

  throwIfError(error, 'getUniversity');
  return data || null;
}

async function listUniversities(limit = 200) {
  const safeLimit = Math.min(Number(limit) || 200, 500);

  const { data, error } = await supabase
    .from(TABLES.UNIVERSITIES)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(safeLimit);

  throwIfError(error, 'listUniversities');
  return data || [];
}

/**
 * Critical rollback helper
 * Used by service compensating transaction logic
 */
async function deleteUniversity(universityId) {
  const { error } = await supabase
    .from(TABLES.UNIVERSITIES)
    .delete()
    .eq('id', universityId);

  throwIfError(error, 'deleteUniversity');
  return true;
}

// ─────────────────────────────────────────────────────────────
// University Users
// ─────────────────────────────────────────────────────────────

async function addUniversityUser(universityId, userId, role) {
  const row = buildUniversityUserRow(universityId, userId, role);

  const { data, error } = await supabase
    .from(TABLES.UNIVERSITY_USERS)
    .insert(row)
    .select()
    .single();

  throwIfError(error, 'addUniversityUser');
  return data;
}

async function getUniversityUser(universityId, userId) {
  const { data, error } = await supabase
    .from(TABLES.UNIVERSITY_USERS)
    .select('*')
    .eq('university_id', universityId)
    .eq('user_id', userId)
    .maybeSingle();

  throwIfError(error, 'getUniversityUser');
  return data || null;
}

async function getMyUniversities(userId) {
  const { data: memberships, error: membershipError } = await supabase
    .from(TABLES.UNIVERSITY_USERS)
    .select('university_id')
    .eq('user_id', userId);

  throwIfError(membershipError, 'getMyUniversities.memberships');

  if (!memberships?.length) return [];

  const ids = [...new Set(memberships.map((m) => m.university_id))];

  const { data: universities, error: universityError } = await supabase
    .from(TABLES.UNIVERSITIES)
    .select('*')
    .in('id', ids)
    .order('created_at', { ascending: false });

  throwIfError(universityError, 'getMyUniversities.universities');

  return universities || [];
}

// ─────────────────────────────────────────────────────────────
// Programs
// ─────────────────────────────────────────────────────────────

async function createProgram(universityId, fields) {
  const row = buildProgramRow(universityId, fields);

  const { data, error } = await supabase
    .from(TABLES.PROGRAMS)
    .insert(row)
    .select()
    .single();

  throwIfError(error, 'createProgram');
  return data;
}

async function getProgram(programId) {
  const { data, error } = await supabase
    .from(TABLES.PROGRAMS)
    .select('*')
    .eq('id', programId)
    .maybeSingle();

  throwIfError(error, 'getProgram');
  return data || null;
}

async function listPrograms(universityId) {
  const { data, error } = await supabase
    .from(TABLES.PROGRAMS)
    .select('*')
    .eq('university_id', universityId)
    .order('created_at', { ascending: false });

  throwIfError(error, 'listPrograms');
  return data || [];
}

async function listAllPrograms(limit = 500) {
  const safeLimit = Math.min(Number(limit) || 500, 1000);

  const { data, error } = await supabase
    .from(TABLES.PROGRAMS)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(safeLimit);

  throwIfError(error, 'listAllPrograms');
  return data || [];
}

async function updateProgram(programId, fields) {
  const patch = sanitizeProgramPatch(fields);

  const { data, error } = await supabase
    .from(TABLES.PROGRAMS)
    .update(patch)
    .eq('id', programId)
    .select()
    .single();

  throwIfError(error, 'updateProgram');
  return data;
}

async function deleteProgram(programId) {
  const { error } = await supabase
    .from(TABLES.PROGRAMS)
    .delete()
    .eq('id', programId);

  throwIfError(error, 'deleteProgram');
  return true;
}

module.exports = {
  createUniversity,
  getUniversity,
  listUniversities,
  deleteUniversity,
  addUniversityUser,
  getUniversityUser,
  getMyUniversities,
  createProgram,
  getProgram,
  listPrograms,
  listAllPrograms,
  updateProgram,
  deleteProgram,
};