/**
 * skills.routes.js — Skill Gap Engine Routes (Enterprise Hardened)
 *
 * All routes prefixed with /api/v1/skills by server.js mount:
 *   app.use(`${API_PREFIX}/skills`, authenticate, require('./routes/skills.routes'));
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ Method │ Path                        │ Auth             │ Description    │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ GET    │ /api/v1/skills              │ authenticate     │ List skills    │
 * │ POST   │ /api/v1/skills              │ + requireAdmin   │ Create skill   │
 * │ GET    │ /api/v1/skills/:id          │ authenticate     │ Get by id      │
 * │ PUT    │ /api/v1/skills/:id          │ + requireAdmin   │ Update skill   │
 * │ DELETE │ /api/v1/skills/:id          │ + requireAdmin   │ Delete skill   │
 * │ POST   │ /api/v1/skills/gap-analysis │ authenticate     │ Gap analysis   │
 * │ POST   │ /api/v1/skills/bulk-gap     │ authenticate     │ Bulk gap       │
 * │ GET    │ /api/v1/skills/role/:roleId │ authenticate     │ Skills by role │
 * │ GET    │ /api/v1/skills/search       │ authenticate     │ Search skills  │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ROOT CAUSE FIX:
 *   "Endpoint not found: GET /api/v1/skills" occurred because the five CRUD
 *   routes (GET /, POST /, GET /:id, PUT /:id, DELETE /:id) were entirely
 *   absent. Requests fell through to notFoundHandler in errorHandler.js.
 *
 *   Also added corresponding controller handlers and service methods below.
 *
 * ROUTE ORDER NOTE:
 *   Static paths (/search, /gap-analysis, /bulk-gap, /role/:roleId) are
 *   declared BEFORE /:id so Express does not treat "search" as an :id value.
 */

'use strict';

const express = require('express');
const { body, param, query } = require('express-validator');
const { validate }           = require('../middleware/requestValidator');
const { requireAdmin }       = require('../middleware/auth.middleware');
const skillsController       = require('../controllers/skills.controller');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// GET /api/v1/skills
// FIX: Was MISSING — caused the reported "Endpoint not found" 404.
// ─────────────────────────────────────────────────────────────
router.get(
  '/',
  validate([
    query('limit')
      .optional()
      .isInt({ min: 1, max: 500 })
      .withMessage('limit must be an integer between 1 and 500'),

    query('category')
      .optional()
      .isIn(['technical', 'soft', 'domain', 'tool', 'language', 'framework'])
      .withMessage('category must be: technical, soft, domain, tool, language, or framework'),
  ]),
  skillsController.listSkills
);

// ─────────────────────────────────────────────────────────────
// POST /api/v1/skills  (Admin only)
// FIX: Was MISSING.
// ─────────────────────────────────────────────────────────────
router.post(
  '/',
  requireAdmin,
  validate([
    body('name')
      .isString().trim().notEmpty()
      .isLength({ min: 1, max: 150 })
      .withMessage('name is required and must be 1-150 characters'),

    body('category')
      .optional()
      .isIn(['technical', 'soft', 'domain', 'tool', 'language', 'framework'])
      .withMessage('category must be: technical, soft, domain, tool, language, or framework'),

    body('aliases')
      .optional()
      .isArray({ max: 20 })
      .withMessage('aliases must be an array of max 20 items'),

    body('aliases.*')
      .optional()
      .isString().trim().isLength({ max: 100 }),

    body('description')
      .optional()
      .isString().trim().isLength({ max: 500 }),

    body('demandScore')
      .optional()
      .isInt({ min: 0, max: 100 })
      .withMessage('demandScore must be 0-100'),
  ]),
  skillsController.createSkill
);

