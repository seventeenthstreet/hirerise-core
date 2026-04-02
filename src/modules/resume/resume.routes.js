'use strict';

/**
 * resume.routes.js — HireRise Resume Intelligence Routes
 *
 * FIXES APPLIED:
 *   FIX-1: Added GET / (list resumes) — was completely missing, causing listResumes() 404
 *   FIX-2: Added GET /:id (single resume) — was missing
 *   FIX-3: Added DELETE /:id (delete resume) — was missing
 *   FIX-4: Changed upload route from POST /upload to POST / to match frontend
 *           contract (POST /api/v1/resumes)
 *   FIX-5: Removed requirePaidPlan from upload — CV upload is a core free feature,
 *           not an AI-only premium endpoint. Scoring/growth remain gated.
 *   FIX-6: Upload now responds with jobId for async polling
 *   FIX-7: Removed conversionHookMiddleware from all route chains.
 *           conversionHook.middleware.js exports a repository singleton instance,
 *           not an Express middleware function. Passing it to router.post() caused:
 *           "Route.post() requires a callback function but got a [object Object]"
 *           Conversion tracking is handled inside the controller layer, not here.
 *
 * ROUTE MAP:
 *   POST   /api/v1/resumes              — upload CV (all authenticated users)
 *   GET    /api/v1/resumes              — list user's resumes
 *   GET    /api/v1/resumes/:id          — get single resume
 *   DELETE /api/v1/resumes/:id          — delete resume
 *   POST   /api/v1/resumes/score        — AI score (paid only)
 *   POST   /api/v1/resumes/growth       — AI growth analysis (paid only)
 *   POST   /api/v1/resumes/:id/refresh-url — refresh signed URL
 *   POST   /api/v1/resumes/:id/rescore  — re-trigger AI scoring
 *   POST   /api/v1/resumes/set-active   — mark resume as primary
 *
 * authenticate is applied at server.js mount point:
 *   app.use(`${API_PREFIX}/resumes`, authenticate, require('./modules/resume/resume.routes'));
 */

const path = require('path');
const { Router } = require('express');
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
  rescoreResume,
} = require('./controllers/resume.controller');

const { requirePaidPlan }    = require('../../middleware/requirePaidPlan.middleware');
const { aiRateLimitByPlan }  = require('../../middleware/aiRateLimitByPlan.middleware');

// FIX-7: conversionHookMiddleware import removed entirely.
// The conversion repository (conversionHook.middleware.js) exports a singleton
// class instance — it is not an Express middleware function and must not appear
// in a router.post() chain. Conversion tracking belongs in the controller layer.

const router = Router();

// ─────────────────────────────────────────────────────────────
// MULTER — memory storage with type + size validation
// ─────────────────────────────────────────────────────────────

const ALLOWED_MIMETYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
]);

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.txt']);

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
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

const upload = multer({
  storage:    multer.memoryStorage(),
  limits:     { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter,
});

// ─────────────────────────────────────────────────────────────
// CRUD ROUTES (no AI gating — available to all authenticated users)
// ─────────────────────────────────────────────────────────────

// POST /api/v1/resumes — upload CV
router.post('/',
  upload.single('resume'),
  uploadResume,
);

// GET /api/v1/resumes — list user's uploaded resumes
router.get('/', listResumes);

// GET /api/v1/resumes/:id — get a single resume
router.get('/:id', getResume);

// DELETE /api/v1/resumes/:id — soft-delete a resume
router.delete('/:id', deleteResume);

// ─────────────────────────────────────────────────────────────
// AI ROUTES (paid-plan gated)
// ─────────────────────────────────────────────────────────────

// POST /api/v1/resumes/score
// NOTE: /score must be defined before /:id to prevent Express matching
// "score" as a dynamic :id parameter.
router.post('/score',
  requirePaidPlan,
  aiRateLimitByPlan,
  scoreResume,
);

// POST /api/v1/resumes/growth
// NOTE: /growth must be defined before /:resumeId routes for the same reason.
router.post('/growth',
  requirePaidPlan,
  aiRateLimitByPlan,
  analyzeResumeGrowth,
);

// POST /api/v1/resumes/set-active — mark a resume as the active/primary one
// NOTE: defined before /:resumeId routes to avoid being swallowed by the param.
router.post('/set-active', setActiveResume);

// POST /api/v1/resumes/:resumeId/refresh-url
router.post('/:resumeId/refresh-url', refreshSignedUrl);

// POST /api/v1/resumes/:resumeId/rescore
router.post('/:resumeId/rescore', rescoreResume);

module.exports = router;