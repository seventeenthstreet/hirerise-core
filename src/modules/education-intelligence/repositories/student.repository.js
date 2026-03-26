'use strict';

const { supabase } = require('../../../config/supabase');

// ─── Students ─────────────────────────────────────────

async function upsertStudent(userId, fields) {
  const now = new Date().toISOString();

  const { data: existing } = await supabase
    .from('edu_students')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (!existing) {
    const { data, error } = await supabase
      .from('edu_students')
      .insert([{ id: userId, ...fields, created_at: now, updated_at: now }])
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from('edu_students')
    .update({ ...fields, updated_at: now })
    .eq('id', userId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function getStudent(userId) {
  const { data, error } = await supabase
    .from('edu_students')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function setOnboardingStep(userId, step) {
  const { error } = await supabase
    .from('edu_students')
    .update({
      onboarding_step: step,
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId);

  if (error) throw error;
}

// ─── Academic Records ─────────────────────────────────

async function replaceAcademicRecords(studentId, records) {
  await supabase.from('edu_academic').delete().eq('student_id', studentId);

  const rows = records.map(r => ({
    student_id: studentId,
    ...r,
    created_at: new Date().toISOString(),
  }));

  const { error } = await supabase.from('edu_academic').insert(rows);
  if (error) throw error;

  return getAcademicRecords(studentId);
}

async function getAcademicRecords(studentId) {
  const { data, error } = await supabase
    .from('edu_academic')
    .select('*')
    .eq('student_id', studentId);

  if (error) throw error;
  return data;
}

// ─── Activities ───────────────────────────────────────

async function replaceActivities(studentId, activities) {
  await supabase.from('edu_activities').delete().eq('student_id', studentId);

  const rows = activities.map(a => ({
    student_id: studentId,
    ...a,
    created_at: new Date().toISOString(),
  }));

  const { error } = await supabase.from('edu_activities').insert(rows);
  if (error) throw error;

  return getActivities(studentId);
}

async function getActivities(studentId) {
  const { data, error } = await supabase
    .from('edu_activities')
    .select('*')
    .eq('student_id', studentId);

  if (error) throw error;
  return data;
}

// ─── Cognitive ───────────────────────────────────────

async function upsertCognitive(studentId, fields) {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('edu_cognitive')
    .upsert([{ id: studentId, ...fields, updated_at: now }])
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function getCognitive(studentId) {
  const { data, error } = await supabase
    .from('edu_cognitive')
    .select('*')
    .eq('id', studentId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

// ─── Stream Scores ───────────────────────────────────

async function initStreamScores(studentId) {
  const { data } = await supabase
    .from('edu_stream_scores')
    .select('*')
    .eq('id', studentId)
    .maybeSingle();

  if (data) return;

  await supabase.from('edu_stream_scores').insert([{ id: studentId }]);
}

async function getStreamScores(studentId) {
  const { data, error } = await supabase
    .from('edu_stream_scores')
    .select('*')
    .eq('id', studentId)
    .maybeSingle();

  if (error) throw error;
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


