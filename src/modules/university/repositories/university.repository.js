'use strict';

const supabase = require('../../../config/supabase');

const {
  COLLECTIONS,
  buildUniversityDoc,
  buildUniversityUserDoc,
  buildProgramDoc,
} = require('../models/university.model');

// ─── Universities ─────────────────────────────────────

async function createUniversity(createdBy, fields) {
  const doc = buildUniversityDoc(createdBy, fields);

  const { data, error } = await supabase
    .from(COLLECTIONS.UNIVERSITIES)
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

async function getUniversity(universityId) {
  const { data, error } = await supabase
    .from(COLLECTIONS.UNIVERSITIES)
    .select('*')
    .eq('id', universityId)
    .single();

  if (error) return null;
  return data;
}

async function listUniversities() {
  const { data, error } = await supabase
    .from(COLLECTIONS.UNIVERSITIES)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) throw error;
  return data || [];
}

// ─── University Users ─────────────────────────────────

async function addUniversityUser(universityId, userId, role) {
  const doc = buildUniversityUserDoc(universityId, userId, role);

  const { data, error } = await supabase
    .from(COLLECTIONS.UNIVERSITY_USERS)
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

async function getUniversityUser(universityId, userId) {
  const { data } = await supabase
    .from(COLLECTIONS.UNIVERSITY_USERS)
    .select('*')
    .eq('university_id', universityId)
    .eq('user_id', userId)
    .single();

  return data || null;
}

async function getMyUniversities(userId) {
  const { data: memberships } = await supabase
    .from(COLLECTIONS.UNIVERSITY_USERS)
    .select('*')
    .eq('user_id', userId);

  if (!memberships || !memberships.length) return [];

  const ids = [...new Set(memberships.map(m => m.university_id))];

  const { data: universities } = await supabase
    .from(COLLECTIONS.UNIVERSITIES)
    .select('*')
    .in('id', ids);

  return universities || [];
}

// ─── Programs ─────────────────────────────────────────

async function createProgram(universityId, fields) {
  const doc = buildProgramDoc(universityId, fields);

  const { data, error } = await supabase
    .from(COLLECTIONS.PROGRAMS)
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

async function getProgram(programId) {
  const { data, error } = await supabase
    .from(COLLECTIONS.PROGRAMS)
    .select('*')
    .eq('id', programId)
    .single();

  if (error) return null;
  return data;
}

async function listPrograms(universityId) {
  const { data, error } = await supabase
    .from(COLLECTIONS.PROGRAMS)
    .select('*')
    .eq('university_id', universityId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

async function listAllPrograms() {
  const { data, error } = await supabase
    .from(COLLECTIONS.PROGRAMS)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) throw error;
  return data || [];
}

async function updateProgram(programId, fields) {
  const { data, error } = await supabase
    .from(COLLECTIONS.PROGRAMS)
    .update({
      ...fields,
      updated_at: new Date(),
    })
    .eq('id', programId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function deleteProgram(programId) {
  const { error } = await supabase
    .from(COLLECTIONS.PROGRAMS)
    .delete()
    .eq('id', programId);

  if (error) throw error;
}

module.exports = {
  createUniversity,
  getUniversity,
  listUniversities,
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