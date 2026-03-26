'use strict';

/**
 * career-opportunity.routes.js — Career Opportunity API Routes
 *
 * Mounted in server.js:
 *   app.use(`${API_PREFIX}/career-opportunities`, authenticate, require('./routes/career-opportunity.routes'));
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ Method │ Path                          │ Description                        │
 * ├─────────────────────────────────────────────────────────────────────────────┤
 * │ POST   │ /analyze                      │ Analyze career opportunities        │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * Request body:
 *   {
 *     "role":             "Junior Accountant",   // required
 *     "skills":           ["Excel", "Tally"],    // optional
 *     "experience_years": 2,                     // optional
 *     "industry":         "Finance",             // optional
 *     "country":          "India",               // optional — market data filter
 *     "top_n":            5                      // optional — max results (default 5)
 *   }
 *
 * Response:
 *   {
 *     "success": true,
 *     "data": {
 *       "opportunities": [
 *         { "role": "Senior Accountant", "match_score": 84, ... }
 *       ],
 *       "insights": [...],
 *       "meta": { ... }
 *     }
 *   }
 *
 * @module routes/career-opportunity.routes
 */

const express             = require('express');
const { body, query }     = require('express-validator');
const { validate }        = require('../middleware/requestValidator');
const { asyncHandler }    = require('../utils/helpers');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const { analyzeCareerOpportunities } = require('../engines/career-opportunity.engine');
const opportunityRadarEngine = require('../engines/opportunityRadar.engine');
const logger = require('../utils/logger');

const router = express.Router();

// ─── Validation ───────────────────────────────────────────────────────────────

const analyzeValidation = [
  body('role')
    .isString().trim().notEmpty()
    .withMessage('role is required and must be a non-empty string')
    .isLength({ max: 200 })
    .withMessage('role must not exceed 200 characters'),

  body('skills')
    .optional()
    .isArray({ max: 100 })
    .withMessage('skills must be an array with at most 100 items'),

  body('skills.*')
    .optional()
    .isString().trim().notEmpty()
    .withMessage('Each skill must be a non-empty string')
    .isLength({ max: 150 })
    .withMessage('Each skill must not exceed 150 characters'),

  body('experience_years')
    .optional({ nullable: true })
    .isFloat({ min: 0, max: 60 })
    .withMessage('experience_years must be between 0 and 60')
    .toFloat(),

  body('industry')
    .optional({ nullable: true })
    .isString().trim()
    .isLength({ max: 100 })
    .withMessage('industry must not exceed 100 characters'),

  body('country')
    .optional({ nullable: true })
    .isString().trim()
    .isLength({ max: 100 })
    .withMessage('country must not exceed 100 characters'),

  body('top_n')
    .optional({ nullable: true })
    .isInt({ min: 1, max: 20 })
    .withMessage('top_n must be between 1 and 20')
    .toInt(),
];

// ─── POST /analyze ────────────────────────────────────────────────────────────

/**
 * POST /api/v1/career-opportunities/analyze
 *
 * Analyze career opportunities for a given user profile.
 * Returns ranked opportunities with match scores and optional market signals.
 */
