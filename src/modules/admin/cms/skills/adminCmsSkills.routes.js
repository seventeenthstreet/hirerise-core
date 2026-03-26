'use strict';

/**
 * adminCmsSkills.routes.js — Admin CMS Skills Endpoints
 *
 * Mounted in server.js as:
 *   app.use(
 *     `${API_PREFIX}/admin/cms/skills`,
 *     authenticate,
 *     requireAdmin,
 *     require('./modules/admin/cms/skills/adminCmsSkills.routes')
 *   );
 *
 * All routes inherit authenticate + requireAdmin from the mount point.
 * No admin identity is accepted from the request body at any layer.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ Method │ Path                          │ Description                 │
 * ├──────────────────────────────────────────────────────────────────────┤
 * │ POST   │ /admin/cms/skills             │ Create skill (dedup check)  │
 * │ PATCH  │ /admin/cms/skills/:skillId    │ Update skill                │
 * │ GET    │ /admin/cms/skills             │ List skills                 │
 * └──────────────────────────────────────────────────────────────────────┘
 */

const express = require('express');
const { body, param, query } = require('express-validator');
const { validate }           = require('../../../../middleware/requestValidator');
const ctrl                   = require('./adminCmsSkills.controller');

const router = express.Router();

// ── POST /admin/cms/skills ───────────────────────────────────────────────────
router.post(
  '/',
  validate([
    body('name')
      .isString().withMessage('name must be a string')
      .trim()
      .notEmpty().withMessage('name is required')
      .isLength({ min: 1, max: 150 }).withMessage('name must be 1-150 characters'),

    body('category')
      .optional()
      .isIn(['technical', 'soft', 'domain', 'tool', 'language', 'framework'])
      .withMessage('category must be: technical, soft, domain, tool, language, or framework'),

    body('aliases')
      .optional()
      .isArray({ max: 20 }).withMessage('aliases must be an array of max 20 items'),

    body('aliases.*')
      .optional()
      .isString().trim().isLength({ max: 100 }),

    body('description')
      .optional()
      .isString().trim().isLength({ max: 500 }),

    body('demandScore')
      .optional()
      .isInt({ min: 0, max: 100 }).withMessage('demandScore must be 0-100'),

    // SECURITY: Explicitly block identity injection attempts
    body('adminId').not().exists().withMessage('adminId must not be provided in the request body'),
    body('createdByAdminId').not().exists().withMessage('createdByAdminId must not be provided in the request body'),
    body('sourceAgency').not().exists().withMessage('sourceAgency must not be provided in the request body'),
  ]),
  ctrl.createSkill
);

// ── PATCH /admin/cms/skills/:skillId ────────────────────────────────────────
router.patch(
  '/:skillId',
  validate([
    param('skillId').isString().trim().notEmpty(),

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

    // SECURITY: Block identity injection on updates
    body('adminId').not().exists(),
    body('updatedByAdminId').not().exists(),
  ]),
  ctrl.updateSkill
);

// ── GET /admin/cms/skills ────────────────────────────────────────────────────
router.get(
  '/',
  validate([
    query('limit')
      .optional()
      .isInt({ min: 1, max: 500 }).withMessage('limit must be 1-500'),
    query('category')
      .optional()
      .isIn(['technical', 'soft', 'domain', 'tool', 'language', 'framework']),
  ]),
  ctrl.listSkills
);

module.exports = router;








