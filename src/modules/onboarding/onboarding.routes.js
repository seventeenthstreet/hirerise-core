'use strict';

/**
 * src/modules/onboarding/onboarding.routes.js
 * Final production-safe onboarding route layer
 */

const { Router } = require('express');
const multer = require('multer');
const { body } = require('express-validator');

const { validate } = require('../../middleware/requestValidator');
const { creditGuard } = require('../../middleware/creditGuard.middleware');
const { tierQuota } = require('../../middleware/tierquota.middleware');
const { aiRateLimit } = require('../../middleware/aiRateLimit.middleware');
const { verifyAdmin } = require('../../middleware/verifyAdmin.middleware');

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
} = require('./controllers/onboarding.controller');

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/json',
      'text/plain',
    ];

    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Unsupported file type'));
    }

    cb(null, true);
  },
});

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
router.post('/consent',
  validate([
    body('consentGiven').isBoolean(),
    body('consentVersion').optional().isString().trim().isLength({ max: 20 }),
  ]),
  saveConsent
);

router.post('/quick-start',
  validate([
    body('jobTitle').isString().trim().notEmpty().isLength({ max: 150 }),
    body('company').isString().trim().notEmpty().isLength({ max: 150 }),
    body('startDate')
      .matches(/^\d{4}-(0[1-9]|1[0-2])$/),
  ]),
  saveQuickStart
);

router.post('/education-experience', saveEducationAndExperience);

router.post(
  '/import-linkedin',
  upload.single('linkedinProfile'),
  importLinkedIn
);

router.post(
  '/import-linkedin/confirm',
  confirmLinkedInImport
);

router.patch('/draft', saveDraft);
router.get('/draft', getDraft);
router.patch('/cv-draft', saveCvDraft);

router.get('/suggest-roles', suggestRoles);

router.post(
  '/career-report',
  aiRateLimit,
  tierQuota('careerReport'),
  creditGuard('careerReport'),
  generateCareerReport
);

router.post('/personal-details', savePersonalDetails);

router.post(
  '/generate-cv',
  aiRateLimit,
  tierQuota('generateCV'),
  creditGuard('generateCV'),
  generateCV
);

router.post('/skip-cv', skipCv);

router.post(
  '/validate-cv',
  upload.single('resume'),
  validateCvFileEndpoint
);

router.post(
  '/upload-cv',
  upload.single('resume'),
  uploadCvDuringOnboarding
);

// ─────────────────────────────────────────────────────────────
// TRACK B
// ─────────────────────────────────────────────────────────────
router.post('/career-intent', saveCareerIntent);

// ─────────────────────────────────────────────────────────────
// ADMIN
// ─────────────────────────────────────────────────────────────
router.get(
  '/analytics/funnel',
  verifyAdmin,
  getFunnelAnalytics
);

router.post('/complete', completeOnboarding);

module.exports = router;