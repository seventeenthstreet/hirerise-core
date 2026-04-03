'use strict';

/**
 * src/modules/opportunities/services/studentMatching.service.js
 *
 * Supabase-native production matching engine
 *
 * Architecture:
 * - edu_career_predictions uses normalized row-per-career rows
 * - predictions JSONB acts as denormalized fast-read cache
 * - syncPredictionsColumn(studentId) refreshes cache via RPC
 * - edu_cognitive_results.result_payload stores flexible psychometric data
 */

const logger = require('../../../utils/logger');
const { supabase } = require('../../../config/supabase');

const uniRepo = require('../../university/repositories/university.repository');
const empRepo = require('../../employer/repositories/employer.repository');

const TABLES = Object.freeze({
  STUDENTS: 'edu_students',
  STREAMS: 'edu_stream_scores',
  CAREERS: 'edu_career_predictions',
  COGNITIVE: 'edu_cognitive_results',
});

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return typeof value === 'string' ? value : '';
}

function scoreSkillMatch(studentSkills = [], requiredSkills = []) {
  const student = normalizeArray(studentSkills)
    .map((s) => String(s).toLowerCase());

  const required = normalizeArray(requiredSkills)
    .map((s) => String(s).toLowerCase());

  if (!required.length) return 50;

  const studentSet = new Set(student);
  let matched = 0;

  for (const req of required) {
    if (studentSet.has(req)) {
      matched += 1;
      continue;
    }

    for (const skill of studentSet) {
      if (skill.includes(req) || req.includes(skill)) {
        matched += 0.5;
        break;
      }
    }
  }

  return Math.min(100, Math.round((matched / required.length) * 100));
}

function scoreStreamAlignment(studentStream = '', targetStreams = []) {
  const stream = normalizeString(studentStream);
  const targets = normalizeArray(targetStreams);

  if (!targets.length) return 50;
  if (!stream) return 25;

  return targets.includes(stream) ? 100 : 0;
}

function scoreCareerAlignment(studentCareers = [], outcomes = []) {
  const careers = normalizeArray(studentCareers);
  const targetOutcomes = normalizeArray(outcomes);

  if (!careers.length || !targetOutcomes.length) return 50;

  const outcomeSet = new Set(
    targetOutcomes.map((c) => String(c).toLowerCase())
  );

  let overlap = 0;

  for (const career of careers) {
    const name = String(career?.career_name || career).toLowerCase();

    if (outcomeSet.has(name)) {
      overlap += 1;
      continue;
    }

    for (const outcome of outcomeSet) {
      if (outcome.includes(name) || name.includes(outcome)) {
        overlap += 0.5;
        break;
      }
    }
  }

  return Math.min(100, Math.round((overlap / careers.length) * 100));
}

/**
 * Refresh denormalized predictions JSONB cache
 * after any row-level career prediction write.
 */
async function syncPredictionsColumn(studentId) {
  const { error } = await supabase.rpc('sync_career_predictions', {
    p_student_id: studentId,
  });

  if (error) {
    logger.warn(
      {
        error: error.message,
        studentId,
        rpc: 'sync_career_predictions',
      },
      '[StudentMatching] predictions cache sync failed'
    );
  }
}

async function loadStudentProfile(studentId) {
  const [studentRes, streamRes, careerRes, cognitiveRes] = await Promise.all([
    supabase
      .from(TABLES.STUDENTS)
      .select('id, name, education_level, skills')
      .eq('id', studentId)
      .single(),

    supabase
      .from(TABLES.STREAMS)
      .select('recommended_stream')
      .eq('student_id', studentId)
      .maybeSingle(),

    supabase
      .from(TABLES.CAREERS)
      .select('predictions')
      .eq('student_id', studentId)
      .maybeSingle(),

    supabase
      .from(TABLES.COGNITIVE)
      .select('result_payload')
      .eq('student_id', studentId)
      .maybeSingle(),
  ]);

  if (studentRes.error) {
    throw studentRes.error;
  }

  if (!studentRes.data) {
    const error = new Error(`Student ${studentId} not found`);
    error.statusCode = 404;
    throw error;
  }

  return {
    id: studentId,
    name: studentRes.data.name || null,
    education_level: normalizeString(studentRes.data.education_level),
    skills: normalizeArray(studentRes.data.skills),
    recommended_stream: normalizeString(
      streamRes.data?.recommended_stream
    ),
    top_careers: normalizeArray(
      careerRes.data?.predictions
    ),
    cognitive_profile:
      cognitiveRes.data?.result_payload || {},
  };
}

