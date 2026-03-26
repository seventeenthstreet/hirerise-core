'use strict';

const logger = require('../../../utils/logger');
const supabase = require('../../../config/supabase');

const uniRepo = require('../../university/repositories/university.repository');
const empRepo = require('../../employer/repositories/employer.repository');

// ─── Tables ───────────────────────────────────────────

const STUDENT_COL       = 'edu_students';
const STREAM_COL        = 'edu_stream_scores';
const CAREER_COL        = 'edu_career_predictions';
const COGNITIVE_COL     = 'edu_cognitive_results';

// ─── Scoring Helpers ──────────────────────────────────

function scoreSkillMatch(studentSkills = [], requiredSkills = []) {
  if (!requiredSkills.length) return 50;

  const studentSet = new Set(studentSkills.map(s => s.toLowerCase()));
  let matched = 0;

  for (const req of requiredSkills) {
    const r = req.toLowerCase();
    if (studentSet.has(r)) matched++;
    else if ([...studentSet].some(s => s.includes(r) || r.includes(s))) matched += 0.5;
  }

  return Math.min(100, Math.round((matched / requiredSkills.length) * 100));
}

function scoreStreamAlignment(studentStream = '', targetStreams = []) {
  if (!targetStreams.length) return 50;
  if (!studentStream) return 25;

  return targetStreams.includes(studentStream) ? 100 : 0;
}

function scoreCareerAlignment(studentCareers = [], outcomes = []) {
  if (!outcomes.length || !studentCareers.length) return 50;

  const outcomeSet = new Set(outcomes.map(c => c.toLowerCase()));
  let overlap = 0;

  for (const c of studentCareers) {
    const name = (c.career_name || c).toLowerCase();
    if (outcomeSet.has(name)) overlap++;
    else if ([...outcomeSet].some(o => o.includes(name))) overlap += 0.5;
  }

  return Math.min(100, Math.round((overlap / studentCareers.length) * 100));
}

// ─── Load Student Profile ─────────────────────────────

async function loadStudentProfile(studentId) {
  const [studentRes, streamRes, careerRes, cognitiveRes] = await Promise.all([
    supabase.from(STUDENT_COL).select('*').eq('id', studentId).single(),
    supabase.from(STREAM_COL).select('*').eq('id', studentId).single(),
    supabase.from(CAREER_COL).select('*').eq('id', studentId).single(),
    supabase.from(COGNITIVE_COL).select('*').eq('id', studentId).single(),
  ]);

  if (!studentRes.data) {
    throw new Error(`Student ${studentId} not found`);
  }

  return {
    id: studentId,
    name: studentRes.data.name || null,
    education_level: studentRes.data.education_level || '',
    skills: studentRes.data.skills || [],
    recommended_stream: streamRes.data?.recommended_stream || '',
    top_careers: careerRes.data?.predictions || [],
    cognitive_profile: cognitiveRes.data || {},
  };
}

// ─── Program Matching ─────────────────────────────────

async function matchStudentToPrograms(studentId) {
  const [profile, programs] = await Promise.all([
    loadStudentProfile(studentId),
    uniRepo.listAllPrograms(),
  ]);

  const uniIds = [...new Set(programs.map(p => p.university_id))];
  const unis = await Promise.all(uniIds.map(id => uniRepo.getUniversity(id)));
  const uniMap = Object.fromEntries(unis.filter(Boolean).map(u => [u.id, u]));

  const scored = programs.map(p => {
    const stream = scoreStreamAlignment(profile.recommended_stream, p.streams);
    const career = scoreCareerAlignment(profile.top_careers, p.career_outcomes);
    const skill  = scoreSkillMatch(profile.skills, []);

    const total = Math.round(stream * 0.4 + career * 0.35 + skill * 0.25);

    return {
      program_id: p.id,
      program_name: p.program_name,
      university_name: uniMap[p.university_id]?.university_name || '',
      match_score: total,
    };
  });

  return scored.sort((a, b) => b.match_score - a.match_score).slice(0, 10);
}

// ─── Job Matching ─────────────────────────────────────

async function matchStudentToJobs(studentId) {
  const [profile, roles] = await Promise.all([
    loadStudentProfile(studentId),
    empRepo.listAllActiveJobRoles(),
  ]);

  const empIds = [...new Set(roles.map(r => r.employer_id))];
  const emps = await Promise.all(empIds.map(id => empRepo.getEmployer(id)));
  const empMap = Object.fromEntries(emps.filter(Boolean).map(e => [e.id, e]));

  const scored = roles.map(r => {
    const skill = scoreSkillMatch(profile.skills, r.required_skills);
    const stream = scoreStreamAlignment(profile.recommended_stream, r.streams);

    const total = Math.round(skill * 0.6 + stream * 0.4);

    return {
      role_id: r.id,
      role_name: r.role_name,
      company: empMap[r.employer_id]?.company_name || '',
      match_score: total,
    };
  });

  return scored.sort((a, b) => b.match_score - a.match_score).slice(0, 10);
}

// ─── Opportunities ────────────────────────────────────

async function getOpportunities(studentId) {
  const [universities, jobs] = await Promise.all([
    matchStudentToPrograms(studentId),
    matchStudentToJobs(studentId),
  ]);

  return { student_id: studentId, universities, jobs };
}

// ─── Aggregated Insights ──────────────────────────────

async function getMatchedStudentsForProgram(programId) {
  const { data: students } = await supabase
    .from(STREAM_COL)
    .select('*')
    .limit(200);

  if (!students) return { total_matched: 0 };

  return {
    program_id: programId,
    total_matched: students.length,
    avg_match_score: 50,
    stream_distribution: [],
    top_student_skills: [],
  };
}

async function getMatchedStudentsForJobRole(roleId) {
  const { data: students } = await supabase
    .from(STREAM_COL)
    .select('*')
    .limit(200);

  if (!students) return { total_pipeline: 0 };

  return {
    role_id: roleId,
    total_pipeline: students.length,
    avg_match_score: 50,
    skill_gap_analysis: [],
    stream_distribution: [],
  };
}

module.exports = {
  getOpportunities,
  matchStudentToPrograms,
  matchStudentToJobs,
  getMatchedStudentsForProgram,
  getMatchedStudentsForJobRole,
  loadStudentProfile,
};