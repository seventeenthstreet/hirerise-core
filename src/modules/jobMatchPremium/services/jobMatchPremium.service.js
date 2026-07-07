'use strict';

/**
 * src/modules/jobMatchPremium/services/jobMatchPremium.service.js
 *
 * Service Layer — Premium Match Orchestrator
 *
 * Orchestrates all 7 engines in the WP-13B pipeline:
 *
 *   1. CandidateProfileMapper     — load profile
 *   2. MatchScore Engine          — AI score + tier (wraps premiumEngine)
 *   3. Breakdown Engine           — sub-scores + market demand
 *   4. SkillGap Engine (chiV2)    — missing skills (REUSED, not duplicated)
 *   5. ExplanationBuilder         — deterministic reasons (no AI)
 *   6. PremiumInsight Engine      — actionable insights
 *   7. Repository                 — persist (no PII)
 *
 * Additional responsibilities:
 * - Credit deduction via Supabase RPC (deduct_credits)
 * - Credit refund on engine failure (refund_credits)
 * - Telemetry: usage_logs insert (best-effort, non-blocking)
 *
 * Rules:
 * - Authenticate assumption: req.user MUST be set before calling this service
 * - No raw resume text persisted
 * - No PII persisted
 * - Refund on any engine failure after credit deduction
 */

const { supabase }   = require('../../../config/supabase');
const logger         = require('../../../utils/logger');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');

const { CREDIT_COSTS } = require('../../analysis/analysis.constants');
const { buildCandidateProfile } = require('../mappers/candidateProfile.mapper');
const { runMatchScoreEngine }   = require('../engines/matchScore.engine');
const { runBreakdownEngine }    = require('../engines/breakdown.engine');
const { buildExplanation }      = require('../utils/explanationBuilder');
const { generatePremiumInsights } =
  require('../utils/premiumInsight.util');
const { persistAnalysis, findLatestAnalysis } = require('../repositories/jobMatchPremium.repository');

// SkillGap — reuse chiV2 engine directly; no re-implementation
// Export is `analyseSkillGap(roleId, userSkills)` — see chiV2/skillGapEngine.js
const { analyseSkillGap } = require('../../chiV2/skillGapEngine');

const OPERATION_TYPE = 'jobMatchPremium';
const CREDIT_COST = CREDIT_COSTS[OPERATION_TYPE] ?? CREDIT_COSTS.jobMatchAnalysis ?? 2;

// ─────────────────────────────────────────────────────────────────────────────
// CREDIT RPC HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function deductCredits(userId, amount) {
  const { error } = await supabase.rpc('deduct_credits', {
    user_id: userId,
    amount,
  });
  if (error) {
    throw new AppError(
      'Credit deduction failed',
      500,
      { userId, amount },
      ErrorCodes.INTERNAL_ERROR
    );
  }
}

