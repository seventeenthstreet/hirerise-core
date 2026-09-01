'use strict';

/**
 * src/modules/onboarding/onboarding.routes.js
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UPLOAD FLOW OVERVIEW
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This router owns the SYNC upload path for CV processing during onboarding.
 *
 *   POST /api/v1/onboarding/upload-cv          ← canonical route
 *   POST /api/v1/onboarding/upload-cv-sync     ← alias (identical behaviour)
 *
 *   MODE: sync
 *   • File is parsed immediately in-request.
 *   • parsedData is returned in the response body.
 *   • No polling required — result is available instantly.
 *   • Contrast with POST /api/v1/resumes (async, returns jobId for polling).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { Router } = require('express');
const multer = require('multer');
const { body, param } = require('express-validator');

const { validate } = require('../../middleware/requestValidator');
const { creditGuard } = require('../../middleware/creditGuard.middleware');
const { tierQuota } = require('../../middleware/tierquota.middleware');
const { aiRateLimitByPlan } = require('../../middleware/aiRateLimitByPlan.middleware');

/**
 * Blocker 1:
 *
 * This route was previously protected by the JWT-only verifyAdmin middleware.
 * The onboarding router is mounted with authenticate only, so there was no
 * outer DB-backed admin lifecycle check.
 *
 * requireAdministrator preserves the historical role boundary:
 *   - admin       → allowed
 *   - super_admin → allowed
 *   - MASTER_ADMIN → denied
 *
 * while additionally verifying the administrator's lifecycle state through
 * admin_principals.
 */
const {
  requireAdministrator,
} = require('../../middleware/requireAdministrator.middleware');

const logger = require('../../utils/logger');

const {
  saveConsent,
  saveQuickStart,
  saveEducationAndExperience,
  saveDraft,
  getDraft,
  saveCvDraft,
  generateCareerReport,
  savePersonalDetails,
  getCvPreview,
  generateCV,
  getCvSignedUrl,
  skipCv,
  getProgress,
  getChiExplainer,
  saveCareerIntent,
  uploadCvDuringOnboarding,
  validateCvFileEndpoint,
  importLinkedIn,
  confirmLinkedInImport,
  suggestRoles,
  getTeaserChi,
  getChiReady,
  getCareerReportStatus,
  getFunnelAnalytics,
  completeOnboarding,
  saveGuidedBuilderSection,
  getGuidedBuilderProfile,
} = require('./controllers/onboarding.controller');

const router = Router();

const path = require('path');

const ALLOWED_ONBOARDING_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/json',
  'text/plain',
]);

const ALLOWED_ONBOARDING_EXTS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.json',
  '.txt',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();

    if (
      !ALLOWED_ONBOARDING_MIMES.has(file.mimetype) ||
      !ALLOWED_ONBOARDING_EXTS.has(ext)
    ) {
      return cb(
        new multer.MulterError(
          'LIMIT_UNEXPECTED_FILE',
          `Unsupported file type "${ext || file.mimetype}". Upload a PDF, DOCX, or TXT file.`,
        ),
      );
    }

    cb(null, true);
  },
});

const VALIDATION_MESSAGES = Object.freeze({
  MISSING_FILE: 'No resume file provided.',
  INVALID_FORMAT:
    'Unsupported file type. Upload a PDF, DOC, DOCX, or TXT file.',
  FILE_TOO_LARGE: 'File exceeds 10MB limit.',
  TOO_MANY_FILES: 'Too many files. Upload one file at a time.',
});

function multerErrorMiddleware(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    const messageMap = {
      LIMIT_FILE_SIZE: VALIDATION_MESSAGES.FILE_TOO_LARGE,
      LIMIT_UNEXPECTED_FILE: VALIDATION_MESSAGES.INVALID_FORMAT,
      LIMIT_FILE_COUNT: VALIDATION_MESSAGES.TOO_MANY_FILES,
    };

    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message:
          messageMap[err.code] ?? `Upload error: ${err.message}`,
      },
    });
  }

  return next(err);
}

