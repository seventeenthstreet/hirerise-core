'use strict';

const { supabase } = require('../../../config/supabase');
const { TABLES } = require('../models/student.model');

/**
 * Normalize Supabase repository errors.
 *
 * @param {Error | null} error
 * @param {string} operation
 */
function throwIfError(error, operation) {
  if (!error) return;

  error.message = `[education-intelligence.student.repository] ${operation}: ${error.message}`;
  throw error;
}

/**
 * Atomic SQL RPC replacement helper.
 *
 * Uses PostgreSQL SECURITY DEFINER RPC functions that wrap DELETE + INSERT
 * in a single transaction.
 *
 * @param {string} fn
 * @param {string} studentId
 * @param {Array<object>} rows
 * @param {string} operation
 */
async function atomicReplace(fn, studentId, rows, operation) {
  const { error } = await supabase.rpc(fn, {
    p_student_id: studentId,
    p_rows: rows || [],
  });

  throwIfError(error, operation);
}

// ─────────────────────────────────────────────────────────────────────────────
// Students
// ─────────────────────────────────────────────────────────────────────────────

async function upsertStudent(userId, fields = {}) {
  const payload = {
    id: userId,
    ...fields,
  };

  const { data, error } = await supabase
    .from(TABLES.STUDENTS)
    .upsert(payload, { onConflict: 'id' })
    .select()
    .single();

  throwIfError(error, 'upsertStudent');
  return data;
}

async function getStudent(userId) {
  const { data, error } = await supabase
    .from(TABLES.STUDENTS)
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  throwIfError(error, 'getStudent');
  return data;
}

async function setOnboardingStep(userId, step) {
  const { error } = await supabase
    .from(TABLES.STUDENTS)
    .update({
      onboarding_step: step,
    })
    .eq('id', userId);

  throwIfError(error, 'setOnboardingStep');
}

// ─────────────────────────────────────────────────────────────────────────────
// Academic records
// ─────────────────────────────────────────────────────────────────────────────

async function replaceAcademicRecords(studentId, records = []) {
  const rows = records.map((record) => ({
    subject: record.subject,
    class_level: record.class_level,
    marks: record.marks,
  }));

  await atomicReplace(
    'replace_student_academic_records',
    studentId,
    rows,
    'replaceAcademicRecords'
  );

  return getAcademicRecords(studentId);
}

async function getAcademicRecords(studentId) {
  const { data, error } = await supabase
    .from(TABLES.ACADEMIC_RECORDS)
    .select('*')
    .eq('student_id', studentId)
    .order('created_at', { ascending: true });

  throwIfError(error, 'getAcademicRecords');
  return data || [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Activities
// ─────────────────────────────────────────────────────────────────────────────

async function replaceActivities(studentId, activities = []) {
  const rows = activities.map((activity) => ({
    activity_name: activity.activity_name,
    activity_level: activity.activity_level,
  }));

  await atomicReplace(
    'replace_student_activities',
    studentId,
    rows,
    'replaceActivities'
  );

  return getActivities(studentId);
}

async function getActivities(studentId) {
  const { data, error } = await supabase
    .from(TABLES.EXTRACURRICULAR)
    .select('*')
    .eq('student_id', studentId)
    .order('created_at', { ascending: true });

  throwIfError(error, 'getActivities');
  return data || [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Cognitive results
// ─────────────────────────────────────────────────────────────────────────────

async function upsertCognitive(studentId, fields = {}) {
  const payload = {
    id: studentId,
    student_id: studentId,
    ...fields,
  };

  const { data, error } = await supabase
    .from(TABLES.COGNITIVE_RESULTS)
    .upsert(payload, { onConflict: 'id' })
    .select()
    .single();

  throwIfError(error, 'upsertCognitive');
  return data;
}

async function getCognitive(studentId) {
  const { data, error } = await supabase
    .from(TABLES.COGNITIVE_RESULTS)
    .select('*')
    .eq('id', studentId)
    .maybeSingle();

  throwIfError(error, 'getCognitive');
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream scores
// ─────────────────────────────────────────────────────────────────────────────

async function initStreamScores(studentId) {
  const { error } = await supabase
    .from(TABLES.STREAM_SCORES)
    .upsert(
      {
        id: studentId,
        student_id: studentId,
      },
      { onConflict: 'id', ignoreDuplicates: true }
    );

  throwIfError(error, 'initStreamScores');
}

async function getStreamScores(studentId) {
  const { data, error } = await supabase
    .from(TABLES.STREAM_SCORES)
    .select('*')
    .eq('id', studentId)
    .maybeSingle();

  throwIfError(error, 'getStreamScores');
  return data;
}

module.exports = {
  upsertStudent,
  getStudent,
  setOnboardingStep,
  replaceAcademicRecords,
  getAcademicRecords,
  replaceActivities,
  getActivities,
  upsertCognitive,
  getCognitive,
  initStreamScores,
  getStreamScores,
};