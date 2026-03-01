'use strict';

/**
 * onboarding.routes.js — UPDATED (G-02 / G-14)
 *
 * Routes added:
 *   POST  /consent            — PROMPT-2: explicit consent before Step 1 (GDPR/PDPL)
 *   GET   /chi-explainer      — G-14: dimension descriptions + data readiness nudges
 *   PATCH /draft              — GAP F5: partial save without full validation
 *   GET   /cv-preview         — GAP F4: returns CV HTML without PDF conversion
 *   GET   /cv-url             — GAP T5: get/refresh signed CV URL
 *   POST  /upload-cv          — GAP-11: upload existing CV, skip AI generation
 *
 * Also fixed: duplicate route block that appeared after module.exports in previous version.
 */

const { Router } = require('express');
const multer      = require('multer');
const { creditGuard } = require('../../middleware/creditGuard.middleware');
const { tierQuota }   = require('../../middleware/tierquota.middleware');
const {
  saveConsent,
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
} = require('./controllers/onboarding.controller');

// GAP-11: multer configured for in-memory PDF upload (10 MB limit)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

const router = Router();

// ── Step 0: Consent (PROMPT-2) ────────────────────────────────────────────────
router.post('/consent', saveConsent);

// ── Track A ───────────────────────────────────────────────────────────────────

// Step 1: Education + Experience + Skills + Target Role + Career Gaps
router.post('/education-experience', saveEducationAndExperience);

// Step 1b: Partial draft save — no validation (GAP F5)
router.patch('/draft', saveDraft);

// Step 2: Generate career report (AI-gated)
router.post('/career-report',
  tierQuota('careerReport'),
  creditGuard('careerReport'),
  generateCareerReport
);

// Step 3: Personal details for CV
router.post('/personal-details', savePersonalDetails);

// Step 3b: CV preview (HTML only — no PDF, no credits) (GAP F4)
router.get('/cv-preview', getCvPreview);

// Step 4: Generate CV PDF (AI-gated)
router.post('/generate-cv',
  tierQuota('generateCV'),
  creditGuard('generateCV'),
  generateCV
);

// Skip CV
router.post('/skip-cv', skipCv);

// Upload existing CV — alternative to AI generation (GAP-11)
router.post('/upload-cv', upload.single('resume'), uploadCvDuringOnboarding);

// Signed URL refresh (GAP T5)
router.get('/cv-url', getCvSignedUrl);

// ── Track B ───────────────────────────────────────────────────────────────────

router.post('/career-intent', saveCareerIntent);

// ── Shared ────────────────────────────────────────────────────────────────────

router.get('/progress', getProgress);

// G-14: CHI explainer — call before showing score so users understand the model
// Read-only, no credits, no AI calls.
router.get('/chi-explainer', getChiExplainer);

module.exports = router;