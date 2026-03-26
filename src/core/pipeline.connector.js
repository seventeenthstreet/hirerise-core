'use strict';

/**
 * pipeline.connector.js — Supabase version
 */

const logger = require('../utils/logger');

// ─── Lazy service imports ─────────────────────────────────────────────────────

const getSupabase   = () => require('../config/supabase');
const getResumeScore = () => require('../services/resumeScore.service');
const getMatching    = () => require('../services/careerMatching.service');
const getChi         = () => require('../modules/careerHealthIndex/careerHealthIndex.service');

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: Load parsedData from Supabase
// ─────────────────────────────────────────────────────────────────────────────

async function loadParsedData(userId, resumeId) {
  const supabase = getSupabase();

  let doc = null;

  // Try specific resume
  if (resumeId) {
    const { data, error } = await supabase
      .from('resumes')
      .select('*')
      .eq('id', resumeId)
      .eq('user_id', userId)
      .maybeSingle();

    if (!error && data) {
      doc = data;
    } else {
      logger.warn('[Pipeline] resumeId invalid — fallback to latest', { userId, resumeId });
    }
  }

  // Fallback: latest resume
  if (!doc) {
    const { data, error } = await supabase
      .from('resumes')
      .select('*')
      .eq('user_id', userId)
      .eq('soft_deleted', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      throw Object.assign(
        new Error('No resume found for user'),
        { code: 'RESUME_NOT_FOUND', statusCode: 404 }
      );
    }

    doc = data;
  }

  const parsedData = doc.parsedData || doc.parsed_data || null;

  if (!parsedData) {
    logger.warn('[Pipeline] parsedData missing — using fallback');

    return {
      resumeDoc: doc,
      parsedData: {
        skills: doc.top_skills || [],
        detectedRoles: [],
        yearsExperience: doc.estimated_experience_years || null,
        confidenceScore: 20,
        education: [],
        educationLevel: null,
        industry: doc.industry || null,
        location: {},
      },
    };
  }

  return { resumeDoc: doc, parsedData };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: Build User Profile
// ─────────────────────────────────────────────────────────────────────────────

function buildUserProfile(userId, parsedData) {
  const skills = (parsedData.skills || [])
    .map(s => (typeof s === 'string' ? s : s?.name))
    .filter(Boolean)
    .map(s => s.toLowerCase().trim());

  return {
    userId,
    skills,
    experienceYears: Number(parsedData.yearsExperience || 0),
    detectedRoles: parsedData.detectedRoles || [],
    education: parsedData.education || [],
    educationLevel: parsedData.educationLevel || null,
    industry: parsedData.industry || null,
    location: parsedData.location || {},
    confidenceScore: parsedData.confidenceScore ?? 50,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3: Resume Scoring
// ─────────────────────────────────────────────────────────────────────────────

async function runScoring(userId) {
  const svc = getResumeScore();

  await svc.invalidate(userId);
  const score = await svc.calculate(userId);

  if (score.isMockData) {
    throw new Error('[Pipeline] resumeScore returned mock data');
  }

  logger.info('[Pipeline] Resume scored', {
    userId,
    score: score.overallScore,
  });

  return score;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4: Career Matching
// ─────────────────────────────────────────────────────────────────────────────

async function runCareerMatching(userId, userProfile) {
  const { matchCareerRoles, saveChiScore } = getMatching();
  const supabase = getSupabase();

  let domainId = null;

  try {
    const topRole = userProfile.detectedRoles?.[0];

    if (topRole) {
      const roleName = typeof topRole === 'object'
        ? (topRole.canonical || topRole.role || '')
        : String(topRole);

      const { data } = await supabase
        .from('cms_roles')
        .select('*')
        .eq('title', roleName)
        .eq('soft_deleted', false)
        .limit(1)
        .maybeSingle();

      if (data) domainId = data.domain_id;
    }
  } catch (err) {
    logger.warn('[Pipeline] Domain lookup failed', { error: err.message });
  }

  const matches = await matchCareerRoles(userProfile, domainId, { limit: 10 });

  await Promise.allSettled(
    matches.slice(0, 5).map(m =>
      saveChiScore(userId, m.role.id, m.scores)
    )
  );

  return matches;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5: CHI Calculation
// ─────────────────────────────────────────────────────────────────────────────

async function runChi(userId, resumeId) {
  const { calculateChi } = getChi();
  return await calculateChi(userId, resumeId);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PIPELINE
// ─────────────────────────────────────────────────────────────────────────────

async function runFullPipeline({ userId, resumeId }) {
  if (!userId) throw new Error('userId required');

  logger.info('[Pipeline] Start', { userId });

  const { parsedData, resumeDoc } = await loadParsedData(userId, resumeId);
  const userProfile = buildUserProfile(userId, parsedData);

  const resumeScore = await runScoring(userId);

  let careerMatches = [];
  try {
    careerMatches = await runCareerMatching(userId, userProfile);
  } catch (err) {
    logger.warn('[Pipeline] Matching failed', { error: err.message });
  }

  let chiSnapshot = null;
  try {
    chiSnapshot = await runChi(userId, resumeDoc?.id);
  } catch (err) {
    logger.warn('[Pipeline] CHI failed', { error: err.message });
  }

  return {
    userId,
    resumeScore,
    careerMatches,
    chiSnapshot,
    completedAt: new Date().toISOString(),
  };
}

module.exports = {
  runFullPipeline,
  buildUserProfile,
  loadParsedData,
};





