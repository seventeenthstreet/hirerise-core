'use strict';

/**
 * analysis.service.js
 *
 * Orchestrates the dual-engine analysis flow.
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
 *   - All credit mutations are Firestore transactions (atomic)
 *
 * Frontend NEVER decides which engine to call.
 * Backend is the single authority.
 */

const { db } = require('../../config/firebase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');

const { runFreeEngine }    = require('./engines/freeEngine');
const { runFullAnalysis, runGenerateCV } = require('./engines/premiumEngine');
const { CREDIT_COSTS, isValidOperation } = require('./analysis.constants');
const { getWeightedRoleContext } = require('../../services/career/careerWeight.service');

// ─── Fetch user's role profile for context enrichment ────────────────────────

/**
 * fetchCareerContext(userId)
 *
 * Fetches userProfiles/{userId} and returns a weighted role context array
 * ready to pass to AI engines.
 *
 * Returns null (non-fatal) if no profile exists or on any read error —
 * the analysis engine must still run without this enrichment.
 *
 * Handles both new (careerHistory[]) and legacy (currentRoleId + previousRoleIds)
 * structures transparently.
 *
 * @param   {string} userId
 * @returns {Promise<Array|null>}
 */
async function fetchCareerContext(userId) {
  try {
    const snap = await db.collection('userProfiles').doc(userId).get();
    if (!snap.exists) return null;

    const profile = snap.data();

    // New structure: careerHistory[] with durationMonths
    if (Array.isArray(profile.careerHistory) && profile.careerHistory.length > 0) {
      return getWeightedRoleContext(profile.careerHistory);
    }

    // Legacy structure: currentRoleId + previousRoleIds — treat all as equal weight (1)
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
      return getWeightedRoleContext(legacyRoles); // equal weights because all durationMonths = 1
    }

    return null;
  } catch (err) {
    // Non-fatal: log and continue without career context
    logger.warn('[AnalysisService] Failed to fetch career context', { userId, error: err.message });
    return null;
  }
}

// ─── Credit helpers (Firestore atomic) ───────────────────────

async function getUserCredits(userId) {
  const doc = await db.collection('users').doc(userId).get();
  if (!doc.exists) throw new AppError('User not found', 404, {}, ErrorCodes.NOT_FOUND);
  return doc.data();
}

async function deductCredits(userId, amount) {
  const ref = db.collection('users').doc(userId);

  await db.runTransaction(async (txn) => {
    const doc  = await txn.get(ref);
    const data = doc.data();

    const current = data.aiCreditsRemaining ?? 0;
    if (current < amount) {
      throw new AppError(
        'Insufficient AI credits.',
        402,
        { creditsRequired: amount, creditsAvailable: current },
        ErrorCodes.PAYMENT_REQUIRED
      );
    }

    txn.update(ref, {
      aiCreditsRemaining: current - amount,
      updatedAt: new Date(),
    });
  });

  logger.debug('[AnalysisService] Credits deducted', { userId, amount });
}

async function refundCredits(userId, amount) {
  try {
    const ref = db.collection('users').doc(userId);
    await db.runTransaction(async (txn) => {
      const doc     = await txn.get(ref);
      const current = doc.data().aiCreditsRemaining ?? 0;
      txn.update(ref, { aiCreditsRemaining: current + amount, updatedAt: new Date() });
    });
    logger.debug('[AnalysisService] Credits refunded', { userId, amount });
  } catch (err) {
    // Refund failure must not crash the user-facing error
    // Log as critical — investigate manually
    logger.error('[AnalysisService] CRITICAL: Credit refund failed', { userId, amount, error: err.message });
  }
}

// ─── Fetch resume data ────────────────────────────────────────

