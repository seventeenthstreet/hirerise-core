'use strict';

/**
 * adminImport.routes.js — Flat CSV Import Routes
 *
 * Mounted in server.js as:
 *   app.use(`${API_PREFIX}/admin/import`, authenticate, requireAdmin, adminImportRouter);
 *
 * Exposes one route per entity type so the frontend can call:
 *   POST /api/v1/admin/import/skills
 *   POST /api/v1/admin/import/roles
 *   POST /api/v1/admin/import/job-families
 *   POST /api/v1/admin/import/education-levels
 *   POST /api/v1/admin/import/salary-benchmarks
 *
 * All routes accept multipart/form-data with a single "file" field (CSV).
 * Parsing, dedup, and Firestore writes are delegated to adminImport.service.js.
 *
 * @module modules/admin/import/adminImport.routes
 */

const express = require('express');
const multer  = require('multer');
const { adminImportController, importStatusController } = require('./adminImport.controller');
const { AppError } = require('../../../middleware/errorHandler');

const router = express.Router();

// ── Multer — memory storage, 10 MB limit, CSV-only ───────────────────────────

const CSV_MIME_TYPES = new Set([
  'text/csv',
  'text/plain',
  'application/csv',
  'application/vnd.ms-excel',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB — matches frontend validation
  fileFilter: (_req, file, cb) => {
    const ext = (file.originalname || '').toLowerCase().match(/\.[^.]+$/)?.[0] || '';
    if (CSV_MIME_TYPES.has(file.mimetype) || ext === '.csv') {
      return cb(null, true);
    }
    cb(new AppError(
      `CSV file required. Received: "${file.mimetype}" (${file.originalname})`,
      400,
      { received: file.mimetype, filename: file.originalname },
      'INVALID_FILE'
    ));
  },
});

// Convert multer-specific errors to standard AppError envelope
function handleMulterError(err, _req, _res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new AppError('File too large. Maximum size is 10 MB.', 400, { limit: '10MB' }, 'INVALID_FILE'));
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(new AppError('Unexpected field. Upload CSV in a field named "file".', 400, null, 'INVALID_FILE'));
    }
    return next(new AppError(err.message, 400, null, 'INVALID_FILE'));
  }
  next(err);
}

// ── Status route — returns step completion state for the frontend ─────────────
router.get('/status', importStatusController);

// ── Entity routes (one per frontend ImportEntity value) ───────────────────────

const fileMiddleware = [upload.single('file'), handleMulterError];

router.post('/skills',              fileMiddleware, adminImportController('skills'));
router.post('/roles',               fileMiddleware, adminImportController('roles'));
router.post('/job-families',        fileMiddleware, adminImportController('job-families'));
router.post('/education-levels',    fileMiddleware, adminImportController('education-levels'));
router.post('/salary-benchmarks',   fileMiddleware, adminImportController('salary-benchmarks'));
router.post('/career-domains',      fileMiddleware, adminImportController('career-domains'));
router.post('/skill-clusters',      fileMiddleware, adminImportController('skill-clusters'));

// ── Supabase skill intelligence tables ────────────────────────────────────────
// These two routes write to Supabase skill_demand + role_skills tables,
// replacing the static CSV files in src/data/.
// Expected CSV columns:
//   skill-demand: skill, demand_score, growth_rate, salary_boost, industry
//   role-skills:  role, skill, is_required (optional, default true), priority (optional)
router.post('/skill-demand',        fileMiddleware, adminImportController('skill-demand'));
router.post('/role-skills',         fileMiddleware, adminImportController('role-skills'));

module.exports = router;