async function resolveUniversities(programs) {
  const ids = [
    ...new Set(
      normalizeArray(programs)
        .map((p) => p.university_id)
        .filter(Boolean)
    ),
  ];

  if (!ids.length) return {};

  if (typeof uniRepo.getUniversitiesByIds === 'function') {
    const universities = await uniRepo.getUniversitiesByIds(ids);

    return Object.fromEntries(
      normalizeArray(universities).map((u) => [u.id, u])
    );
  }

  const universities = await Promise.all(
    ids.map((id) => uniRepo.getUniversity(id))
  );

  return Object.fromEntries(
    universities.filter(Boolean).map((u) => [u.id, u])
  );
}

async function resolveEmployers(roles) {
  const ids = [
    ...new Set(
      normalizeArray(roles)
        .map((r) => r.employer_id)
        .filter(Boolean)
    ),
  ];

  if (!ids.length) return {};

  if (typeof empRepo.getEmployersByIds === 'function') {
    const employers = await empRepo.getEmployersByIds(ids);

    return Object.fromEntries(
      normalizeArray(employers).map((e) => [e.id, e])
    );
  }

  const employers = await Promise.all(
    ids.map((id) => empRepo.getEmployer(id))
  );

  return Object.fromEntries(
    employers.filter(Boolean).map((e) => [e.id, e])
  );
}

async function matchStudentToPrograms(profile) {
  const programs = normalizeArray(
    await uniRepo.listAllPrograms()
  );

  const universityMap = await resolveUniversities(programs);

  return programs
    .map((program) => {
      const streamScore = scoreStreamAlignment(
        profile.recommended_stream,
        program.streams
      );

      const careerScore = scoreCareerAlignment(
        profile.top_careers,
        program.career_outcomes
      );

      const skillScore = scoreSkillMatch(
        profile.skills,
        []
      );

      const total = Math.round(
        streamScore * 0.4 +
        careerScore * 0.35 +
        skillScore * 0.25
      );

      return {
        program_id: program.id,
        program_name: program.program_name,
        university_name:
          universityMap[program.university_id]
            ?.university_name || '',
        match_score: total,
      };
    })
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, 10);
}

async function matchStudentToJobs(profile) {
  const roles = normalizeArray(
    await empRepo.listAllActiveJobRoles()
  );

  const employerMap = await resolveEmployers(roles);

  return roles
    .map((role) => {
      const skillScore = scoreSkillMatch(
        profile.skills,
        role.required_skills
      );

      const streamScore = scoreStreamAlignment(
        profile.recommended_stream,
        role.streams
      );

      const total = Math.round(
        skillScore * 0.6 + streamScore * 0.4
      );

      return {
        role_id: role.id,
        role_name: role.role_name,
        company:
          employerMap[role.employer_id]?.company_name || '',
        match_score: total,
      };
    })
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, 10);
}

async function getOpportunities(studentId) {
  try {
    const profile = await loadStudentProfile(studentId);

    const [universities, jobs] = await Promise.all([
      matchStudentToPrograms(profile),
      matchStudentToJobs(profile),
    ]);

    return {
      student_id: studentId,
      universities,
      jobs,
    };
  } catch (error) {
    logger.error(
      {
        error,
        studentId,
        service: 'studentMatching.service',
      },
      '[StudentMatching] Failed to get opportunities'
    );
    throw error;
  }
}

async function getMatchedStudentsForProgram(programId) {
  const { data, error } = await supabase
    .from(TABLES.STREAMS)
    .select('student_id')
    .limit(200);

  if (error) throw error;

  return {
    program_id: programId,
    total_matched: data?.length || 0,
    avg_match_score: 50,
    stream_distribution: [],
    top_student_skills: [],
  };
}

async function getMatchedStudentsForJobRole(roleId) {
  const { data, error } = await supabase
    .from(TABLES.STREAMS)
    .select('student_id')
    .limit(200);

  if (error) throw error;

  return {
    role_id: roleId,
    total_pipeline: data?.length || 0,
    avg_match_score: 50,
    skill_gap_analysis: [],
    stream_distribution: [],
  };
}

module.exports = Object.freeze({
  getOpportunities,
  matchStudentToPrograms,
  matchStudentToJobs,
  getMatchedStudentsForProgram,
  getMatchedStudentsForJobRole,
  loadStudentProfile,
  syncPredictionsColumn,
});