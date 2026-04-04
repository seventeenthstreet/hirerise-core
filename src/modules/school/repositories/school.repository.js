'use strict';

const { supabase } = require('../../../config/supabase');

const {
  TABLES,
  buildSchoolInsert,
  buildSchoolUserInsert,
  buildSchoolStudentInsert,
} = require('../models/school.model');

/* ──────────────────────────────────────────────────────────────
 * Schools
 * ────────────────────────────────────────────────────────────── */
async function createSchool(createdBy, fields) {
  const payload = buildSchoolInsert(createdBy, fields);

  const { data, error } = await supabase
    .from(TABLES.SCHOOLS)
    .insert(payload)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function getSchool(schoolId) {
  const { data, error } = await supabase
    .from(TABLES.SCHOOLS)
    .select('*')
    .eq('id', schoolId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function getSchoolsForUser(userId) {
  const { data: memberships, error } = await supabase
    .from(TABLES.SCHOOL_USERS)
    .select('school_id')
    .eq('user_id', userId);

  if (error) throw error;
  if (!memberships?.length) return [];

  const schoolIds = [...new Set(memberships.map(row => row.school_id))];

  const { data: schools, error: schoolsError } = await supabase
    .from(TABLES.SCHOOLS)
    .select('*')
    .in('id', schoolIds);

  if (schoolsError) throw schoolsError;
  return schools || [];
}

/* ──────────────────────────────────────────────────────────────
 * School Users
 * ────────────────────────────────────────────────────────────── */
async function addSchoolUser(schoolId, userId, role) {
  const payload = buildSchoolUserInsert(schoolId, userId, role);

  const { data, error } = await supabase
    .from(TABLES.SCHOOL_USERS)
    .upsert(payload, {
      onConflict: 'school_id,user_id',
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function getSchoolUsers(schoolId) {
  const { data, error } = await supabase
    .from(TABLES.SCHOOL_USERS)
    .select('*')
    .eq('school_id', schoolId);

  if (error) throw error;
  return data || [];
}

async function getMemberRole(schoolId, userId) {
  const { data, error } = await supabase
    .from(TABLES.SCHOOL_USERS)
    .select('role')
    .eq('school_id', schoolId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data?.role || null;
}

/* ──────────────────────────────────────────────────────────────
 * School Students
 * ────────────────────────────────────────────────────────────── */
async function addStudentToSchool(schoolId, studentId, fields = {}) {
  const payload = buildSchoolStudentInsert(schoolId, studentId, fields);

  const { data, error } = await supabase
    .from(TABLES.SCHOOL_STUDENTS)
    .upsert(payload, {
      onConflict: 'school_id,student_id',
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function getSchoolStudentIds(schoolId) {
  const { data, error } = await supabase
    .from(TABLES.SCHOOL_STUDENTS)
    .select('id, student_id, class, section')
    .eq('school_id', schoolId);

  if (error) throw error;

  return (data || []).map(row => ({
    link_id: row.id,
    student_id: row.student_id,
    class: row.class,
    section: row.section,
  }));
}

async function isStudentInSchool(schoolId, studentId) {
  const { data, error } = await supabase
    .from(TABLES.SCHOOL_STUDENTS)
    .select('id')
    .eq('school_id', schoolId)
    .eq('student_id', studentId)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data);
}

async function getStudentSchool(studentId) {
  const { data, error } = await supabase
    .from(TABLES.SCHOOL_STUDENTS)
    .select('school_id')
    .eq('student_id', studentId)
    .maybeSingle();

  if (error) throw error;
  return data?.school_id || null;
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