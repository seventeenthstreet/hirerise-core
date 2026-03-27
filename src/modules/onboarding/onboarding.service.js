'use strict';

/**
 * onboarding.service.js — FACADE (B-01 GOD-OBJECT DECOMPOSITION COMPLETE)
 *
 * This file is now a pure re-export facade. All function bodies live in the
 * focused sub-services below. No controller changes are needed — every export
 * that existed before is still exported from this file.
 *
 * Sub-services:
 *   onboarding.helpers.js              — shared constants, validators, utilities
 *   onboarding.intake.service.js       — saveConsent, saveQuickStart, saveEducationAndExperience,
 *                                        saveDraft, getDraft, savePersonalDetails, saveCareerIntent
 *   onboarding.careerReport.service.js — generateCareerReport, getCareerReportStatus
 *   onboarding.cv.service.js           — getCvPreview, buildCvHtml, generateCV, getCvSignedUrl,
 *                                        skipCv, saveCvDraft
 *   onboarding.linkedin.service.js     — importLinkedIn, confirmLinkedInImport
 *   onboarding.analytics.service.js    — getProgress, getChiReady, getTeaserChi,
 *                                        getChiExplainer, computeChiCompleteness, getFunnelAnalytics
 *
 * DO NOT add new functions to this file. Add to the appropriate sub-service instead.
 */

const intake       = require('./onboarding.intake.service');
const careerReport = require('./onboarding.careerReport.service');
const cv           = require('./onboarding.cv.service');
const linkedin     = require('./onboarding.linkedin.service');
const analytics    = require('./onboarding.analytics.service');
const helpers      = require('./onboarding.helpers');

module.exports = {
  // ── Intake ───────────────────────────────────────────────────────────────────
  saveConsent:                intake.saveConsent,
  saveQuickStart:             intake.saveQuickStart,
  saveEducationAndExperience: intake.saveEducationAndExperience,
  saveDraft:                  intake.saveDraft,
  getDraft:                   intake.getDraft,
  savePersonalDetails:        intake.savePersonalDetails,
  saveCareerIntent:           intake.saveCareerIntent,

  // ── Career Report ─────────────────────────────────────────────────────────────
  generateCareerReport:       careerReport.generateCareerReport,
  getCareerReportStatus:      careerReport.getCareerReportStatus,
  buildCareerReportPrompt:    careerReport.buildCareerReportPrompt,

  // ── CV Generation ─────────────────────────────────────────────────────────────
  getCvPreview:               cv.getCvPreview,
  buildCvHtml:                cv.buildCvHtml,
  generateCV:                 cv.generateCV,
  getCvSignedUrl:             cv.getCvSignedUrl,
  skipCv:                     cv.skipCv,
  saveCvDraft:                cv.saveCvDraft,

  // ── LinkedIn ──────────────────────────────────────────────────────────────────
  importLinkedIn:             linkedin.importLinkedIn,
  confirmLinkedInImport:      linkedin.confirmLinkedInImport,

  // ── Analytics & Progress ──────────────────────────────────────────────────────
  getProgress:                analytics.getProgress,
  getChiReady:                analytics.getChiReady,
  getTeaserChi:               analytics.getTeaserChi,
  getChiExplainer:            analytics.getChiExplainer,
  computeChiCompleteness:     analytics.computeChiCompleteness,
  getFunnelAnalytics:         analytics.getFunnelAnalytics,

  // ── Shared helpers re-exported for controllers that reference them directly ────
  sanitiseInput:              helpers.sanitiseInput,
  appendStepHistory:          helpers.appendStepHistory,
  mergeStepHistory:           helpers.mergeStepHistory,
  persistCompletionIfReady:   helpers.persistCompletionIfReady,
  calculateCareerWeights:     helpers.calculateCareerWeights,
  buildAIContext:             helpers.buildAIContext,
  mergeSkills:                helpers.mergeSkills,
  CHI_TREND_THRESHOLD:        helpers.CHI_TREND_THRESHOLD,
};