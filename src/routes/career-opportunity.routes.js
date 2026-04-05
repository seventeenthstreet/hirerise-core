'use strict';

/**
 * routes/career-opportunity.routes.js
 * Career Opportunity API Routes
 *
 * Mounted at:
 * /api/v1/career-opportunities
 */

const express = require('express');
const { body, query } = require('express-validator');

const { validate } = require('../middleware/requestValidator');
const { asyncHandler } = require('../utils/helpers');
const { analyzeCareerOpportunities } = require('../engines/career-opportunity.engine');
const opportunityRadarEngine = require('../engines/opportunityRadar.engine');
const logger = require('../utils/logger');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const MAX_ROLE_LENGTH = 200;
const MAX_SKILLS = 100;
const MAX_SKILL_LENGTH = 150;
const MAX_INDUSTRY_LENGTH = 100;
const MAX_COUNTRY_LENGTH = 100;
const MAX_EXPERIENCE = 60;
const DEFAULT_TOP_N = 5;
const DEFAULT_SCORE_LIMIT = 10;
const DEFAULT_MIN_OPPORTUNITY_SCORE = 30;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function resolveUserId(req) {
  return (
    req?.user?.id ||
    req?.user?.uid ||
    req?.auth?.userId ||
    req?.user?.user_id ||
    null
  );
}

function calculateOpportunityRank(opp) {
  const opportunityScore = opp?.opportunity_score ?? 50;
  const matchScore = opp?.match_score ?? 50;

  return {
    role: opp?.role ?? null,
    opportunity_score: opportunityScore,
    match_score: matchScore,
    rank: Number(
      (opportunityScore * 0.6 + matchScore * 0.4).toFixed(1)
    ),
    growth_trend: opp?.growth_trend ?? null,
    skills_you_have: opp?.skills_you_have ?? [],
  };
}

// ─────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────
const analyzeValidation = [
  body('role')
    .isString()
    .trim()
    .notEmpty()
    .isLength({ max: MAX_ROLE_LENGTH })
    .withMessage(`role must not exceed ${MAX_ROLE_LENGTH} characters`),

  body('skills')
    .optional()
    .isArray({ max: MAX_SKILLS })
    .withMessage(`skills must contain max ${MAX_SKILLS} items`),

  body('skills.*')
    .optional()
    .isString()
    .trim()
    .notEmpty()
    .isLength({ max: MAX_SKILL_LENGTH })
    .withMessage(
      `Each skill must not exceed ${MAX_SKILL_LENGTH} characters`
    ),

  body('experience_years')
    .optional({ nullable: true })
    .isFloat({ min: 0, max: MAX_EXPERIENCE })
    .toFloat()
    .withMessage(
      `experience_years must be between 0 and ${MAX_EXPERIENCE}`
    ),

  body('industry')
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: MAX_INDUSTRY_LENGTH })
    .withMessage(
      `industry must not exceed ${MAX_INDUSTRY_LENGTH} characters`
    ),

  body('country')
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: MAX_COUNTRY_LENGTH })
    .withMessage(
      `country must not exceed ${MAX_COUNTRY_LENGTH} characters`
    ),

  body('top_n')
    .optional({ nullable: true })
    .isInt({ min: 1, max: 20 })
    .toInt()
    .withMessage('top_n must be between 1 and 20'),
];

// ─────────────────────────────────────────────────────────────
// POST /analyze
// ─────────────────────────────────────────────────────────────
router.post(
  '/analyze',
  validate(analyzeValidation),
  asyncHandler(async (req, res) => {
    const userId = resolveUserId(req);

    const {
      role,
      skills = [],
      experience_years = 0,
      industry = null,
      country = null,
      top_n = DEFAULT_TOP_N,
    } = req.body;

    logger.info('[CareerOpportunityRoutes] Analyze request', {
      userId,
      role,
      experience_years,
      skill_count: skills.length,
    });

    const result = await analyzeCareerOpportunities({
      role,
      skills,
      experience_years,
      industry,
      country,
      top_n,
    });

    if (!result?.opportunities?.length) {
      return res.status(200).json({
        success: true,
        data: result,
        message: `No career transitions found for role: "${role}". Check that the role exists in the dataset.`,
      });
    }

    return res.status(200).json({
      success: true,
      data: result,
    });
  })
);

// ─────────────────────────────────────────────────────────────
// GET /score
// ─────────────────────────────────────────────────────────────
router.get(
  '/score',
  validate([
    query('minOpportunityScore')
      .optional()
      .isInt({ min: 0, max: 100 })
      .toInt()
      .withMessage('minOpportunityScore must be 0–100'),

    query('limit')
      .optional()
      .isInt({ min: 1, max: 30 })
      .toInt()
      .withMessage('limit must be 1–30'),
  ]),
  asyncHandler(async (req, res) => {
    const userId = resolveUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required.',
        },
      });
    }

    const minOpportunityScore =
      req.query.minOpportunityScore ?? DEFAULT_MIN_OPPORTUNITY_SCORE;

    const limit = req.query.limit ?? DEFAULT_SCORE_LIMIT;

    logger.info('[CareerOpportunityRoutes] Score request', {
      userId,
      minOpportunityScore,
      limit,
    });

    const radarResult =
      await opportunityRadarEngine.getOpportunityRadar(userId, {
        topN: Number(limit),
        minOpportunityScore: Number(minOpportunityScore),
        minMatchScore: 0,
      });

    const opportunities =
      radarResult?.emerging_opportunities ?? [];

    if (!opportunities.length) {
      return res.status(200).json({
        success: true,
        data: {
          opportunity_score: null,
          level: null,
          signals_evaluated:
            radarResult?.total_signals_evaluated ?? 0,
          top_opportunity: null,
          breakdown: [],
          message:
            'No opportunity signals available yet. Complete your profile or check back after market data refreshes.',
        },
      });
    }

    const ranked = opportunities
      .map(calculateOpportunityRank)
      .sort((a, b) => b.rank - a.rank);

    const topFive = ranked.slice(0, 5);

    let weightSum = 0;
    let scoreSum = 0;

    topFive.forEach((opp, index) => {
      const weight = 1 / (index + 1);
      scoreSum += opp.rank * weight;
      weightSum += weight;
    });

    const rawScore = weightSum > 0 ? scoreSum / weightSum : 0;
    const portfolioScore = Math.round(
      Math.min(99, Math.max(1, rawScore))
    );

    const level =
      portfolioScore >= 70
        ? 'high'
        : portfolioScore >= 40
          ? 'moderate'
          : 'low';

    logger.info('[CareerOpportunityRoutes] Score computed', {
      userId,
      portfolioScore,
      level,
      signals: opportunities.length,
    });

    return res.status(200).json({
      success: true,
      data: {
        opportunity_score: portfolioScore,
        level,
        signals_evaluated:
          radarResult?.total_signals_evaluated ??
          opportunities.length,
        top_opportunity: ranked[0]?.role ?? null,
        breakdown: ranked.slice(0, 3),
      },
    });
  })
);

module.exports = router;