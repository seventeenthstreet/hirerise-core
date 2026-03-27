'use strict';

/* Canonical version — import from this path only. src/services/ copy deleted (B-02). */

/**
 * jobMatch.service.js
 *
 * Orchestrates the dual-engine job-match analysis flow.
 *
 * CRITICAL FLOW:
 *   1. Verify user tier
 *   2. Free → runFreeEngine() (no credits, no Claude)
 *   3. Pro  → check credits → deduct → runPremiumEngine() → save
 *              if engine throws → REFUND credits → rethrow
 *
 * COST PROTECTION RULES:
 *   - Credits deducted BEFORE Claude is called
 *   - Credits REFUNDED if Claude call fails
 *   - Claude is NEVER called if credits are insufficient
 *   - Credit mutations use Supabase RPC (atomic Postgres function)
 *
 * Frontend NEVER decides which engine to call.
 * Backend is the single authority.
 */

const supabase = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');
const { runFreeEngine } = require('./engines/freeEngine');
const { runFullAnalysis, runGenerateCV } = require('./engines/premiumEngine');
const { CREDIT_COSTS, isValidOperation } = require('./analysis.constants');
const { getWeightedRoleContext } = require('../../services/career/careerWeight.service');

// ─── Fetch user's role profile for context enrichment ────────────────────────

/**
 * fetchCareerContext(userId)
 *
 * Fetches user_profiles/{userId} and returns a weighted role context array
 * ready to pass to AI engines.
 *
 * Returns null (non-fatal) if no profile exists or on any read error.
 *
 * @param   {string} userId
 * @returns {Promise<Array|null>}
 */
async function fetchCareerContext(userId) {
  try {
    // FIXED: { data, error } destructuring — removed snap.exists / snap.data()
    const { data: profile, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    if (error || !profile) return null;

    // New structure: careerHistory[] with durationMonths
    if (Array.isArray(profile.careerHistory) && profile.careerHistory.length > 0) {
      return getWeightedRoleContext(profile.careerHistory);
    }

    // Legacy structure: currentRoleId + previousRoleIds
    const legacyRoles = [];
    if (profile.currentRoleId) {
      legacyRoles.push({ roleId: profile.currentRoleId, durationMonths: 1, isCurrent: true });
    }
    if (Array.isArray(profile.previousRoleIds)) {
      profile.previousRoleIds.forEach(id => {
        legacyRoles.push({ roleId: id, durationMonths: 1, isCurrent: false });
      });
    }
    if (legacyRoles.length > 0) {
      return getWeightedRoleContext(legacyRoles);
    }
    return null;
  } catch (err) {
    logger.warn('[AnalysisService] Failed to fetch career context', {
      userId,
      error: err.message,
    });
    return null;
  }
}

// ─── Credit helpers (Supabase RPC — atomic Postgres functions) ───────────────

async function getUserCredits(userId) {
  // FIXED: { data, error } destructuring — removed doc.exists / doc.data()
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    throw new AppError('Failed to fetch user', 500, { error: error.message }, ErrorCodes.INTERNAL_ERROR);
  }
  if (!data) {
    throw new AppError('User not found', 404, {}, ErrorCodes.NOT_FOUND);
  }
  return data;
}

// FIXED: replaced db.collection / db.runTransaction / txn.get / txn.update
// with supabase.rpc('deduct_credits') — atomic Postgres function.
async function deductCredits(userId, amount) {
  const { error } = await supabase.rpc('deduct_credits', {
    user_id: userId,
    amount,
  });

  if (error) {
    if (error.message.includes('Insufficient credits')) {
      throw new AppError('Insufficient AI credits.', 402, {
        creditsRequired: amount,
      }, ErrorCodes.PAYMENT_REQUIRED);
    }
    throw new AppError('Credit deduction failed', 500, { error: error.message }, ErrorCodes.INTERNAL_ERROR);
  }

  logger.debug('[AnalysisService] Credits deducted', { userId, amount });
}

// FIXED: replaced db.collection / db.runTransaction / txn.get / txn.update
// with supabase.rpc('refund_credits') — atomic Postgres function.
async function refundCredits(userId, amount) {
  try {
    const { error } = await supabase.rpc('refund_credits', {
      user_id: userId,
      amount,
    });

    if (error) throw error;

    logger.debug('[AnalysisService] Credits refunded', { userId, amount });
  } catch (err) {
    // Refund failure must not crash the user-facing error.
    // Log as critical — investigate manually.
    logger.error('[AnalysisService] CRITICAL: Credit refund failed', {
      userId,
      amount,
      error: err.message,
    });
  }
}

// ─── Fetch resume data ────────────────────────────────────────────────────────