async function fetchResume(userId, resumeId) {
  const doc = await db.collection('resumes').doc(resumeId).get();

  if (!doc.exists) {
    throw new AppError('Resume not found', 404, { resumeId }, ErrorCodes.NOT_FOUND);
  }

  const data = doc.data();
  if (data.userId !== userId) {
    throw new AppError('Unauthorized', 403, { resumeId }, ErrorCodes.UNAUTHORIZED);
  }

  if (!data.resumeText || data.resumeText.trim().length < 50) {
    throw new AppError(
      'Resume text is too short or missing.',
      422,
      { resumeId },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  return data;
}

// ─── Save analysis result to Firestore ───────────────────────

async function saveAnalysisResult(userId, resumeId, result) {
  try {
    await db.collection('resumes').doc(resumeId).update({
      analysisStatus:           'completed',
      engine:                   result.engine,
      score:                    result.score ?? null,
      tier:                     result.tier  ?? null,
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
      scoredAt:                 new Date(),
      updatedAt:                new Date(),
    });
  } catch (err) {
    // Non-fatal — analysis result returned even if save fails
    logger.warn('[AnalysisService] Failed to save analysis result', { resumeId, error: err.message });
  }
}

// ─── Main orchestrator ────────────────────────────────────────

/**
 * runAnalysis({ userId, resumeId, operationType, tier })
 *
 * @param {string} userId
 * @param {string} resumeId
 * @param {string} operationType - 'fullAnalysis' | 'generateCV'
 * @param {string} [tier]        - Tier from Firebase custom claim (req.user.plan).
 *                                 Pass this from the route handler.
 *                                 Falls back to Firestore users.tier only when not provided
 *                                 (backwards-compat for any non-request call sites).
 * @returns {object} analysis result
 */
async function runAnalysis({ userId, resumeId, operationType, tier }) {

  // ── Validate operation type ───────────────────────────────
  if (!isValidOperation(operationType)) {
    throw new AppError(
      `Invalid operationType: ${operationType}`,
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  logger.debug('[AnalysisService] runAnalysis start', { userId, resumeId, operationType });

  // ── Fetch user and resume ─────────────────────────────────
  const [user, resumeData] = await Promise.all([
    getUserCredits(userId),
    fetchResume(userId, resumeId),
  ]);

  // ── Fetch weighted career context (non-fatal if missing) ──
  // Supports both new careerHistory[] structure and legacy currentRoleId/previousRoleIds.
  // Passed to the premium engine as optional context — does NOT affect free engine.
  const weightedCareerContext = await fetchCareerContext(userId);

  // ── Resolve tier ──────────────────────────────────────────
  // Prefer tier from Firebase custom claim (passed by caller — cryptographically signed).
  // Fall back to Firestore field only if tier was not supplied (non-HTTP call sites).
  // NEVER use user.tier from Firestore as the sole authority for access-control.
  const effectiveTier = tier ?? user.tier ?? 'free';

  // ── Free tier → rule-based engine, no credits ─────────────
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

  // ── Pro tier → credit check → premium engine ──────────────
  const creditCost = CREDIT_COSTS[operationType];

  if ((user.aiCreditsRemaining ?? 0) < creditCost) {
    throw new AppError(
      'You have run out of AI credits. Please purchase a new plan.',
      402,
      {
        creditsRequired:  creditCost,
        creditsAvailable: user.aiCreditsRemaining ?? 0,
      },
      ErrorCodes.PAYMENT_REQUIRED
    );
  }

  // ── Deduct credits BEFORE calling Claude ──────────────────
  await deductCredits(userId, creditCost);

  // ── Call premium engine — refund on failure ───────────────
  let result;
  try {
    if (operationType === 'fullAnalysis') {
      result = await runFullAnalysis({
        resumeId,
        resumeText:            resumeData.resumeText,
        fileName:              resumeData.fileName,
        // weightedCareerContext is null when profile not set — engine must guard
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
    // Claude failed — refund credits
    await refundCredits(userId, creditCost);
    throw err; // rethrow original error
  }

  // ── Save result ───────────────────────────────────────────
  await saveAnalysisResult(userId, resumeId, result);

  // ── Fetch updated credit balance for response ─────────────
  const updatedUser = await getUserCredits(userId);

  logger.debug('[AnalysisService] runAnalysis complete', {
    userId,
    operationType,
    creditsRemaining: updatedUser.aiCreditsRemaining,
  });

  return {
    ...result,
    creditsRemaining: updatedUser.aiCreditsRemaining,
  };
}

module.exports = { runAnalysis };