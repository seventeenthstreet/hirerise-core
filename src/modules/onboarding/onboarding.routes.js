'use strict';

/**
 * onboarding.routes.js — UPDATED (Phase 1)
 *
 * Phase 1 additions:
 *   POST  /quick-start        — P1-01: minimal 4-field save → immediate provisional CHI
 *   GET   /suggest-roles      — P1-05: role suggestions from job title string
 *   GET   /teaser-chi         — P1-06: industry-average CHI snapshot (no user data needed)
 *
 * Existing routes preserved unchanged.
 */

const { Router } = require('express');
const multer      = require('multer');
const { body, query } = require('express-validator');
const { validate }    = require('../../middleware/requestValidator'); // C-06
const { creditGuard } = require('../../middleware/creditGuard.middleware');
const { tierQuota }   = require('../../middleware/tierquota.middleware');
const { aiRateLimit } = require('../../middleware/aiRateLimit.middleware'); // P4-06
const { verifyAdmin } = require('../../middleware/verifyAdmin.middleware'); // P4-04
const {
  saveConsent,
  saveQuickStart,              // P1-01
  saveEducationAndExperience,
  saveDraft,
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
  importLinkedIn,              // SPRINT-3 H8
  suggestRoles,                // P1-05
  getTeaserChi,                // P1-06
  getChiReady,                 // P2-05
  getCareerReportStatus,       // P2-07
  confirmLinkedInImport,       // P3-02
  getDraft,                    // P3-04
  saveCvDraft,                 // P3-07
  getFunnelAnalytics,          // P4-04
  completeOnboarding,          // direct completion for CV-upload path
} = require('./controllers/onboarding.controller');

// GAP-11: multer configured for in-memory PDF upload (10 MB limit)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

const router = Router();

// ── Step 0: Consent (PROMPT-2) ────────────────────────────────────────────────
router.post('/consent',
  validate([
    body('consentGiven').isBoolean().withMessage('consentGiven must be true or false'),
    body('consentVersion').optional().isString().trim().isLength({ max: 20 }),
  ]),
  saveConsent
);

// ── P1-06: Teaser CHI — no user data needed, shows industry average ───────────
// Must be registered before authenticated routes that require progress data.
// Read-only, no credits, no AI call — returns static industry-average CHI snapshot.
router.get('/teaser-chi', getTeaserChi);

// ── Track A ───────────────────────────────────────────────────────────────────

// P1-01: Quick Start — minimal 4-field save, fires provisional CHI immediately
// Replaces the old "fill everything first" wall with a progressive two-phase model:
//   Phase 1 → POST /quick-start   (4 fields, instant CHI)
//   Phase 2 → POST /education-experience (enrichment, score improves)
router.post('/quick-start',
  validate([
    body('jobTitle').isString().trim().notEmpty().isLength({ max: 150 })
      .withMessage('jobTitle is required (max 150 chars)'),
    body('company').isString().trim().notEmpty().isLength({ max: 150 })
      .withMessage('company is required (max 150 chars)'),
    body('startDate').isString().trim().notEmpty()
      .matches(/^\d{4}-(0[1-9]|1[0-2])$/)
      .withMessage('startDate must be YYYY-MM format'),
    body('expectedRoleIds').optional().isArray({ max: 5 })
      .withMessage('expectedRoleIds must be an array (max 5)'),
    body('expectedRoleIds.*').optional().isString().trim().isLength({ max: 100 }),
    body('skills').optional().isArray({ max: 30 })
      .withMessage('skills must be an array (max 30)'),
    body('isCurrent').optional().isBoolean(),
  ]),
  saveQuickStart
);

// Step 1: Full Education + Experience + Skills + Target Role + Career Gaps (enrichment)
router.post('/education-experience',
  validate([
    body('experience').optional().isArray({ max: 20 })
      .withMessage('experience must be an array (max 20 entries)'),
    body('experience.*.jobTitle').optional().isString().trim().isLength({ max: 150 }),
    body('experience.*.company').optional().isString().trim().isLength({ max: 150 }),
    body('experience.*.startDate').optional().isString()
      .matches(/^\d{4}-(0[1-9]|1[0-2])$/)
      .withMessage('experience startDate must be YYYY-MM format'),
    body('education').optional().isArray({ max: 10 })
      .withMessage('education must be an array (max 10 entries)'),
    body('education.*.degree').optional().isString().trim().isLength({ max: 150 }),
    body('education.*.institution').optional().isString().trim().isLength({ max: 150 }),
    body('skills').optional().isArray({ max: 50 })
      .withMessage('skills must be an array (max 50)'),
    body('targetRole').optional().isString().trim().isLength({ max: 150 }),
  ]),
  saveEducationAndExperience
);

// Step 1 pre-population: import LinkedIn profile export (SPRINT-3 H8)
router.post('/import-linkedin', upload.single('linkedinProfile'), importLinkedIn);