async function fetchResume(userId, resumeId) {
  // FIXED: { data, error } destructuring — removed doc.exists / doc.data()
  const { data, error } = await supabase
    .from('resumes')
    .select('*')
    .eq('id', resumeId)
    .maybeSingle();

  if (error) {
    throw new AppError('Failed to fetch resume', 500, { error: error.message }, ErrorCodes.INTERNAL_ERROR);
  }
  if (!data) {
    throw new AppError('Resume not found', 404, { resumeId }, ErrorCodes.NOT_FOUND);
  }
  if (data.userId !== userId && data.user_id !== userId) {
    throw new AppError('Unauthorized', 403, { resumeId }, ErrorCodes.UNAUTHORIZED);
  }
  if (!data.resumeText || data.resumeText.trim().length < 50) {
    throw new AppError('Resume text is too short or missing.', 422, { resumeId }, ErrorCodes.VALIDATION_ERROR);
  }
  return data;
}

// ─── Save analysis result ─────────────────────────────────────────────────────

async function saveAnalysisResult(userId, resumeId, result) {
  try {
    const { error } = await supabase
      .from('resumes')
      .update({
        analysisStatus:           'completed',
        engine:                   result.engine,
        score:                    result.score ?? null,
        tier:                     result.tier ?? null,
        scoreBreakdown:           result.breakdown ?? null,
        strengths:                result.strengths ?? [],
        improvements:             result.improvements ?? [],
        topSkills:                result.topSkills ?? [],
        estimatedExperienceYears: result.estimatedExperienceYears ?? null,
        chiScore:                 result.chiScore ?? null,
        dimensions:               result.dimensions ?? null,
        marketPosition:           result.marketPosition ?? null,
        peerComparison:           result.peerComparison ?? null,
        growthInsights:           result.growthInsights ?? null,
        salaryEstimate:           result.salaryEstimate ?? null,
        roadmap:                  result.roadmap ?? null,
        scoredAt:                 new Date().toISOString(),
        updatedAt:                new Date().toISOString(),
      })
      .eq('id', resumeId);

    if (error) throw error;
  } catch (err) {
    // Non-fatal — analysis result returned even if save fails
    logger.warn('[AnalysisService] Failed to save analysis result', {
      resumeId,
      error: err.message,
    });
  }
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

/**
 * runAnalysis({ userId, resumeId, operationType, tier })
 *
 * @param {string} userId
 * @param {string} resumeId
 * @param {string} operationType - 'fullAnalysis' | 'generateCV'
 * @param {string} [tier]        - Tier from auth token (req.user.plan).
 * @returns {object} analysis result
 */
async function runAnalysis({ userId, resumeId, operationType, tier }) {
  if (!isValidOperation(operationType)) {
    throw new AppError(`Invalid operationType: ${operationType}`, 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  logger.debug('[AnalysisService] runAnalysis start', { userId, resumeId, operationType });

  const [user, resumeData] = await Promise.all([
    getUserCredits(userId),
    fetchResume(userId, resumeId),
  ]);

  const weightedCareerContext = await fetchCareerContext(userId);

  // Prefer tier from auth token (cryptographically signed).
  // Fall back to DB field only if tier was not supplied (non-HTTP call sites).
  const effectiveTier = tier ?? user.tier ?? 'free';

  // ── Free tier → rule-based engine, no credits ──────────────────────────
  if (effectiveTier === 'free') {
    logger.debug('[AnalysisService] Running free engine', { userId });
    const result = runFreeEngine({
      resumeId,
      resumeText: resumeData.resumeText,
      fileName:   resumeData.fileName,
    });
    await saveAnalysisResult(userId, resumeId, result);
    return result;
  }

  // ── Pro tier → credit check → deduct → premium engine ──────────────────
  const creditCost = CREDIT_COSTS[operationType];
  if ((user.aiCreditsRemaining ?? user.ai_credits_remaining ?? 0) < creditCost) {
    throw new AppError('You have run out of AI credits. Please purchase a new plan.', 402, {
      creditsRequired:  creditCost,
      creditsAvailable: user.aiCreditsRemaining ?? user.ai_credits_remaining ?? 0,
    }, ErrorCodes.PAYMENT_REQUIRED);
  }

  // Deduct BEFORE calling Claude
  await deductCredits(userId, creditCost);

  // Call premium engine — refund on failure
  let result;
  try {
    if (operationType === 'fullAnalysis') {
      result = await runFullAnalysis({
        resumeId,
        resumeText:            resumeData.resumeText,
        fileName:              resumeData.fileName,
        weightedCareerContext: weightedCareerContext ?? null,
      });
    } else if (operationType === 'generateCV') {
      result = await runGenerateCV({
        userId,
        resumeText:      resumeData.resumeText,
        fileName:        resumeData.fileName,
        personalDetails: resumeData.personalDetails ?? {},
      });
    }
  } catch (err) {
    await refundCredits(userId, creditCost);
    throw err;
  }

  await saveAnalysisResult(userId, resumeId, result);

  const updatedUser = await getUserCredits(userId);
  const creditsRemaining = updatedUser.aiCreditsRemaining ?? updatedUser.ai_credits_remaining;

  logger.debug('[AnalysisService] runAnalysis complete', {
    userId,
    operationType,
    creditsRemaining,
  });

  return { ...result, creditsRemaining };
}

module.exports = { runAnalysis };