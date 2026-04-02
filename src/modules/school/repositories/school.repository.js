'use strict';

const { supabase } = require('../../../config/supabase');

const {
  COLLECTIONS,
  buildSchoolDoc,
  buildSchoolUserDoc,
  buildSchoolStudentDoc,
} = require('../models/school.model');

// ─── Schools ───────────────────────────────────────────

async function createSchool(createdBy, fields) {
  const doc = buildSchoolDoc(createdBy, fields);

  const { data, error } = await supabase
    .from(COLLECTIONS.SCHOOLS)
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

async function getSchool(schoolId) {
  const { data, error } = await supabase
    .from(COLLECTIONS.SCHOOLS)
    .select('*')
    .eq('id', schoolId)
    .single();

  if (error) return null;
  return data;
}

async function getSchoolsForUser(userId) {
  const { data: members, error } = await supabase
    .from(COLLECTIONS.SCHOOL_USERS)
    .select('*')
    .eq('user_id', userId);

  if (error) throw error;
  if (!members.length) return [];

  const schoolIds = [...new Set(members.map(m => m.school_id))];

  const { data: schools } = await supabase
    .from(COLLECTIONS.SCHOOLS)
    .select('*')
    .in('id', schoolIds);

  return schools || [];
}

// ─── School Users ──────────────────────────────────────

async function addSchoolUser(schoolId, userId, role) {
  const { data: existing } = await supabase
    .from(COLLECTIONS.SCHOOL_USERS)
    .select('*')
    .eq('school_id', schoolId)
    .eq('user_id', userId)
    .single();

  if (existing) {
    const { data, error } = await supabase
      .from(COLLECTIONS.SCHOOL_USERS)
      .update({ role })
      .eq('id', existing.id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  const doc = buildSchoolUserDoc(schoolId, userId, role);

  const { data, error } = await supabase
    .from(COLLECTIONS.SCHOOL_USERS)
    .insert([{ ...doc, created_at: new Date() }])
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function getSchoolUsers(schoolId) {
  const { data, error } = await supabase
    .from(COLLECTIONS.SCHOOL_USERS)
    .select('*')
    .eq('school_id', schoolId);

  if (error) throw error;
  return data || [];
}

async function getMemberRole(schoolId, userId) {
  const { data } = await supabase
    .from(COLLECTIONS.SCHOOL_USERS)
    .select('role')
    .eq('school_id', schoolId)
    .eq('user_id', userId)
    .single();

  return data ? data.role : null;
}

// ─── School Students ───────────────────────────────────

async function addStudentToSchool(schoolId, studentId, fields = {}) {
  const { data: existing } = await supabase
    .from(COLLECTIONS.SCHOOL_STUDENTS)
    .select('*')
    .eq('school_id', schoolId)
    .eq('student_id', studentId)
    .single();

  if (existing) {
    const updates = {
      ...(fields.class && { class: fields.class }),
      ...(fields.section && { section: fields.section }),
    };

    if (Object.keys(updates).length) {
      const { data, error } = await supabase
        .from(COLLECTIONS.SCHOOL_STUDENTS)
        .update(updates)
        .eq('id', existing.id)
        .select()
        .single();

      if (error) throw error;
      return data;
    }

    return existing;
  }

  const doc = buildSchoolStudentDoc(schoolId, studentId, fields);

  const { data, error } = await supabase
    .from(COLLECTIONS.SCHOOL_STUDENTS)
    .insert([{ ...doc, created_at: new Date() }])
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function getSchoolStudentIds(schoolId) {
  const { data, error } = await supabase
    .from(COLLECTIONS.SCHOOL_STUDENTS)
    .select('*')
    .eq('school_id', schoolId);

  if (error) throw error;

  return (data || []).map(d => ({
    link_id: d.id,
    student_id: d.student_id,
    class: d.class || null,
    section: d.section || null,
  }));
}

async function isStudentInSchool(schoolId, studentId) {
  const { data } = await supabase
    .from(COLLECTIONS.SCHOOL_STUDENTS)
    .select('id')
    .eq('school_id', schoolId)
    .eq('student_id', studentId)
    .single();

  return !!data;
}

async function getStudentSchool(studentId) {
  const { data } = await supabase
    .from(COLLECTIONS.SCHOOL_STUDENTS)
    .select('school_id')
    .eq('student_id', studentId)
    .single();

  return data ? data.school_id : null;
}

module.exports = {
  createSchool,
  getSchool,
  getSchoolsForUser,
  addSchoolUser,
  getSchoolUsers,
  getMemberRole,
  addStudentToSchool,
  getSchoolStudentIds,
  isStudentInSchool,
  getStudentSchool,
};
