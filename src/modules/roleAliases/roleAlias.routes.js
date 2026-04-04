'use strict';

/**
 * src/modules/roleAliases/roleAlias.routes.js
 *
 * Role Alias Management Routes
 *
 * Production hardened for Supabase-native repository layer.
 * Includes:
 * - strict validation
 * - duplicate alias conflict safety
 * - resilient audit logging
 * - auth null safety
 * - consistent API responses
 */

const express = require('express');
const { body, param } = require('express-validator');

const { validate } = require('../../middleware/requestValidator');
const { asyncHandler } = require('../../utils/helpers');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

const roleAliasRepository = require('./roleAlias.repository');
const { logAdminAction } = require('../../utils/adminAuditLogger');

const router = express.Router();

/**
 * POST /
 * Create a role alias
 */
router.post(
  '/',
  validate([
    body('alias')
      .isString()
      .trim()
      .notEmpty()
      .withMessage('alias is required'),

    body('canonicalName')
      .isString()
      .trim()
      .notEmpty()
      .withMessage('canonicalName is required'),

    body('roleId')
      .isString()
      .trim()
      .notEmpty()
      .withMessage('roleId is required')
  ]),
  asyncHandler(async (req, res) => {
    const adminId = req.user?.uid || req.user?.id || null;

    if (!adminId) {
      throw new AppError(
        'Unauthorized admin context',
        401,
        ErrorCodes.UNAUTHORIZED
      );
    }

    let created;

    try {
      created = await roleAliasRepository.createAlias(req.body, adminId);
    } catch (error) {
      /**
       * PostgreSQL unique violation
       * Protected by partial unique index:
       * uq_role_aliases_normalized_active
       */
      if (error.code === '23505') {
        throw new AppError(
          'Alias already exists for an active role',
          409,
          ErrorCodes.CONFLICT
        );
      }

      throw error;
    }

    /**
     * Audit logging should never block primary write success.
     * Log failures are swallowed intentionally.
     */
    try {
      await logAdminAction({
        adminId,
        action: 'ROLE_ALIAS_CREATED',
        entityType: 'role_aliases',
        entityId: created.id,
        metadata: {
          alias: req.body.alias,
          canonicalName: req.body.canonicalName,
          roleId: req.body.roleId
        },
        ipAddress: req.ip
      });
    } catch (auditError) {
      console.error('Admin audit log failed:', {
        route: 'POST /role-aliases',
        error: auditError.message
      });
    }

    return res.status(201).json({
      success: true,
      data: created
    });
  })
);

/**
 * GET /:roleId
 * List aliases for a role
 */
router.get(
  '/:roleId',
  validate([
    param('roleId')
      .isString()
      .trim()
      .notEmpty()
      .withMessage('roleId is required')
  ]),
  asyncHandler(async (req, res) => {
    const aliases = await roleAliasRepository.findByRoleId(req.params.roleId);

    return res.status(200).json({
      success: true,
      data: aliases,
      count: aliases.length
    });
  })
);

module.exports = router;