async function refundCredits(userId, amount) {
  try {
    await supabase.rpc('refund_credits', {
      user_id: userId,
      amount,
    });
  } catch (err) {
    // Refund failure is logged but must not mask the original error
    logger.error('[JobMatchPremiumService] refund_credits failed', {
      userId,
      amount,
      error: err.message,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CREDIT CHECK
// ─────────────────────────────────────────────────────────────────────────────

async function getCreditsRemaining(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('ai_credits_remaining')
    .eq('id', userId)
    .maybeSingle();

  if (error || !data) {
    throw new AppError(
      'User not found',
      404,
      { userId },
      ErrorCodes.NOT_FOUND
    );
  }

  return Number(data.ai_credits_remaining ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// SKILL GAP — safe degradation when roleId is absent
//
// analyseSkillGap(roleId, userSkills) → {
//   missing_skills: [{ skill_id, skill_name, importance_weight }],
//   learning_path:  { steps: [{ skill_name, estimated_weeks, ... }], estimated_weeks, ... },
//   matched_skills, skill_coverage_pct, total_required, total_missing, total_matched
// }
//
// We normalise the return to { missingSkills: [] } with frontend-compatible fields.
// ─────────────────────────────────────────────────────────────────────────────

async function safeComputeSkillGap(candidateProfile) {
  const { targetRoleId, skills: userSkills } = candidateProfile;

  if (!targetRoleId) {
    logger.debug('[JobMatchPremiumService] no targetRoleId — skipping skillGap');
    return { missingSkills: [] };
  }

  try {
    const result = await analyseSkillGap(targetRoleId, userSkills);

    // Build a weeks-lookup from learning_path.steps (keyed by skill_name)
    const weeksMap = {};
    for (const step of result?.learning_path?.steps ?? []) {
      if (step.skill_name) weeksMap[step.skill_name] = step.estimated_weeks ?? 4;
    }

    // Normalise missing_skills to the frontend contract shape
    const missingSkills = (result?.missing_skills ?? []).map((s) => {
      const weight   = Number(s.importance_weight ?? 0);
      const priority =
        weight >= 0.7 ? 'high_priority' :
        weight >= 0.35 ? 'medium_priority' : 'low_priority';

      return {
        skill_name:            s.skill_name ?? 'Unknown',
        skill_id:              s.skill_id ?? null,
        skill_category:        s.skill_category ?? 'technical',
        difficulty_level:      s.difficulty_level ?? 2,
        priority,
        estimatedWeeksToLearn: weeksMap[s.skill_name] ?? 4,
        importance_weight:     weight,
        demand_score:          s.demand_score ?? null,
      };
    });

    return { missingSkills };
  } catch (err) {
    logger.warn('[JobMatchPremiumService] skillGap degraded', {
      targetRoleId,
      error: err.message,
    });
    return { missingSkills: [] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TELEMETRY — non-blocking, best-effort
// ─────────────────────────────────────────────────────────────────────────────

async function logUsage(userId, result) {
  try {
    await supabase.from('usage_logs').insert({
      user_id:      userId,
      feature:      OPERATION_TYPE,
      tier:         result.tier,
      model:        result.aiModelVersion ?? 'premium-match-engine',
      total_tokens: (result.tokenInputCount ?? 0) + (result.tokenOutputCount ?? 0),
      cost_usd:     result.aiCostUsd ?? 0,
      created_at:   new Date().toISOString(),
    });
  } catch (err) {
    logger.warn('[JobMatchPremiumService] usage_logs write skipped', {
      userId,
      error: err.message,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RESUME TEXT FETCH (needed by match score engine)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchResumeText(resumeId, userId) {
  const { data, error } = await supabase
    .from('resumes')
    .select('resume_text, file_name')
    .eq('id', resumeId)
    .eq('user_id', userId)
    .eq('soft_deleted', false)
    .maybeSingle();

  if (error) {
    throw new AppError('Resume fetch failed', 500, { resumeId }, ErrorCodes.INTERNAL_ERROR);
  }
  if (!data) {
    throw new AppError('Resume not found', 404, { resumeId }, ErrorCodes.NOT_FOUND);
  }
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN — runPremiumMatch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs the full Premium Match pipeline.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.resumeId
 * @param {string} [params.userTier]   - Subscription tier for model routing
 * @returns {Promise<PremiumMatchResult>}
 */
async function runPremiumMatch({ userId, resumeId, userTier = 'premium' }) {
  logger.info('[JobMatchPremiumService] runPremiumMatch start', { userId, resumeId });

  // ── 1. Credit check ────────────────────────────────────────────────────────
  let creditsRemaining = await getCreditsRemaining(userId);

  if (creditsRemaining < CREDIT_COST) {
    throw new AppError(
      'Insufficient credits',
      402,
      { required: CREDIT_COST, available: creditsRemaining },
      ErrorCodes.PAYMENT_REQUIRED
    );
  }

  // ── 2. Deduct credits ──────────────────────────────────────────────────────
  await deductCredits(userId, CREDIT_COST);
  creditsRemaining -= CREDIT_COST;

  // ── 3. Run engines with refund guard ─────────────────────────────────────
  let matchScoreResult;
  let candidateProfile;
  let breakdown;
  let skillGap;
  let explanation;
  let insights;

  try {
    // 3a. Profile
    candidateProfile = await buildCandidateProfile({ userId, resumeId });

    // 3b. Resume text (needed by match score engine)
    const { resume_text: resumeText, file_name: fileName } = await fetchResumeText(resumeId, userId);

    // 3c. Match score + breakdown run in parallel where possible
    [matchScoreResult, breakdown] = await Promise.all([
      runMatchScoreEngine({
        resumeId,
        resumeText,   // NOT persisted by this service
        fileName,
        weightedCareerContext: [candidateProfile],
        userTier,
        userId,
      }),
      runBreakdownEngine({ resumeId, userId, candidateProfile }),
    ]);

    // 3d. Skill gap (depends only on profile, not match score)
    skillGap = await safeComputeSkillGap(candidateProfile);

    // 3e. Explanation (deterministic, synchronous)
    explanation = buildExplanation({
      matchScore:  matchScoreResult.matchScore,
      tier:        matchScoreResult.tier,
      breakdown,
      skillGap,
      careerLevel: candidateProfile.careerLevel,
    });

    // 3f. Insights (deterministic, synchronous)
    ({ insights } = generatePremiumInsights({
      breakdown,
      skillGap,
      careerLevel: candidateProfile.careerLevel,
      targetRole:  candidateProfile.targetRole,
    }));

  } catch (engineErr) {
    // Engine failure — refund credits, re-throw
    await refundCredits(userId, CREDIT_COST);
    logger.error('[JobMatchPremiumService] engine failure — credits refunded', {
      userId,
      resumeId,
      error: engineErr.message,
    });
    throw engineErr;
  }

  // ── 4. Persist (no PII) ───────────────────────────────────────────────────
  const { id: analysisId } = await persistAnalysis({
    resumeId,
    userId,
    matchScore:       matchScoreResult.matchScore,
    tier:             matchScoreResult.tier,
    breakdown,
    skillGap,
    explanation,
    insights,
    analysisHash:     matchScoreResult.analysisHash,
    aiModelVersion:   matchScoreResult.aiModelVersion,
    cacheHit:         matchScoreResult.cacheHit,
    latencyMs:        matchScoreResult.latencyMs,
    tokenInputCount:  matchScoreResult.tokenInputCount,
    tokenOutputCount: matchScoreResult.tokenOutputCount,
    aiCostUsd:        matchScoreResult.aiCostUsd,
  });

  // ── 5. Telemetry (non-blocking) ───────────────────────────────────────────
  logUsage(userId, {
    tier:             matchScoreResult.tier,
    aiModelVersion:   matchScoreResult.aiModelVersion,
    tokenInputCount:  matchScoreResult.tokenInputCount,
    tokenOutputCount: matchScoreResult.tokenOutputCount,
    aiCostUsd:        matchScoreResult.aiCostUsd,
  }).catch(() => {});

  logger.info('[JobMatchPremiumService] runPremiumMatch complete', {
    userId,
    resumeId,
    analysisId,
    matchScore: matchScoreResult.matchScore,
    tier:       matchScoreResult.tier,
  });

  return {
    analysisId,
    resumeId,
    matchScore:       matchScoreResult.matchScore,
    tier:             matchScoreResult.tier,
    breakdown,
    skillGap,
    explanation,
    insights,
    engine:           'premium',
    cacheHit:         matchScoreResult.cacheHit,
    aiModelVersion:   matchScoreResult.aiModelVersion,
    latencyMs:        matchScoreResult.latencyMs,
    creditsRemaining,
    scoredAt:         new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN — getLatestMatch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the most recent premium match analysis for a resume.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.resumeId
 * @returns {Promise<object|null>}
 */
async function getLatestMatch({ userId, resumeId }) {
  const record = await findLatestAnalysis(resumeId, userId);
  if (!record) return null;

  return {
    analysisId:  record.id,
    resumeId:    record.resume_id,
    matchScore:  record.match_score,
    tier:        record.tier,
    breakdown:   record.breakdown,
    skillGap:    record.skill_gap,
    explanation: record.explanation,
    insights:    record.insights,
    engine:      'premium',
    cacheHit:    record.cache_hit,
    scoredAt:    record.created_at,
  };
}

module.exports = { runPremiumMatch, getLatestMatch };
