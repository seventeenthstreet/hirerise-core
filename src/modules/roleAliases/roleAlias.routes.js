'use strict';

/**
 * roleAlias.routes.js — Role Alias Management Routes
 *
 * OBSERVABILITY UPGRADE: Writes to admin_logs on alias creation.
 *
 * Routes:
 *   POST /api/v1/admin/cms/role-aliases
 *   GET  /api/v1/admin/cms/role-aliases/:roleId
 *
 * @module modules/roleAliases/roleAlias.routes
 */

const express              = require('express');
const { body, param }      = require('express-validator');
const { validate }         = require('../../middleware/requestValidator');
const { asyncHandler }     = require('../../utils/helpers');
const roleAliasRepository  = require('./roleAlias.repository');
const { logAdminAction }   = require('../../utils/adminAuditLogger');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

const router = express.Router();

// POST — create a role alias
router.post(
  '/',
  validate([
    body('alias').isString().trim().notEmpty().withMessage('alias is required'),
    body('canonicalName').isString().trim().notEmpty().withMessage('canonicalName is required'),
    body('roleId').isString().trim().notEmpty().withMessage('roleId is required'),
  ]),
  asyncHandler(async (req, res) => {
    const adminId = req.user.uid;
    const created = await roleAliasRepository.createAlias(req.body, adminId);

    await logAdminAction({
      adminId,
      action:     'ROLE_ALIAS_CREATED',
      entityType: 'role_aliases',
      entityId:   created.id,
      metadata:   { alias: req.body.alias, canonicalName: req.body.canonicalName, roleId: req.body.roleId },
      ipAddress:  req.ip,
    });

    return res.status(201).json({ success: true, data: created });
  })
);

// GET — list aliases for a role
router.get(
  '/:roleId',
  validate([
    param('roleId').isString().trim().notEmpty().withMessage('roleId is required'),
  ]),
  asyncHandler(async (req, res) => {
    const aliases = await roleAliasRepository.findByRoleId(req.params.roleId);
    return res.status(200).json({ success: true, data: aliases, count: aliases.length });
  })
);

module.exports = router;








