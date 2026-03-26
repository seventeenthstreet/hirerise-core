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
 *
 * ROUTE MAP:
 *   POST   /api/v1/resumes              — upload CV (all authenticated users)
 *   GET    /api/v1/resumes              — list user's resumes
 *   GET    /api/v1/resumes/:id          — get single resume
 *   DELETE /api/v1/resumes/:id          — delete resume
 *   POST   /api/v1/resumes/score        — AI score (paid only)
 *   POST   /api/v1/resumes/growth       — AI growth analysis (paid only)
 *   POST   /api/v1/resumes/:id/refresh-url — refresh signed URL
 *
 * authenticate is applied at server.js mount point:
 *   app.use(`${API_PREFIX}/resumes`, authenticate, require('./modules/resume/resume.routes'));
 */

const path   = require('path');
const { Router } = require('express');
const multer = require('multer');

const { scoreResume, uploadResume, analyzeResumeGrowth, refreshSignedUrl,
        listResumes, getResume, deleteResume, setActiveResume, rescoreResume } = require('./controllers/resume.controller');
const { conversionHookMiddleware }    = require('../conversion');
const { requirePaidPlan }             = require('../../middleware/requirePaidPlan.middleware');
const { aiRateLimitByPlan }           = require('../../middleware/aiRateLimitByPlan.middleware');

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
// FIX-4: Route is now POST / (not POST /upload) to match frontend calling POST /api/v1/resumes
// FIX-5: requirePaidPlan REMOVED — uploading is a core feature, not AI-gated
// File parsing (pdf-parse / mammoth) happens synchronously; AI scoring is async.
router.post('/',
  upload.single('resume'),
  conversionHookMiddleware,
  uploadResume,
);

// GET /api/v1/resumes — list user's uploaded resumes (FIX-1: was missing)
router.get('/', listResumes);

// GET /api/v1/resumes/:id — get a single resume (FIX-2: was missing)
router.get('/:id', getResume);

// DELETE /api/v1/resumes/:id — soft-delete a resume (FIX-3: was missing)
router.delete('/:id', deleteResume);

// ─────────────────────────────────────────────────────────────
// AI ROUTES (paid-plan gated)
// ─────────────────────────────────────────────────────────────

// POST /api/v1/resumes/score
router.post('/score',
  requirePaidPlan,
  aiRateLimitByPlan,
  conversionHookMiddleware,
  scoreResume,
);

// POST /api/v1/resumes/growth
router.post('/growth',
  requirePaidPlan,
  aiRateLimitByPlan,
  conversionHookMiddleware,
  analyzeResumeGrowth,
);

// POST /api/v1/resumes/:resumeId/refresh-url (FIX G-03)
router.post('/:resumeId/refresh-url', refreshSignedUrl);

// POST /api/v1/resumes/:resumeId/rescore
// Triggers AI scoring for any pending/stuck resume — no plan gate.
// Needed for onboarding-path resumes that were created without going through the
// upload flow, so scoreResume() was never called or failed silently.
router.post('/:resumeId/rescore', rescoreResume);

// POST /api/v1/resumes/set-active — mark a resume as the active/primary one
router.post('/set-active', setActiveResume);

module.exports = router;








