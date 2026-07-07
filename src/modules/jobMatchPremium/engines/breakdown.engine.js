'use strict';

/**
 * src/modules/jobMatchPremium/engines/breakdown.engine.js
 *
 * Engine 4 — Breakdown Engine
 *
 * Composes resumeScore.service.js (skills, experience, education sub-scores)
 * with marketDemandService.js (market demand signal) to produce a structured
 * breakdown object.
 *
 * Rules:
 * - Reuse existing service functions — no re-implementation
 * - Degrade gracefully when market demand is unavailable
 * - Return { skills, experience, education, marketDemand }
 * - All values are numeric 0–100 (or null for market demand if unavailable)
 */

const logger = require('../../../utils/logger');

// Lazy-load to respect CJS module order
function getResumeScoreService() {
  return require('../../../services/resumeScore.service');
}

function getMarketDemandService() {
  return require('../../../services/marketDemandService');
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORE NORMALISER
// Clamps any score to 0–100.
// ─────────────────────────────────────────────────────────────────────────────
function clamp(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// ─────────────────────────────────────────────────────────────────────────────
// MARKET DEMAND FETCH (degradable)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchMarketDemandScore(targetRole) {
  if (!targetRole) return null;

  try {
    const svc = getMarketDemandService();

    // fetchMarketDemand returns { demandScore, ... } or null
    const demand = await svc.fetchMarketDemand(targetRole, 'in');
    if (!demand) return null;

    // demandScore is expected on the returned record
    const raw = demand.demandScore ?? demand.demand_score ?? demand.score ?? null;
    return raw != null ? clamp(raw) : null;
  } catch (err) {
    logger.warn('[BreakdownEngine] marketDemand unavailable — degrading', {
      targetRole,
      error: err.message,
    });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RESUME SUBSCORES
// resumeScore.service exposes scoring functions. We call the public
// computeResumeScore(resumeId, userId) function and extract sub-scores from
// the result object. If the service exposes only the aggregate, we use the
// weights it publishes.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchResumeSubScores(resumeId, userId, candidateProfile) {
  try {
    const svc = getResumeScoreService();

    // computeResumeScore returns the full scored object including breakdown
    const result = await svc.computeResumeScore(resumeId, userId);

    return {
      skills:     clamp(result?.breakdown?.skills     ?? result?.skillsScore     ?? 0),
      experience: clamp(result?.breakdown?.experience ?? result?.experienceScore ?? 0),
      education:  clamp(result?.breakdown?.education  ?? result?.educationScore  ?? 0),
    };
  } catch (err) {
    logger.warn('[BreakdownEngine] resumeScore sub-scores unavailable', {
      resumeId,
      error: err.message,
    });

    // Fallback: derive from candidateProfile directly
    return deriveSubScoresFromProfile(candidateProfile);
  }
}

/**
 * Deterministic fallback when resumeScore.service is unavailable.
 * Uses the same weight table as resumeScore.service for consistency.
 */
function deriveSubScoresFromProfile(profile) {
  const W = { skills: 30, experience: 25, education: 15 };

  // Skills: sqrt scaling on skill count (mirrors resumeScore.service.scoreSkills)
  const unique = new Set(
    (profile.skills ?? []).map((s) => String(s).toLowerCase().trim())
  ).size;
  const skills = Math.round((Math.sqrt(Math.min(unique, 40)) / Math.sqrt(40)) * W.skills);

  // Experience: linear to 7 years cap (mirrors resumeScore.service.scoreExperience)
  const experience = Math.min(
    W.experience,
    Math.round((Math.max(0, profile.experienceYears || 0) / 7) * W.experience)
  );

  // Education: ordinal / max_ordinal * weight
  const MAX_EDU_ORDINAL = 6;
  const eduOrdinal = profile.educationLevel ?? 0;
  const education  = Math.round((eduOrdinal / MAX_EDU_ORDINAL) * W.education);

  return { skills, experience, education };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENGINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} params
 * @param {string} params.resumeId
 * @param {string} params.userId
 * @param {object} params.candidateProfile    - from CandidateProfileMapper
 * @returns {Promise<{ skills, experience, education, marketDemand }>}
 */
async function runBreakdownEngine({ resumeId, userId, candidateProfile }) {
  const [subScores, marketDemand] = await Promise.all([
    fetchResumeSubScores(resumeId, userId, candidateProfile),
    fetchMarketDemandScore(candidateProfile.targetRole),
  ]);

  return {
    skills:       subScores.skills,
    experience:   subScores.experience,
    education:    subScores.education,
    marketDemand: marketDemand,   // may be null — callers must handle
  };
}

module.exports = { runBreakdownEngine };