// ─────────────────────────────────────────────────────────────
// PUBLIC ROUTES
// ─────────────────────────────────────────────────────────────

router.get('/teaser-chi', getTeaserChi);

// ─────────────────────────────────────────────────────────────
// SHARED
// ─────────────────────────────────────────────────────────────

router.get('/progress', getProgress);
router.get('/chi-ready', getChiReady);
router.get('/career-report/status', getCareerReportStatus);
router.get('/chi-explainer', getChiExplainer);
router.get('/cv-preview', getCvPreview);
router.get('/cv-url', getCvSignedUrl);

// ─────────────────────────────────────────────────────────────
// TRACK A
// ─────────────────────────────────────────────────────────────

router.post(
  '/consent',
  validate([
    body('consentGiven').isBoolean(),
    body('consentVersion')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 20 }),
  ]),
  saveConsent,
);

router.post(
  '/quick-start',
  validate([
    body('jobTitle')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 150 }),
    body('company')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 150 }),
    body('startDate').matches(/^\d{4}-(0[1-9]|1[0-2])$/),
  ]),
  saveQuickStart,
);

router.post('/education-experience', saveEducationAndExperience);

router.post(
  '/import-linkedin',
  upload.single('linkedinProfile'),
  importLinkedIn,
  multerErrorMiddleware,
);

router.post(
  '/import-linkedin/confirm',
  confirmLinkedInImport,
);

router.patch('/draft', saveDraft);
router.get('/draft', getDraft);
router.patch('/cv-draft', saveCvDraft);

router.get('/suggest-roles', suggestRoles);

router.post(
  '/career-report',
  aiRateLimitByPlan,
  tierQuota('careerReport'),
  creditGuard('careerReport'),
  generateCareerReport,
);

router.post('/personal-details', savePersonalDetails);

router.post(
  '/generate-cv',
  aiRateLimitByPlan,
  tierQuota('generateCV'),
  creditGuard('generateCV'),
  generateCV,
);

router.post('/skip-cv', skipCv);

router.post(
  '/validate-cv',
  upload.single('resume'),
  validateCvFileEndpoint,
  multerErrorMiddleware,
);

// ─────────────────────────────────────────────────────────────
// SYNC CV UPLOAD
//
// POST /api/v1/onboarding/upload-cv          ← canonical
// POST /api/v1/onboarding/upload-cv-sync     ← alias
//
// MODE: sync
// • Parses the CV immediately during the request.
// • Returns parsedData + structuredResume in the response body.
// • No polling required.
// ─────────────────────────────────────────────────────────────

function logSyncUpload(req, _res, next) {
  logger.info('[UPLOAD FLOW] Sync onboarding upload triggered', {
    route: req.originalUrl,
    userId: req.user?.id ?? req.user?.uid ?? null,
    fileName: req.file?.originalname ?? null,
  });

  next();
}

router.post(
  '/upload-cv',
  upload.single('resume'),
  logSyncUpload,
  uploadCvDuringOnboarding,
  multerErrorMiddleware,
);

router.post(
  '/upload-cv-sync',
  upload.single('resume'),
  logSyncUpload,
  uploadCvDuringOnboarding,
  multerErrorMiddleware,
);

// ─────────────────────────────────────────────────────────────
// TRACK B
// ─────────────────────────────────────────────────────────────

router.post('/career-intent', saveCareerIntent);

// ─────────────────────────────────────────────────────────────
// GUIDED BUILDER
// ─────────────────────────────────────────────────────────────

router.get('/guided/profile', getGuidedBuilderProfile);

router.post(
  '/guided/:section',
  validate([
    param('section').isIn([
      'personal_details',
      'education',
      'experience',
      'skills',
      'certifications',
      'projects',
      'languages',
      'career_goals',
      'employment_preferences',
    ]),
  ]),
  saveGuidedBuilderSection,
);

// ─────────────────────────────────────────────────────────────
// ADMIN
// ─────────────────────────────────────────────────────────────

router.get(
  '/analytics/funnel',
  requireAdministrator,
  getFunnelAnalytics,
);

router.post('/complete', completeOnboarding);

module.exports = router;