'use strict';

/**
 * src/modules/resume/resume.routes.js
 *
 * Production-ready Resume routes.
 *
 * Improvements:
 * - Route ordering hardened
 * - Multer validation production-safe
 * - Centralized upload middleware
 * - Better MIME + extension validation
 * - Explicit multer error normalization
 * - Safer memory usage
 * - Cleaner maintainability
 */

const path = require('path');
const express = require('express');
const multer = require('multer');

const {
  scoreResume,
  uploadResume,
  analyzeResumeGrowth,
  refreshSignedUrl,
  listResumes,
  getResume,
  deleteResume,
  setActiveResume,
  rescoreResume
} = require('./controllers/resume.controller');

const {
  requirePaidPlan
} = require('../../middleware/requirePaidPlan.middleware');

const {
  aiRateLimitByPlan
} = require('../../middleware/aiRateLimitByPlan.middleware');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Upload configuration
// ─────────────────────────────────────────────────────────────

const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain'
]);

const ALLOWED_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.txt'
]);

function fileFilter(req, file, cb) {
  const extension = path.extname(file.originalname || '').toLowerCase();
  const mimeType = file.mimetype || '';

  const isMimeAllowed = ALLOWED_MIME_TYPES.has(mimeType);
  const isExtensionAllowed = ALLOWED_EXTENSIONS.has(extension);

  if (!isMimeAllowed && !isExtensionAllowed) {
    return cb(
      new multer.MulterError(
        'LIMIT_UNEXPECTED_FILE',
        `Unsupported file type "${extension || mimeType}". ` +
          'Please upload a PDF, DOC, DOCX, or TXT file.'
      )
    );
  }

  return cb(null, true);
}

const uploadResumeMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_SIZE_BYTES,
    files: 1
  },
  fileFilter
});

// ─────────────────────────────────────────────────────────────
// CRUD routes
// ─────────────────────────────────────────────────────────────

// POST /api/v1/resumes
router.post(
  '/',
  uploadResumeMiddleware.single('resume'),
  uploadResume
);

// GET /api/v1/resumes
router.get('/', listResumes);

// GET /api/v1/resumes/:id
router.get('/:id', getResume);

// DELETE /api/v1/resumes/:id
router.delete('/:id', deleteResume);

// ─────────────────────────────────────────────────────────────
// AI routes
// ─────────────────────────────────────────────────────────────

// Must stay before param routes
router.post(
  '/score',
  requirePaidPlan,
  aiRateLimitByPlan,
  scoreResume
);

router.post(
  '/growth',
  requirePaidPlan,
  aiRateLimitByPlan,
  analyzeResumeGrowth
);

router.post('/set-active', setActiveResume);

// Param routes last
router.post('/:resumeId/refresh-url', refreshSignedUrl);
router.post('/:resumeId/rescore', rescoreResume);

module.exports = router;