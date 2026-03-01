'use strict';

/**
 * onboarding.controller.js — UPDATED
 *
 * New handlers:
 *   saveDraft       — GAP F5
 *   getCvPreview    — GAP F4
 *   getCvSignedUrl  — GAP T5
 *
 * GAP T4: idempotency key extracted from Idempotency-Key header and
 *   forwarded to service for careerReport and generateCV.
 */

const onboardingService = require('../onboarding.service');

function _safeUserId(req) {
  return req?.user?.uid ?? req?.user?.id ?? null;
}

// POST /api/v1/onboarding/consent  (PROMPT-2)
// Body: { consentVersion: "1.0" }
// Must be called before /education-experience. Idempotent.
async function saveConsent(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.saveConsent(userId, req.body);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// POST /api/v1/onboarding/education-experience
async function saveEducationAndExperience(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.saveEducationAndExperience(userId, req.body);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// PATCH /api/v1/onboarding/draft  (GAP F5)
async function saveDraft(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.saveDraft(userId, req.body);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// POST /api/v1/onboarding/career-report
// GAP T4: Idempotency-Key header forwarded to service
async function generateCareerReport(req, res, next) {
  try {
    const userId          = _safeUserId(req);
    const idempotencyKey  = req.headers['idempotency-key'] || null;
    const userTier        = req.user?.normalizedTier ?? req.user?.plan ?? 'free';
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.generateCareerReport(userId, req.creditCost, idempotencyKey, userTier);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// POST /api/v1/onboarding/personal-details
async function savePersonalDetails(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.savePersonalDetails(userId, req.body);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// GET /api/v1/onboarding/cv-preview  (GAP F4)
async function getCvPreview(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.getCvPreview(userId);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// POST /api/v1/onboarding/generate-cv
// GAP T4: Idempotency-Key header forwarded to service
async function generateCV(req, res, next) {
  try {
    const userId         = _safeUserId(req);
    const idempotencyKey = req.headers['idempotency-key'] || null;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.generateCV(userId, req.creditCost, idempotencyKey);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// GET /api/v1/onboarding/cv-url  (GAP T5)
async function getCvSignedUrl(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.getCvSignedUrl(userId);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// POST /api/v1/onboarding/skip-cv
async function skipCv(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.skipCv(userId);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// GET /api/v1/onboarding/progress
async function getProgress(req, res, next) {
  try {
    const userId = _safeUserId(req);
    const tier   = req.user?.plan ?? 'free';
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.getProgress(userId, tier);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// GET /api/v1/onboarding/chi-explainer  (G-14)
// Read-only. Returns dimension descriptions + data readiness nudges.
// Call this before showing the CHI score so users understand the model.
async function getChiExplainer(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.getChiExplainer(userId);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// POST /api/v1/onboarding/career-intent
async function saveCareerIntent(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.saveCareerIntent(userId, req.body);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// POST /api/v1/onboarding/upload-cv  (GAP-11)
// Alternative to generate-cv for users who already have a professional CV.
// Delegates to the existing uploadResume() service, then marks onboarding progress.
async function uploadCvDuringOnboarding(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

    // Delegate to existing resume upload service (handles storage + scoring trigger)
    const { uploadResume } = require('../../resume/resume.service');
    const uploadResult = await uploadResume(userId, req.file);

    // Mark onboarding progress — mirrors what generateCV() does
    const { db } = require('../../../config/firebase');
    const { appendStepHistory, persistCompletionIfReady } = require('../onboarding.service');

    await db.collection('onboardingProgress').doc(userId).set({
      step:      'cv_uploaded',
      cvResumeId: uploadResult.resumeId,
      wantsCv:   true,
      ...appendStepHistory('cv_uploaded'),
      updatedAt: new Date(),
    }, { merge: true });

    const [progressSnap, profileSnap] = await Promise.all([
      db.collection('onboardingProgress').doc(userId).get(),
      db.collection('userProfiles').doc(userId).get(),
    ]);
    await persistCompletionIfReady(userId, progressSnap.data() || {}, profileSnap.data() || {});

    return res.status(201).json({
      success: true,
      data: {
        userId,
        resumeId: uploadResult.resumeId,
        fileUrl:  uploadResult.fileUrl,
        step:     'cv_uploaded',
        message:  'Your CV has been uploaded. Career Health Index will generate shortly.',
      },
    });
  } catch (err) { return next(err); }
}

module.exports = {
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
};