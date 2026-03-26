'use strict';

/**
 * adminCmsRoles.routes.js — Admin CMS Roles Endpoints
 *
 * Mounted in server.js as:
 *   app.use(`${API_PREFIX}/admin/cms/roles`, authenticate, requireAdmin,
 *           require('./modules/admin/cms/roles/adminCmsRoles.routes'));
 */

const express = require('express');
const { body, param, query } = require('express-validator');
const { validate }           = require('../../../../middleware/requestValidator');
const ctrl                   = require('./adminCmsRoles.controller');

const router = express.Router();

router.post(
  '/',
  validate([
    body('name').isString().trim().notEmpty().isLength({ min: 1, max: 150 }),
    body('jobFamilyId').isString().trim().notEmpty().isLength({ max: 100 }),
    body('level').optional().isString().trim(),
    body('track')
      .optional()
      .isIn(['individual_contributor', 'management', 'specialist']),
    body('description').optional().isString().trim().isLength({ max: 500 }),
    body('alternativeTitles').optional().isArray({ max: 20 }),
    // Block identity injection
    body('adminId').not().exists(),
    body('createdByAdminId').not().exists(),
    body('sourceAgency').not().exists(),
  ]),
  ctrl.createRole
);

router.patch(
  '/:roleId',
  validate([
    param('roleId').isString().trim().notEmpty(),
    body('name').optional().isString().trim().isLength({ min: 1, max: 150 }),
    body('jobFamilyId').optional().isString().trim().isLength({ max: 100 }),
    body('level').optional().isString().trim(),
    body('track').optional().isIn(['individual_contributor', 'management', 'specialist']),
    body('description').optional().isString().trim().isLength({ max: 500 }),
    body('alternativeTitles').optional().isArray({ max: 20 }),
    body('adminId').not().exists(),
    body('updatedByAdminId').not().exists(),
  ]),
  ctrl.updateRole
);

router.get(
  '/',
  validate([
    query('limit').optional().isInt({ min: 1, max: 500 }),
    query('jobFamilyId').optional().isString().trim(),
  ]),
  ctrl.listRoles
);

module.exports = router;








