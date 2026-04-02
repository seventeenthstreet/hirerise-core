'use strict';

/**
 * adminCmsImport.routes.js (Supabase - Production Hardened)
 */

const express = require('express');
const { body } = require('express-validator');

const { validate } = require('../../../../middleware/requestValidator');
const { asyncHandler } = require('../../../../utils/helpers');
const importService = require('./adminCmsImport.service');

const router = express.Router();

// ───────────────────────────────────────────
// 🔹 CONFIG
// ───────────────────────────────────────────

const ALLOWED_DATASETS = Object.freeze([
  'skills',
  'roles',
  'jobFamilies',
  'educationLevels',
]);

// ───────────────────────────────────────────
// 🔹 POST /import
// ───────────────────────────────────────────

router.post(
  '/',
  validate([
    body('datasetType')
      .isString()
      .isIn(ALLOWED_DATASETS)
      .withMessage(`datasetType must be one of: ${ALLOWED_DATASETS.join(', ')}`),

    body('rows')
      .isArray({ min: 1, max: 1000 })
      .withMessage('rows must be an array of 1–1000 items'),

    body('rows.*.name')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 150 })
      .withMessage('Each row must have a valid name (max 150 chars)'),

    // 🔐 Security hardening
    body('rows.*.adminId').not().exists(),
    body('rows.*.createdByAdminId').not().exists(),
    body('rows.*.updatedByAdminId').not().exists(),
    body('rows.*.agency').not().exists(),
    body('rows.*.softDeleted').not().exists(),
  ]),

  asyncHandler(async (req, res) => {
    // ─────────────────────────────────────
    // 🔐 AUTH GUARD (CRITICAL)
    // ─────────────────────────────────────
    const adminId = req.admin?.id;
    const agency  = req.admin?.agency ?? null;

    if (!adminId) {
      return res.status(401).json({
        success: false,
        errorCode: 'UNAUTHORIZED',
        message: 'Admin authentication required',
      });
    }

    // ─────────────────────────────────────
    // 🔹 REQUEST META (for observability)
    // ─────────────────────────────────────
    const requestId =
      req.headers['x-request-id'] ||
      req.headers['x-correlation-id'] ||
      `import_${Date.now()}`;

    const { datasetType, rows } = req.body;

    // ─────────────────────────────────────
    // 🚀 SERVICE CALL
    // ─────────────────────────────────────
    const result = await importService.processImport({
      datasetType,
      rows,
      adminId,
      agency,
      requestId, // 🔥 pass for tracing/logging
    });

    // ─────────────────────────────────────
    // 📊 STATUS LOGIC (refined)
    // ─────────────────────────────────────
    let statusCode = 200;

    if (result.inserted > 0 && result.duplicates.length > 0) {
      statusCode = 207; // Partial success
    } else if (result.inserted > 0) {
      statusCode = 201; // Created
    } else if (result.duplicates.length > 0 && result.errors.length === 0) {
      statusCode = 409; // Fully duplicate
    } else {
      statusCode = 422; // Validation/processing failure
    }

    // ─────────────────────────────────────
    // 📤 RESPONSE
    // ─────────────────────────────────────
    return res.status(statusCode).json({
      success: result.inserted > 0,

      data: {
        total: result.total,
        inserted: result.inserted,
        skipped: result.skipped,
        insertedIds: result.insertedIds,
      },

      duplicates: result.duplicates,
      errors: result.errors,

      meta: {
        datasetType,
        requestId,
        importedByAdminId: adminId,
        sourceAgency: agency,
        importedAt: new Date().toISOString(),
      },
    });
  })
);

module.exports = router;