// P3-02: Confirm LinkedIn import — promotes importedProfile to live fields
router.post('/import-linkedin/confirm', confirmLinkedInImport);

// Step 1 partial draft save — no validation (GAP F5)
router.patch('/draft', saveDraft);

// P3-04: GET /draft — return current saved draft for pre-populating form on return visit
router.get('/draft', getDraft);

// P3-07: PATCH /cv-draft — store CV editable-field overrides before PDF generation
router.patch('/cv-draft', saveCvDraft);

// P1-05: Role suggestions from job title string — used to pre-fill expectedRoleIds[]
// Query: ?q=<jobTitle>&limit=<max>
router.get('/suggest-roles', suggestRoles);

// Step 2: Generate career report (AI-gated)
router.post('/career-report',
  aiRateLimit,                 // P4-06: per-IP/user burst protection
  tierQuota('careerReport'),
  creditGuard('careerReport'),
  generateCareerReport
);

// Step 3: Personal details for CV
router.post('/personal-details',
  validate([
    body('fullName').isString().trim().notEmpty().isLength({ max: 100 })
      .withMessage('fullName is required (max 100 chars)'),
    body('email').optional().isEmail().normalizeEmail()
      .withMessage('email must be a valid email address'),
    body('phone').optional().isString().trim().isLength({ max: 20 }),
    body('city').optional().isString().trim().isLength({ max: 100 }),
    body('country').optional().isString().trim().isLength({ max: 100 }),
    body('currentSalaryLPA').optional().isFloat({ min: 0, max: 10000 })
      .withMessage('currentSalaryLPA must be a number'),
    body('careerObjective').optional().isString().trim().isLength({ max: 500 }),
  ]),
  savePersonalDetails
);

// Step 3b: CV preview (HTML only — no PDF, no credits) (GAP F4)
router.get('/cv-preview', getCvPreview);

// Step 4: Generate CV PDF (AI-gated)
router.post('/generate-cv',
  aiRateLimit,                 // P4-06: per-IP/user burst protection
  tierQuota('generateCV'),
  creditGuard('generateCV'),
  generateCV
);

// Skip CV
router.post('/skip-cv', skipCv);

// Upload existing CV — alternative to AI generation (GAP-11)
// POST /api/v1/onboarding/validate-cv
// Accepts a multipart file upload, extracts text, runs the CV classifier,
// and returns { is_cv, confidence, document_type, reason, detected_sections }.
// Does NOT store anything — pure validation, no side-effects.
router.post('/validate-cv',
  upload.single('resume'),
  validateCvFileEndpoint,
);

router.post('/upload-cv', upload.single('resume'), uploadCvDuringOnboarding);

// Signed URL refresh (GAP T5)
router.get('/cv-url', getCvSignedUrl);

// ── Track B ───────────────────────────────────────────────────────────────────

router.post('/career-intent',
  validate([
    body('targetRoleIds').optional().isArray({ max: 5 })
      .withMessage('targetRoleIds must be an array (max 5)'),
    body('targetRoleIds.*').optional().isString().trim().isLength({ max: 100 }),
    body('preferredWorkLocation').optional()
      .isIn(['remote', 'hybrid', 'onsite', 'flexible'])
      .withMessage('preferredWorkLocation must be remote | hybrid | onsite | flexible'),
    body('openToRelocation').optional().isBoolean(),
    body('targetSalaryLPA').optional().isFloat({ min: 0, max: 10000 }),
    body('availabilityWeeks').optional().isInt({ min: 0, max: 52 }),
  ]),
  saveCareerIntent
);

// ── Shared ────────────────────────────────────────────────────────────────────

router.get('/progress', getProgress);

// P2-05: CHI readiness check — is a real score ready to display?
// Frontend polls this after /quick-start or /career-report to know when CHI is available.
router.get('/chi-ready', getChiReady);

// P2-07: Career report status polling — avoids long-polling POST /career-report
router.get('/career-report/status', getCareerReportStatus);

// G-14: CHI explainer — call before showing score so users understand the model
router.get('/chi-explainer', getChiExplainer);

// ── Admin ─────────────────────────────────────────────────────────────────────

// P4-04: Funnel analytics — admin only
// Returns step-by-step conversion rates, drop-off counts, median completion time.
// Query: ?limit=500&after=<lastDocId> (cursor pagination)
router.get('/analytics/funnel', verifyAdmin, getFunnelAnalytics);

// POST /api/v1/onboarding/complete
// Explicitly marks onboarding as completed for the CV-upload path.
// The manual (Track B) path completes via generateCareerReport → persistCompletionIfReady.
// The CV-upload (Track A) path has no career report step in the UI flow, so needs
// this direct endpoint. Writes onboardingCompleted: true to users/{id} AND userProfiles/{id}.
router.post('/complete', completeOnboarding);

module.exports = router;








