'use strict';

/**
 * src/modules/intelligence-quality/controllers/intelligence-quality.controller.js
 *
 * HTTP controller for the Phase 4A intelligence quality reporting endpoints.
 *
 * Responsibilities:
 *   - Extract userId from authenticated request
 *   - Delegate to IntelligenceQualityService
 *   - Return standard { success, data } envelope
 *   - Forward errors to Express error handler (next(err))
 *
 * Does NOT:
 *   - Run scoring (read-only — pipeline computes scores)
 *   - Access DB directly
 *   - Contain business logic
 */

const logger                      = require('../../../utils/logger');
const { getQualityService }       = require('../intelligence-quality.module');
const {
  explainSignalCoverage,
  explainSignalReliability,
  explainClusterStability,
  explainClusterDrift,
  explainAssessmentQuality,
} = require('../../../intelligence/models/intelligence-quality.explainability');

// ─────────────────────────────────────────────────────────────
// AUTH HELPER
// ─────────────────────────────────────────────────────────────

function resolveUserId(req) {
  return (
    req?.user?.id     ||
    req?.user?.uid    ||
    req?.auth?.userId ||
    req?.user?.user_id ||
    null
  );
}

// ─────────────────────────────────────────────────────────────
// RESPONSE HELPERS
// ─────────────────────────────────────────────────────────────

function sendSuccess(res, data) {
  return res.status(200).json({ success: true, data });
}

function sendNotFound(res, message) {
  return res.status(404).json({ success: false, error: message });
}

// ─────────────────────────────────────────────────────────────
// HANDLERS
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/v1/intelligence-quality/report
 *
 * Returns the full intelligence quality report:
 *   - coverage profile
 *   - reliability summary
 *   - cluster stability profiles
 *   - latest drift event
 *   - assessment quality explanation
 */
async function getQualityReport(req, res, next) {
  const userId = resolveUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

  try {
    const service = getQualityService();
    const report  = await service.getQualityReport(userId);

    if (!report.coverage) {
      return sendNotFound(res, 'No intelligence quality data found. Complete your assessment to generate a quality report.');
    }

    return sendSuccess(res, report);
  } catch (err) {
    logger.error('[IntelligenceQualityController.getQualityReport]', { userId, error: err.message });
    return next(err);
  }
}

/**
 * GET /api/v1/intelligence-quality/coverage
 *
 * Returns the latest signal coverage profile with coverage notes and trait gaps.
 */
async function getCoverageProfile(req, res, next) {
  const userId = resolveUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

  try {
    const service  = getQualityService();
    const coverage = await service.getCoverageProfile(userId);

    if (!coverage) {
      return sendNotFound(res, 'No coverage data found.');
    }

    const explanation = explainSignalCoverage(coverage);

    return sendSuccess(res, { coverage, explanation });
  } catch (err) {
    logger.error('[IntelligenceQualityController.getCoverageProfile]', { userId, error: err.message });
    return next(err);
  }
}

/**
 * GET /api/v1/intelligence-quality/stability
 *
 * Returns all cluster stability profiles for the user.
 * Includes per-cluster stability level, trend, and explanation.
 */
async function getStabilityProfiles(req, res, next) {
  const userId = resolveUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

  try {
    const service   = getQualityService();
    const stability = await service.getStabilityProfiles(userId);

    const profilesWithExplanations = (stability ?? []).map(profile => ({
      ...profile,
      explanation: explainClusterStability(profile),
    }));

    return sendSuccess(res, { stabilityProfiles: profilesWithExplanations });
  } catch (err) {
    logger.error('[IntelligenceQualityController.getStabilityProfiles]', { userId, error: err.message });
    return next(err);
  }
}

/**
 * GET /api/v1/intelligence-quality/drift
 *
 * Returns latest drift event and drift history summary.
 */
async function getDriftHistory(req, res, next) {
  const userId = resolveUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

  try {
    const service = getQualityService();
    const [latestDrift, driftHistory] = await Promise.all([
      service.getLatestDrift(userId),
      service.getDriftHistory(userId),
    ]);

    const driftExplanation = latestDrift ? explainClusterDrift(latestDrift) : null;

    return sendSuccess(res, {
      latestDrift,
      driftHistory,
      driftExplanation,
    });
  } catch (err) {
    logger.error('[IntelligenceQualityController.getDriftHistory]', { userId, error: err.message });
    return next(err);
  }
}

/**
 * GET /api/v1/intelligence-quality/explainability
 *
 * Returns consolidated human-readable quality narratives across all dimensions.
 * Primary endpoint for dashboard quality panels.
 */
async function getExplainability(req, res, next) {
  const userId = resolveUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

  try {
    const service = getQualityService();
    const report  = await service.getQualityReport(userId);

    if (!report.coverage) {
      return sendSuccess(res, {
        available: false,
        message: 'Complete your assessment to unlock intelligence quality insights.',
      });
    }

    // Build explainability objects from persisted data
    const coverageExplanation    = explainSignalCoverage(report.coverage);
    const reliabilityExplanation = report.reliability?.length
      ? explainSignalReliability({ summary: _buildReliabilitySummary(report.reliability) })
      : null;
    const stabilityExplanations  = (report.stability ?? []).map(p => ({
      clusterId:   p.clusterId,
      clusterLabel: p.clusterLabel,
      explanation: explainClusterStability(p),
    }));
    const driftExplanation = report.drift ? explainClusterDrift(report.drift) : null;

    return sendSuccess(res, {
      available: true,
      coverage:    coverageExplanation,
      reliability: reliabilityExplanation,
      stability:   stabilityExplanations,
      drift:       driftExplanation,
    });
  } catch (err) {
    logger.error('[IntelligenceQualityController.getExplainability]', { userId, error: err.message });
    return next(err);
  }
}

// ─────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────

function _buildReliabilitySummary(reliabilityProfiles = []) {
  if (!reliabilityProfiles.length) {
    return { averageReliabilityScore: 0, overallReliabilityLevel: 'LOW', unreliableTraits: [] };
  }

  const scores   = reliabilityProfiles.map(p => p.reliabilityScore ?? 0);
  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

  const HIGH   = 80;
  const MEDIUM = 55;

  const level = avgScore >= HIGH ? 'HIGH' : avgScore >= MEDIUM ? 'MEDIUM' : 'LOW';

  const unreliableTraits = reliabilityProfiles
    .filter(p => p.reliabilityLevel === 'LOW')
    .map(p => ({ traitKey: p.traitKey, reliabilityScore: p.reliabilityScore }));

  return {
    averageReliabilityScore: parseFloat(avgScore.toFixed(2)),
    overallReliabilityLevel: level,
    highReliabilityCount:    reliabilityProfiles.filter(p => p.reliabilityLevel === 'HIGH').length,
    mediumReliabilityCount:  reliabilityProfiles.filter(p => p.reliabilityLevel === 'MEDIUM').length,
    lowReliabilityCount:     reliabilityProfiles.filter(p => p.reliabilityLevel === 'LOW').length,
    unreliableTraits,
  };
}

module.exports = Object.freeze({
  getQualityReport,
  getCoverageProfile,
  getStabilityProfiles,
  getDriftHistory,
  getExplainability,
});
