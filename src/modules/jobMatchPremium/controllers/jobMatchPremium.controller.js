'use strict';

/**
 * src/modules/jobMatchPremium/controllers/jobMatchPremium.controller.js
 *
 * Controller Layer — Premium Match
 *
 * Responsibilities:
 * - Validate input
 * - Delegate to service
 * - Map response
 * - Handle errors
 *
 * NO business logic in this layer.
 */

const logger = require('../../../utils/logger');
const { AppError } = require('../../../middleware/errorHandler');
const { validateMatchRequest, validateLatestRequest } = require('../validators/jobMatchPremium.validator');
const { runPremiumMatch, getLatestMatch } = require('../services/jobMatchPremium.service');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/premium/match
// ─────────────────────────────────────────────────────────────────────────────

async function handleRunMatch(req, res, next) {
  try {
    validateMatchRequest(req.body);

    const userId    = req.user.id;
    const userTier  = req.user.tier ?? req.user.subscription_tier ?? 'premium';
    const { resumeId } = req.body;

    logger.info('[JobMatchPremiumController] POST /premium/match', {
      userId,
      resumeId,
    });

    const result = await runPremiumMatch({ userId, resumeId, userTier });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/premium/match/:resumeId/latest
// ─────────────────────────────────────────────────────────────────────────────

async function handleGetLatest(req, res, next) {
  try {
    validateLatestRequest(req.params);

    const userId   = req.user.id;
    const { resumeId } = req.params;

    logger.debug('[JobMatchPremiumController] GET /premium/match/:resumeId/latest', {
      userId,
      resumeId,
    });

    const result = await getLatestMatch({ userId, resumeId });

    if (!result) {
      return res.status(404).json({
        success: false,
        error: {
          code:    'NOT_FOUND',
          message: 'No premium match analysis found for this resume.',
          details: { resumeId },
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { handleRunMatch, handleGetLatest };