// ─────────────────────────────────────────────────────────────
// POST /api/v1/skills/gap-analysis
// Static path declared before /:id to avoid route collision.
// ─────────────────────────────────────────────────────────────
router.post(
  '/gap-analysis',
  validate([
    body('targetRoleId')
      .isString().trim().notEmpty()
      .isLength({ max: 100 })
      .withMessage('targetRoleId is required'),

    body('userSkills')
      .isArray({ min: 0, max: 200 })
      .withMessage('userSkills must be an array (max 200 skills)'),

    body('userSkills.*.name')
      .isString().trim().notEmpty()
      .withMessage('Each skill must have a non-empty name'),

    body('userSkills.*.proficiencyLevel')
      .optional()
      .isIn(['beginner', 'intermediate', 'advanced', 'expert'])
      .withMessage('proficiencyLevel must be: beginner, intermediate, advanced, or expert'),

    body('userSkills.*.yearsOfExperience')
      .optional()
      .isFloat({ min: 0, max: 50 }).toFloat()
      .withMessage('yearsOfExperience must be between 0 and 50'),

    body('includeRecommendations')
      .optional()
      .isBoolean().toBoolean()
      .withMessage('includeRecommendations must be a boolean'),
  ]),
  skillsController.analyzeGap
);

// ─────────────────────────────────────────────────────────────
// POST /api/v1/skills/bulk-gap
// ─────────────────────────────────────────────────────────────
router.post(
  '/bulk-gap',
  validate([
    body('targetRoleIds')
      .isArray({ min: 1, max: 10 })
      .withMessage('targetRoleIds must be an array of 1-10 role IDs'),

    body('targetRoleIds.*')
      .isString().trim().notEmpty()
      .isLength({ max: 100 })
      .withMessage('Each targetRoleId must be a non-empty string'),

    body('userSkills')
      .isArray({ min: 0, max: 200 })
      .withMessage('userSkills must be an array (max 200 skills)'),

    body('userSkills.*.name')
      .isString().trim().notEmpty()
      .withMessage('Each skill must have a non-empty name'),
  ]),
  skillsController.bulkGapAnalysis
);

// ─────────────────────────────────────────────────────────────
// GET /api/v1/skills/search
// ─────────────────────────────────────────────────────────────
router.get(
  '/search',
  validate([
    query('q')
      .isString().trim()
      .isLength({ min: 2, max: 50 })
      .withMessage('Query must be between 2 and 50 characters'),

    query('category')
      .optional()
      .isIn(['technical', 'soft', 'domain', 'tool', 'language', 'framework'])
      .withMessage('Invalid skill category'),
  ]),
  skillsController.searchSkills
);

// ─────────────────────────────────────────────────────────────
// GET /api/v1/skills/role/:roleId
// ─────────────────────────────────────────────────────────────
router.get(
  '/role/:roleId',
  validate([
    param('roleId')
      .isString().trim().notEmpty()
      .isLength({ max: 100 })
      .withMessage('roleId is required'),
  ]),
  skillsController.getRoleSkills
);

// ─────────────────────────────────────────────────────────────
// GET /api/v1/skills/recommendations
// Must be declared BEFORE /:id to prevent Express treating
// "recommendations" as an :id parameter value.
// ─────────────────────────────────────────────────────────────
router.get(
  '/recommendations',
  require('../utils/helpers').asyncHandler(async (req, res) => {
    const userId = req.user?.uid;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const { getSkillRecommendations } = require('../modules/skillDemand/skillRecommendations.service');
    const data = await getSkillRecommendations(userId);
    return res.json({ success: true, data });
  })
);

// ─────────────────────────────────────────────────────────────
// POST /api/v1/skills/add
// Must be declared BEFORE /:id for the same reason.
// ─────────────────────────────────────────────────────────────
router.post(
  '/add',
  require('../middleware/requestValidator').validate([
    require('express-validator').body('skills')
      .isArray({ min: 1, max: 50 }).withMessage('skills must be a non-empty array (max 50)'),
    require('express-validator').body('skills.*')
      .isString().trim().notEmpty().isLength({ max: 100 })
      .withMessage('Each skill must be a non-empty string under 100 chars'),
  ]),
  require('../utils/helpers').asyncHandler(async (req, res) => {
    const userId = req.user?.uid;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const { addSkillsToProfile } = require('../modules/skillDemand/skillRecommendations.service');
    const result = await addSkillsToProfile(userId, req.body.skills);
    return res.json({ success: true, data: result });
  })
);


