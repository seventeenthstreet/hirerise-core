'use strict';

/**
 * src/modules/jobMatchPremium/engines/matchScore.engine.js
 *
 * Engine 3 — Match Score Engine
 *
 * Wraps src/modules/analysis/engines/premiumEngine.js.
 * Delegates AI call, cache, circuit breaker, and concurrency guard
 * entirely to the existing premiumEngine. This engine normalises the
 * result and applies tier classification.
 *
 * Rules:
 * - DO NOT duplicate premiumEngine logic
 * - DO NOT introduce new AI clients
 * - Reuse existing caches and circuit breakers via premiumEngine
 * - Return { matchScore, tier, cacheHit, aiModelVersion, latencyMs,
 *            tokenInputCount, tokenOutputCount, aiCostUsd, analysisHash }
 */

const { runFullAnalysis } = require('../../analysis/engines/premiumEngine');
const { classifyTier }    = require('../utils/tierClassifier');
const logger              = require('../../../utils/logger');

/**
 * Runs the premium AI engine and returns a normalised match score + tier.
 *
 * @param {object} params
 * @param {string} params.resumeId
 * @param {string} params.resumeText        - Raw text of the resume (NOT persisted here)
 * @param {string} [params.fileName]
 * @param {Array}  [params.weightedCareerContext]
 * @param {string} [params.userTier]        - Subscription tier (for model routing)
 * @param {string} params.userId
 * @returns {Promise<MatchScoreResult>}
 */
async function runMatchScoreEngine({
  resumeId,
  resumeText,
  fileName,
  weightedCareerContext = [],
  userTier = 'premium',
  userId,
}) {
  logger.debug('[MatchScoreEngine] start', { resumeId, userTier });

  const raw = await runFullAnalysis({
    resumeId,
    resumeText,
    fileName,
    weightedCareerContext,
    userTier,
    userId,
  });

  // premiumEngine returns `score` as the primary numeric signal
  const { matchScore, tier } = classifyTier(raw.score ?? raw.matchScore ?? 0);

  return {
    matchScore,
    tier,
    analysisHash:      raw.analysisHash,
    aiModelVersion:    raw.aiModelVersion,
    cacheHit:          raw.cacheHit ?? false,
    cacheSource:       raw.cacheSource ?? null,
    latencyMs:         raw.latencyMs ?? 0,
    tokenInputCount:   raw.tokenInputCount ?? 0,
    tokenOutputCount:  raw.tokenOutputCount ?? 0,
    aiCostUsd:         raw.aiCostUsd ?? 0,
    // Pass through premium engine extras for persistence
    _raw: raw,
  };
}

module.exports = { runMatchScoreEngine };