router.post(
  '/analyze',
  validate(analyzeValidation),
  asyncHandler(async (req, res) => {
    const {
      role,
      skills           = [],
      experience_years = 0,
      industry         = null,
      country          = null,
      top_n            = 5,
    } = req.body;

    logger.info('[CareerOpportunityRoutes] Analyze request', {
      user_id: req.user?.uid,
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

    if (!result.opportunities || result.opportunities.length === 0) {
      // Not an error — just no data for this role yet
      return res.status(200).json({
        success: true,
        data:    result,
        message: `No career transitions found for role: "${role}". Check that the role exists in the dataset.`,
      });
    }

    return res.status(200).json({
      success: true,
      data:    result,
    });
  })
);

// ─── GET /score ───────────────────────────────────────────────────────────────

/**
 * GET /api/v1/career-opportunities/score
 *
 * Returns a single aggregate "Portfolio Opportunity Score" (0–100) for the
 * authenticated user — a real, composite number derived from their personalised
 * opportunity radar data rather than a proxy skill-demand value.
 *
 * Algorithm:
 *   1. Pull the user's personalised radar from getOpportunityRadar() (cached
 *      30 min — no extra compute on repeat calls).
 *   2. For each emerging opportunity, compute a combined rank:
 *        rank_i = opportunity_score_i × 0.60 + match_score_i × 0.40
 *   3. Take the top-5 results and compute a weighted portfolio score:
 *        portfolio_score = Σ(rank_i × weight_i) / Σ(weight_i)
 *      where weight_i = 1 / (i + 1)  (position-decayed — best match matters most)
 *   4. Clamp result to [1, 99] so the gauge always shows something meaningful.
 *
 * Query params:
 *   minOpportunityScore — integer, default 30  (lower = more lenient matching)
 *   limit               — integer, default 10  (signals to evaluate)
 *
 * Response:
 *   {
 *     "success": true,
 *     "data": {
 *       "opportunity_score": 74,          // 0-100 composite
 *       "level":             "high",      // "low" | "moderate" | "high"
 *       "signals_evaluated": 8,
 *       "top_opportunity":   "Data Analyst",
 *       "breakdown": [                    // top-3 signals driving the score
 *         { "role": "Data Analyst", "opportunity_score": 82, "match_score": 71, "rank": 77.6 },
 *         ...
 *       ]
 *     }
 *   }
 */
router.get(
  '/score',
  validate([
    query('minOpportunityScore')
      .optional()
      .isInt({ min: 0, max: 100 })
      .toInt()
      .withMessage('minOpportunityScore must be an integer 0–100'),

    query('limit')
      .optional()
      .isInt({ min: 1, max: 30 })
      .toInt()
      .withMessage('limit must be an integer 1–30'),
  ]),
  asyncHandler(async (req, res) => {
    const userId = req.user?.uid || req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthenticated' });
    }

    const minOpportunityScore = req.query.minOpportunityScore ?? 30;
    const limit               = req.query.limit               ?? 10;

    logger.info('[CareerOpportunityRoutes] Score request', { userId });

    // Pull personalised radar — already cached 30 min in Redis
    const radarResult = await opportunityRadarEngine.getOpportunityRadar(userId, {
      topN:               Number(limit),
      minOpportunityScore: Number(minOpportunityScore),
      minMatchScore:       0,
    });

    const opportunities = radarResult?.emerging_opportunities ?? [];

    // No signals yet (Supabase not seeded, or new user with no profile)
    if (opportunities.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          opportunity_score:   null,
          level:               null,
          signals_evaluated:   radarResult?.total_signals_evaluated ?? 0,
          top_opportunity:     null,
          breakdown:           [],
          message:             'No opportunity signals available yet. Complete your profile or check back after market data refreshes.',
        },
      });
    }

    // Compute per-opportunity combined rank
    const ranked = opportunities
      .map(opp => ({
        role:              opp.role,
        opportunity_score: opp.opportunity_score ?? 50,
        match_score:       opp.match_score       ?? 50,
        rank:              parseFloat(
          ((opp.opportunity_score ?? 50) * 0.60 + (opp.match_score ?? 50) * 0.40).toFixed(1)
        ),
        growth_trend:      opp.growth_trend      ?? null,
        skills_you_have:   opp.skills_you_have   ?? [],
      }))
      .sort((a, b) => b.rank - a.rank);

    // Weighted portfolio score — top 5 with position-decay weights [1, 0.5, 0.33, 0.25, 0.2]
    const topFive    = ranked.slice(0, 5);
    let   weightSum  = 0;
    let   scoreSum   = 0;

    topFive.forEach((opp, i) => {
      const w  = 1 / (i + 1);
      scoreSum  += opp.rank * w;
      weightSum += w;
    });

    const rawScore        = weightSum > 0 ? scoreSum / weightSum : 0;
    const portfolioScore  = Math.round(Math.min(99, Math.max(1, rawScore)));

    const level =
      portfolioScore >= 70 ? 'high'     :
      portfolioScore >= 40 ? 'moderate' :
                             'low';

    logger.info('[CareerOpportunityRoutes] Score computed', {
      userId,
      portfolioScore,
      level,
      signals: opportunities.length,
    });

    return res.status(200).json({
      success: true,
      data: {
        opportunity_score:   portfolioScore,
        level,
        signals_evaluated:   radarResult?.total_signals_evaluated ?? opportunities.length,
        top_opportunity:     ranked[0]?.role ?? null,
        breakdown:           ranked.slice(0, 3),
      },
    });
  })
);

module.exports = router;








