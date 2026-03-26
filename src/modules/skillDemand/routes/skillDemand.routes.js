'use strict';

/**
 * skillDemand.routes.js — Skill Demand Intelligence API Routes
 *
 * All routes prefixed with /api/v1/skills by server.js:
 *   app.use(`${API_PREFIX}/skills`, authenticate, skillDemandRouter);
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ Method │ Path                          │ Description                     │
 * ├──────────────────────────────────────────────────────────────────────────┤
 * │ POST   │ /analyze                      │ Full skill demand analysis       │
 * │ GET    │ /demand/top                   │ Top demand skills by industry    │
 * │ GET    │ /demand/role/:role            │ Required skills for a role       │
 * │ GET    │ /demand/history               │ User's analysis history          │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * @module modules/skillDemand/routes/skillDemand.routes
 */

const express             = require('express');
const { body, query, param } = require('express-validator');
const { validate }        = require('../../../middleware/requestValidator');
const { asyncHandler }    = require('../../../utils/helpers');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');
const { SkillDemandService }   = require('../service/skillDemand.service');

const router  = express.Router();
const service = new SkillDemandService();

// ── POST /analyze ─────────────────────────────────────────────────────────────
/**
 * Full skill demand analysis.
 * Compares user skills against role requirements and returns gap analysis.
 *
 * Body: { role: string, skills: string[] }
 */
router.post(
  '/analyze',
  validate([
    body('role')
      .isString().trim().notEmpty().withMessage('role is required')
      .isLength({ max: 200 }).withMessage('role must be under 200 characters'),
    body('skills')
      .isArray({ max: 200 }).withMessage('skills must be an array (max 200 items)'),
    body('skills.*')
      .optional()
      .custom(v => typeof v === 'string' || (typeof v === 'object' && v !== null && v.name))
      .withMessage('Each skill must be a string or { name: string }'),
  ]),
  asyncHandler(async (req, res) => {
    const { role, skills = [] } = req.body;
    const userId = req.user?.uid || req.user?.id;

    const result = await service.analyzeSkillDemand({ role, skills, userId });

    res.status(200).json({ success: true, data: result });
  })
);

// ── GET /demand/top ───────────────────────────────────────────────────────────
/**
 * Return top-demand skills, optionally filtered by industry.
 *
 * Query: { industry?: string, limit?: number }
 */
router.get(
  '/demand/top',
  validate([
    query('industry').optional().isString().trim().isLength({ max: 100 }),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ]),
  asyncHandler(async (req, res) => {
    const { industry, limit } = req.query;

    const skills = await service.getTopDemandSkills({
      industry: industry || undefined,
      limit:    limit    || 20,
    });

    res.status(200).json({ success: true, data: { skills, count: skills.length } });
  })
);

// ── GET /demand/role/:role ────────────────────────────────────────────────────
/**
 * Return required skills for a specific role.
 */
router.get(
  '/demand/role/:role',
  validate([
    param('role').isString().trim().notEmpty().isLength({ max: 200 }),
  ]),
  asyncHandler(async (req, res) => {
    const { role } = req.params;

    const skills = await service.getRequiredSkillsForRole(role);

    if (!skills || skills.length === 0) {
      throw new AppError(
        `No skill data found for role: ${role}`,
        404,
        { role },
        ErrorCodes.NOT_FOUND
      );
    }

    res.status(200).json({ success: true, data: { role, skills, count: skills.length } });
  })
);

// ── GET /demand/history ───────────────────────────────────────────────────────
/**
 * Return the authenticated user's skill demand analysis history.
 */
router.get(
  '/demand/history',
  asyncHandler(async (req, res) => {
    const userId = req.user?.uid || req.user?.id;

    if (!userId) {
      throw new AppError('Authentication required', 401, {}, ErrorCodes.UNAUTHORIZED);
    }

    const history = await service.getUserAnalysisHistory(userId);

    res.status(200).json({ success: true, data: { history, count: history.length } });
  })
);

module.exports = router;









