'use strict';

/**
 * adminCmsImport.routes.js — CSV Import Endpoint
 *
 * Mounted in server.js as:
 *   app.use(
 *     `${API_PREFIX}/admin/cms/import`,
 *     authenticate,
 *     requireAdmin,
 *     require('./modules/admin/cms/import/adminCmsImport.routes')
 *   );
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ POST /api/v1/admin/cms/import                                       │
 * │                                                                     │
 * │ Body: { datasetType: 'skills', rows: [{name: '...', ...}] }        │
 * │                                                                     │
 * │ Accepts pre-parsed JSON rows (frontend or upstream service parses   │
 * │ CSV → JSON before calling this endpoint). This keeps the import     │
 * │ service pure and testable without file I/O.                        │
 * │                                                                     │
 * │ For raw CSV file upload, add multer middleware and a CSV→JSON       │
 * │ parser (e.g. csv-parse) before this handler.                       │
 * └─────────────────────────────────────────────────────────────────────┘
 */

const express = require('express');
const { body }     = require('express-validator');
const { validate } = require('../../../../middleware/requestValidator');
const { asyncHandler } = require('../../../../utils/helpers');
const importService    = require('./adminCmsImport.service');

const router = express.Router();

// ── POST /api/v1/admin/cms/import ────────────────────────────────────────────
router.post(
  '/',
  validate([
    body('datasetType')
      .isIn(['skills', 'roles', 'jobFamilies', 'educationLevels'])
      .withMessage('datasetType must be: skills, roles, jobFamilies, or educationLevels'),

    body('rows')
      .isArray({ min: 1, max: 1000 })
      .withMessage('rows must be an array of 1–1000 items'),

    body('rows.*.name')
      .isString().trim().notEmpty()
      .withMessage('Each row must have a non-empty name field'),

    // Security: block attempt to inject identity via rows
    body('rows.*.adminId').not().exists(),
    body('rows.*.createdByAdminId').not().exists(),
    body('rows.*.sourceAgency').not().exists(),
  ]),

  asyncHandler(async (req, res) => {
    // ⚠ SECURITY: adminId and agency always from JWT, never from body
    const adminId = req.user.uid;
    const agency  = req.user.agency ?? null;

    const { datasetType, rows } = req.body;

    const result = await importService.processImport({
      datasetType,
      rows,
      adminId,
      agency,
    });

    // HTTP 207 Multi-Status: some rows may have been accepted, some rejected
    const statusCode = result.inserted > 0 && result.duplicates.length > 0
      ? 207
      : result.inserted > 0
        ? 201
        : 409; // All rows were duplicates

    return res.status(statusCode).json({
      success: result.inserted > 0,
      data: {
        total:      result.total,
        inserted:   result.inserted,
        skipped:    result.skipped,
        insertedIds: result.insertedIds,
      },
      duplicates: result.duplicates,
      errors:     result.errors,
      meta: {
        datasetType,
        importedByAdminId: adminId,
        sourceAgency:      agency,
        importedAt:        new Date().toISOString(),
      },
    });
  })
);

module.exports = router;








