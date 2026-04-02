'use strict';

/**
 * adminCmsRoles.routes.js — Optimized (Supabase-ready)
 */

const express = require('express');
const { body, param, query } = require('express-validator');
const { validate } = require('../../../../middleware/requestValidator');
const ctrl = require('./adminCmsRoles.controller');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// CONSTANTS (avoid repetition + safer validation)
// ─────────────────────────────────────────────────────────────

const TRACK_VALUES = ['individual_contributor', 'management', 'specialist'];
const MAX_LIMIT = 100; // 🔥 reduced from 500 for safety

// ─────────────────────────────────────────────────────────────
// CREATE ROLE
// ─────────────────────────────────────────────────────────────

router.post(
  '/',
  validate([
    body('name')
      .isString()
      .trim()
      .isLength({ min: 1, max: 150 }),

    body('jobFamilyId')
      .isString()
      .trim()
      .isLength({ min: 1, max: 100 }),

    body('level')
      .optional()
      .isString()
      .trim(),

    body('track')
      .optional()
      .isIn(TRACK_VALUES),

    body('description')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 500 }),

    body('alternativeTitles')
      .optional()
      .isArray({ max: 20 }),

    // 🔥 SECURITY: prevent privilege injection
    body('adminId').not().exists(),
    body('createdByAdminId').not().exists(),
    body('updatedByAdminId').not().exists(),
    body('sourceAgency').not().exists(),
    body('softDeleted').not().exists(),
    body('status').not().exists(),
  ]),
  ctrl.createRole
);

// ─────────────────────────────────────────────────────────────
// UPDATE ROLE
// ─────────────────────────────────────────────────────────────

router.patch(
  '/:roleId',
  validate([
    param('roleId')
      .isString()
      .trim()
      .notEmpty(),

    body('name')
      .optional()
      .isString()
      .trim()
      .isLength({ min: 1, max: 150 }),

    body('jobFamilyId')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 100 }),

    body('level')
      .optional()
      .isString()
      .trim(),

    body('track')
      .optional()
      .isIn(TRACK_VALUES),

    body('description')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 500 }),

    body('alternativeTitles')
      .optional()
      .isArray({ max: 20 }),

    // 🔥 SECURITY: prevent identity override
    body('adminId').not().exists(),
    body('createdByAdminId').not().exists(),
    body('updatedByAdminId').not().exists(),
    body('sourceAgency').not().exists(),
    body('softDeleted').not().exists(),
  ]),
  ctrl.updateRole
);

// ─────────────────────────────────────────────────────────────
// LIST ROLES
// ─────────────────────────────────────────────────────────────

router.get(
  '/',
  validate([
    query('limit')
      .optional()
      .isInt({ min: 1, max: MAX_LIMIT }),

    query('offset')
      .optional()
      .isInt({ min: 0 }),

    query('jobFamilyId')
      .optional()
      .isString()
      .trim(),

    query('status')
      .optional()
      .isString()
      .trim(),
  ]),
  ctrl.listRoles
);

module.exports = router;