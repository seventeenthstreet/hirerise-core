'use strict';

/**
 * src/modules/resume/resume.routes.js
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UPLOAD FLOW OVERVIEW
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This router owns the ASYNC upload path for standalone resume management.
 *
 *   POST /api/v1/resumes
 *
 *   MODE: async
 *   • File is stored immediately; parsing/scoring is queued via the
 *     resume-worker and runs out-of-band.
 *   • Response returns a jobId. Clients MUST poll to get results:
 *       GET /api/v1/resumes/:id   — resume record + processing status
 *   • Contrast with POST /api/v1/onboarding/upload-cv (sync — parsedData
 *     is returned immediately in the same response, no polling needed).
 *
 * ─────────────────────────────────────────────────────────────────────────────
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
const logger = require('../../utils/logger');

const {
  scoreResume,
  uploadResume,
  analyzeResumeGrowth,
  refreshSignedUrl,
  listResumes,
  getResume,
  deleteResume,
  setActiveResume,
  rescoreResume,
  getResumeStatus,
} = require('./controllers/resume.controller');

const {
  requirePaidPlan
} = require('../../middleware/requirePaidPlan.middleware');

const {
  aiRateLimitByPlan
} = require('../../middleware/aiRateLimitByPlan.middleware');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Task 4: Standardized validation message constants
// Matches the same set used in onboarding.routes.js so error
// messages are identical across both upload flows.
// ─────────────────────────────────────────────────────────────
const VALIDATION_MESSAGES = Object.freeze({
  MISSING_FILE:   'No resume file provided.',
  INVALID_FORMAT: 'Unsupported file type. Upload a PDF, DOC, DOCX, or TXT file.',
  FILE_TOO_LARGE: 'File exceeds 10MB limit.',
  TOO_MANY_FILES: 'Too many files. Upload one file at a time.',
});

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

  if (!isMimeAllowed || !isExtensionAllowed) {
    // Task 4: use standardized message from VALIDATION_MESSAGES
    return cb(
      new multer.MulterError(
        'LIMIT_UNEXPECTED_FILE',
        VALIDATION_MESSAGES.INVALID_FORMAT
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

// Task 4: Multer error middleware — converts MulterError → structured 400 JSON
// using the same standardized messages as onboarding.routes.js.
function multerErrorMiddleware(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    const messageMap = {
      LIMIT_FILE_SIZE:       VALIDATION_MESSAGES.FILE_TOO_LARGE,
      LIMIT_UNEXPECTED_FILE: VALIDATION_MESSAGES.INVALID_FORMAT,
      LIMIT_FILE_COUNT:      VALIDATION_MESSAGES.TOO_MANY_FILES,
    };
    return res.status(400).json({
      success: false,
      error: {
        code:    'VALIDATION_ERROR',
        message: messageMap[err.code] ?? `Upload error: ${err.message}`,
      },
    });
  }
  return next(err);
}

// ─────────────────────────────────────────────────────────────
// AI routes — must come BEFORE param routes to avoid
// Express matching 'score', 'growth', 'set-active' as /:id
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

// ─────────────────────────────────────────────────────────────
// CRUD routes
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// ASYNC upload — POST /api/v1/resumes
//
// MODE: async
// • Stores the file and queues scoring via resume-worker.
// • Returns jobId immediately. NO parsedData in response.
// • Clients MUST poll: GET /api/v1/resumes/:id
// • Contrast: POST /api/v1/onboarding/upload-cv is SYNC and
//   returns parsedData immediately with no polling required.
//
// Form-data field: resume (PDF | DOC | DOCX | TXT, max 10 MB)
// ─────────────────────────────────────────────────────────────
router.post(
  '/',
  uploadResumeMiddleware.single('resume'),
  // Task 6: UPLOAD FLOW log before controller
  (req, _res, next) => {
    logger.info('[UPLOAD FLOW] Async resume upload queued', {
      userId:   req.user?.id ?? req.user?.uid ?? null,
      fileName: req.file?.originalname ?? null,
      mimeType: req.file?.mimetype     ?? null,
    });
    next();
  },
  uploadResume,
  multerErrorMiddleware
);

// GET /api/v1/resumes
router.get('/', listResumes);

// ─────────────────────────────────────────────────────────────
// CANONICAL POLLING ENDPOINT
// GET /api/v1/resumes/:resumeId/status
//
// Frontend MUST use this (or GET /api/v1/resumes/:id) to poll
// async processing state. Do NOT use /api/v1/ai-jobs/:jobId.
// ─────────────────────────────────────────────────────────────
router.get('/:resumeId/status', getResumeStatus);

// GET /api/v1/resumes/:id
router.get('/:id', getResume);

// DELETE /api/v1/resumes/:id
router.delete('/:id', deleteResume);

// Param routes last
router.post('/:resumeId/refresh-url', refreshSignedUrl);
router.post('/:resumeId/rescore', rescoreResume);

module.exports = router;