'use strict';

// CONTRACT NOTE (Phase 2): All error responses use V2 canonical shape.


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
        error: {
          code: 'UNAUTHORIZED',
          message: 'Admin authentication required',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
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
    // CONTRACT FIX (WP-ADMIN-COMP-03 §22): when success is false (partial/no
    // insert), the response previously had no `error` object, so none of the
    // frontend's 3 known error-wire-shapes matched it — `duplicates`/`errors`
    // were silently discarded and replaced with a generic fallback message.
    // Adding a conformant V2 `error.details` alongside the existing top-level
    // `duplicates`/`errors` keys (kept for backward compatibility) is the
    // smallest fix that lets the Import UI actually show what happened; it
    // changes no status codes and no import/business logic.
    const responseBody = {
      success: result.inserted > 0,

      // `duplicates`/`errors` moved inside `data` (in addition to being kept
      // at top level for backward compatibility) because apiRequest's
      // success parser only returns `raw.data` — anything outside it was
      // being silently dropped on 207 partial-success responses.
      data: {
        total: result.total,
        inserted: result.inserted,
        skipped: result.skipped,
        insertedIds: result.insertedIds,
        duplicates: result.duplicates,
        errors: result.errors,
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
    };

    if (!responseBody.success) {
      // Use the frontend's existing known BackendErrorCode values (CONFLICT,
      // VALIDATION_ERROR) rather than inventing new ones — an unrecognised
      // code falls through mapErrorCodeToCategory's default to a generic
      // 'system' category, which would show a worse message than the
      // accurate 'conflict'/'validation' categories these cases deserve.
      const isAllDuplicate = result.duplicates.length > 0 && result.errors.length === 0;
      responseBody.error = {
        code: isAllDuplicate ? 'CONFLICT' : 'VALIDATION_ERROR',
        message: isAllDuplicate
          ? 'All rows were duplicates — nothing was imported.'
          : 'Import failed validation — nothing was imported.',
        details: {
          duplicates: result.duplicates,
          errors: result.errors,
        },
      };
    }

    return res.status(statusCode).json(responseBody);
  })
);

module.exports = router;