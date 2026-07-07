'use strict';

/**
 * src/modules/jobMatchPremium/mappers/candidateProfile.mapper.js
 *
 * Engine 1 — CandidateProfileMapper
 *
 * Loads user_profiles, user_skills, and resumes.parsed_data from Supabase.
 * Constructs a normalised CandidateProfile suitable for downstream engines.
 *
 * Rules:
 * - Handles partial profiles and null values with safe defaults
 * - Derives careerLevel from experienceYears
 * - Returns a plain object — no DB side-effects
 * - No PII persistence — callers must not log the return value verbatim
 */

const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const CAREER_LEVELS = Object.freeze({
  ENTRY:  { label: 'entry',  minYears: 0,  maxYears: 2  },
  MID:    { label: 'mid',    minYears: 2,  maxYears: 5  },
  SENIOR: { label: 'senior', minYears: 5,  maxYears: 10 },
  LEAD:   { label: 'lead',   minYears: 10, maxYears: Infinity },
});

const EDUCATION_ORDINAL = Object.freeze({
  'High School': 1,
  'Diploma': 2,
  "Bachelor's Degree": 3,
  'Professional Certification': 4,
  "Master's Degree": 5,
  MBA: 5,
  PhD: 6,
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function deriveCareerLevel(experienceYears) {
  const years = Number(experienceYears) || 0;
  for (const level of Object.values(CAREER_LEVELS)) {
    if (years >= level.minYears && years < level.maxYears) {
      return level.label;
    }
  }
  return CAREER_LEVELS.ENTRY.label;
}

function normalizeEducationLevel(education) {
  if (!education) return null;
  const label = String(education).trim();
  return EDUCATION_ORDINAL[label] ?? null;
}

function safeArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (_) { return []; }
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// DATA FETCHERS
// ─────────────────────────────────────────────────────────────────────────────

async function fetchUserProfile(userId) {
  const { data, error } = await supabase
    .from('user_profiles')
    .select(`
      target_role,
      target_role_id,
      current_job_title,
      experience_years,
      education,
      industry
    `)
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    logger.warn('[CandidateProfileMapper] user_profiles fetch degraded', {
      userId,
      error: error.message,
    });
    return null;
  }

  return data;
}

async function fetchUserSkills(userId) {
  const { data, error } = await supabase
    .from('user_skills')
    .select('skill_name, skill_id, proficiency_level')
    .eq('user_id', userId);

  if (error) {
    logger.warn('[CandidateProfileMapper] user_skills fetch degraded', {
      userId,
      error: error.message,
    });
    return [];
  }

  return data ?? [];
}

async function fetchResumeData(resumeId, userId) {
  const { data, error } = await supabase
    .from('resumes')
    .select('id, parsed_data, file_name')
    .eq('id', resumeId)
    .eq('user_id', userId)
    .eq('soft_deleted', false)
    .maybeSingle();

  if (error) {
    throw new AppError(
      'Resume fetch failed during profile mapping',
      500,
      { resumeId },
      ErrorCodes.INTERNAL_ERROR
    );
  }

  if (!data) {
    throw new AppError(
      'Resume not found',
      404,
      { resumeId },
      ErrorCodes.NOT_FOUND
    );
  }

  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN MAPPER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a CandidateProfile from Supabase data.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.resumeId
 * @returns {Promise<CandidateProfile>}
 */
async function buildCandidateProfile({ userId, resumeId }) {
  const [profile, skills, resume] = await Promise.all([
    fetchUserProfile(userId),
    fetchUserSkills(userId),
    fetchResumeData(resumeId, userId),
  ]);

  const parsedData = resume.parsed_data ?? {};

  // Merge skills from user_skills and parsed resume data
  const profileSkillNames = skills.map((s) => s.skill_name).filter(Boolean);
  const parsedSkillNames  = safeArray(parsedData.skills ?? parsedData.skill_names ?? []);
  const mergedSkills = [...new Set([...profileSkillNames, ...parsedSkillNames])];

  const experienceYears = Number(
    profile?.experience_years ??
    parsedData.years_experience ??
    parsedData.experience_years ??
    0
  );

  const education    = profile?.education ?? parsedData.education_level ?? null;
  const targetRole   = profile?.target_role ?? parsedData.target_role ?? null;
  const targetRoleId = profile?.target_role_id ?? null;

  return {
    candidateId:    userId,
    resumeId,
    skills:         mergedSkills,
    experienceYears,
    education,
    educationLevel: normalizeEducationLevel(education),
    targetRole,
    targetRoleId,
    careerLevel:    deriveCareerLevel(experienceYears),
  };
}

module.exports = { buildCandidateProfile };
