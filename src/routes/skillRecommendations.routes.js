'use strict';

/**
 * skillRecommendations.routes.js
 *
 * Mounted in server.js:
 *   app.use(`${API_PREFIX}/skills`, authenticate, require('./routes/skillRecommendations.routes'));
 *
 * ┌────────────────────────────────────────────────────────────────────────────┐
 * │ Method │ Path                  │ Description                               │
 * ├────────────────────────────────────────────────────────────────────────────┤
 * │ GET    │ /recommendations      │ Get skill recs for authenticated user     │
 * │ POST   │ /add                  │ Add one or more skills to user profile    │
 * └────────────────────────────────────────────────────────────────────────────┘
 */

const express      = require('express');
const { body }     = require('express-validator');
const { validate } = require('../middleware/requestValidator');
const { asyncHandler } = require('../utils/helpers');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const { getSkillRecommendations, addSkillsToProfile } = require('../modules/skillDemand/skillRecommendations.service');
const logger = require('../utils/logger');

const router = express.Router();

// ── GET /api/v1/skills/recommendations ────────────────────────────────────────
/**
 * Returns personalised skill recommendations for the authenticated user.
 * Derives target role + current skills from CHI / userProfiles automatically.
 * No body required — uses req.user.uid from the authenticate middleware.
 *
 * Response:
 *  { success: true, data: {
 *      missingSkills:    string[],
 *      recommendedSkills: { name, demandScore, matchScoreImpact }[],
 *      matchScore:       number,
 *      matchScoreImpact: number,
 *      targetRole:       string | null,
 *      hasTargetRole:    boolean,
 *      explanation:      string,
 *  }}
 */
router.get(
  '/recommendations',
  asyncHandler(async (req, res) => {
    const userId = req.user?.uid;
    if (!userId) {
      throw new AppError('Unauthorized', 401, {}, ErrorCodes.UNAUTHORIZED);
    }

    logger.info('[SkillRecommendations] GET /recommendations', { userId });

    const data = await getSkillRecommendations(userId);

    return res.json({ success: true, data });
  }),
);

// ── POST /api/v1/skills/add ────────────────────────────────────────────────────
/**
 * Adds one or more skills to the authenticated user's profile.
 * Deduplicates — safe to call multiple times with the same skill names.
 *
 * Body: { skills: string[] }
 *
 * Response:
 *  { success: true, data: { added: number, skills: string[] } }
 */
router.post(
  '/add',
  validate([
    body('skills')
      .isArray({ min: 1, max: 50 })
      .withMessage('skills must be a non-empty array (max 50)'),
    body('skills.*')
      .isString().trim().notEmpty()
      .withMessage('Each skill must be a non-empty string')
      .isLength({ max: 100 })
      .withMessage('Each skill name must be under 100 characters'),
  ]),
  asyncHandler(async (req, res) => {
    const userId = req.user?.uid;
    if (!userId) {
      throw new AppError('Unauthorized', 401, {}, ErrorCodes.UNAUTHORIZED);
    }

    const { skills } = req.body;
    logger.info('[SkillRecommendations] POST /add', { userId, count: skills.length });

    const result = await addSkillsToProfile(userId, skills);

    return res.json({ success: true, data: result });
  }),
);

module.exports = router;








