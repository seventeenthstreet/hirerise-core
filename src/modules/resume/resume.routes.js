'use strict';

/**
 * resume.routes.js
 *
 * CHANGES (remediation sprint):
 *   FIX-1e: Fixed auth.middleware import path — was pointing to
 *            '../../shared/middleware/auth.middleware' which does not exist,
 *            causing server crash on startup. Corrected to '../../middleware/auth.middleware'.
 *   FIX-17: Added Multer fileFilter to explicitly allow PDF, DOCX, DOC, TXT
 *            and reject all other file types with a clean 415 error.
 *
 * Route chain:
 *   authenticate → conversionHookMiddleware → controller
 */

const { Router } = require('express');
const multer = require('multer');

const { scoreResume, uploadResume, analyzeResumeGrowth, refreshSignedUrl } = require('./controllers/resume.controller');
const { conversionHookMiddleware }    = require('../conversion');
const { authenticate }                = require('../../middleware/auth.middleware');

const router = Router();

// ─────────────────────────────────────────────────────────────
// ALLOWED FILE TYPES
// ─────────────────────────────────────────────────────────────
const ALLOWED_MIMETYPES = new Set([
  'application/pdf',                                                              // .pdf
  'application/msword',                                                           // .doc
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',     // .docx
  'text/plain',                                                                   // .txt
]);

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.txt']);

function fileFilter(req, file, cb) {
  const ext = require('path')
    .extname(file.originalname)
    .toLowerCase();

  if (ALLOWED_MIMETYPES.has(file.mimetype) || ALLOWED_EXTENSIONS.has(ext)) {
    cb(null, true);
  } else {
    cb(
      new multer.MulterError(
        'LIMIT_UNEXPECTED_FILE',
        `Unsupported file type "${ext || file.mimetype}". ` +
        'Please upload a PDF, DOC, DOCX, or TXT file.'
      ),
      false
    );
  }
}

// ─────────────────────────────────────────────────────────────
// MULTER CONFIG
// ─────────────────────────────────────────────────────────────
const upload = multer({
  storage:    multer.memoryStorage(),
  limits:     { fileSize: 10 * 1024 * 1024 }, // 10 MB (matches service)
  fileFilter,
});

// ─────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────

// POST /api/v1/resumes/score
router.post('/score', authenticate, conversionHookMiddleware, scoreResume);

// POST /api/v1/resumes/upload
router.post('/upload', authenticate, upload.single('resume'), conversionHookMiddleware, uploadResume);

// POST /api/v1/resumes/growth
router.post('/growth', authenticate, conversionHookMiddleware, analyzeResumeGrowth);

// POST /api/v1/resumes/:resumeId/refresh-url  (FIX G-03)
// Regenerates a fresh 7-day signed URL for a resume PDF stored in Firebase Storage.
// Call when signedUrlExpiresAt is within 1 hour of expiry, or when URL returns 403.
router.post('/:resumeId/refresh-url', authenticate, refreshSignedUrl);

module.exports = router;