// ─────────────────────────────────────────────────────────────
// POST /api/v1/skills/remove
// Removes one or more skills from the current user's profile.
// Must be declared BEFORE /:id so Express does not treat "remove" as an id.
// ─────────────────────────────────────────────────────────────
router.post(
  '/remove',
  require('../middleware/requestValidator').validate([
    require('express-validator').body('skills')
      .isArray({ min: 1, max: 50 }).withMessage('skills must be a non-empty array (max 50)'),
    require('express-validator').body('skills.*')
      .isString().trim().notEmpty().isLength({ max: 100 })
      .withMessage('Each skill must be a non-empty string under 100 chars'),
  ]),
  require('../utils/helpers').asyncHandler(async (req, res) => {
    const userId = req.user?.uid;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { db } = require('../config/supabase');
    const toRemove = new Set(req.body.skills.map(s => String(s).trim().toLowerCase()));

    const userSnap = await db.collection('users').doc(userId).get();
    const existing = (userSnap.exists ? userSnap.data()?.skills ?? [] : []);

    // Filter from both string-format (users collection) and object-format
    const updatedFlat = existing.filter(s => {
      const name = (typeof s === 'string' ? s : s?.name ?? '').toLowerCase();
      return !toRemove.has(name);
    });

    const profileSnap  = await db.collection('userProfiles').doc(userId).get();
    const profileSkills = (profileSnap.exists ? profileSnap.data()?.skills ?? [] : []);
    const updatedProfile = profileSkills.filter(s => {
      const name = (typeof s === 'string' ? s : s?.name ?? '').toLowerCase();
      return !toRemove.has(name);
    });

    const batch = db.batch();
    const now   = new Date();
    batch.set(db.collection('users').doc(userId),        { skills: updatedFlat,    updatedAt: now }, { merge: true });
    batch.set(db.collection('userProfiles').doc(userId), { skills: updatedProfile, updatedAt: now }, { merge: true });
    await batch.commit();

    return res.json({ success: true, data: { removed: toRemove.size, skills: updatedFlat } });
  })
);

// ─────────────────────────────────────────────────────────────
// GET /api/v1/skills/:id
// FIX: Was MISSING.
// ─────────────────────────────────────────────────────────────
router.get(
  '/:id',
  validate([
    param('id')
      .isString().trim().notEmpty()
      .isLength({ max: 128 })
      .withMessage('id is required'),
  ]),
  skillsController.getSkillById
);

// ─────────────────────────────────────────────────────────────
// PUT /api/v1/skills/:id  (Admin only)
// FIX: Was MISSING.
// ─────────────────────────────────────────────────────────────
router.put(
  '/:id',
  requireAdmin,
  validate([
    param('id')
      .isString().trim().notEmpty()
      .isLength({ max: 128 })
      .withMessage('id is required'),

    body('name')
      .optional()
      .isString().trim().isLength({ min: 1, max: 150 }),

    body('category')
      .optional()
      .isIn(['technical', 'soft', 'domain', 'tool', 'language', 'framework']),

    body('aliases')
      .optional()
      .isArray({ max: 20 }),

    body('description')
      .optional()
      .isString().trim().isLength({ max: 500 }),

    body('demandScore')
      .optional()
      .isInt({ min: 0, max: 100 }),
  ]),
  skillsController.updateSkill
);

// ─────────────────────────────────────────────────────────────
// DELETE /api/v1/skills/:id  (Admin only — soft delete)
// FIX: Was MISSING.
// ─────────────────────────────────────────────────────────────
router.delete(
  '/:id',
  requireAdmin,
  validate([
    param('id')
      .isString().trim().notEmpty()
      .isLength({ max: 128 })
      .withMessage('id is required'),
  ]),
  skillsController.deleteSkill
);

module.exports = router;








