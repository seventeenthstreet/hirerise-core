'use strict';

/**
 * src/modules/onboarding/onboarding.service.js
 *
 * Pure facade re-export layer
 * Backward compatibility preserved for legacy callers.
 */

const intake = require('./onboarding.intake.service');
const careerReport = require('./onboarding.careerReport.service');
const cv = require('./onboarding.cv.service');
const linkedin = require('./onboarding.linkedin.service');
const analytics = require('./onboarding.analytics.service');
const helpers = require('./onboarding.helpers');

module.exports = {
  // ── Intake ───────────────────────────────────────────────────
  saveConsent: intake.saveConsent,
  saveQuickStart: intake.saveQuickStart,
  saveEducationAndExperience: intake.saveEducationAndExperience,
  saveDraft: intake.saveDraft,
  getDraft: intake.getDraft,
  savePersonalDetails: intake.savePersonalDetails,
  saveCareerIntent: intake.saveCareerIntent,

  // ── Career Report ────────────────────────────────────────────
  generateCareerReport: careerReport.generateCareerReport,
  getCareerReportStatus: careerReport.getCareerReportStatus,
  buildCareerReportPrompt: careerReport.buildCareerReportPrompt,

  // ── CV Generation ────────────────────────────────────────────
  getCvPreview: cv.getCvPreview,
  buildCvHtml: cv.buildCvHtml,
  generateCV: cv.generateCV,
  getCvSignedUrl: cv.getCvSignedUrl,
  skipCv: cv.skipCv,
  saveCvDraft: cv.saveCvDraft,

  // ── LinkedIn ─────────────────────────────────────────────────
  importLinkedIn: linkedin.importLinkedIn,
  confirmLinkedInImport: linkedin.confirmLinkedInImport,

  // ── Analytics & Progress ─────────────────────────────────────
  getProgress: analytics.getProgress,
  getChiReady: analytics.getChiReady,
  getTeaserChi: analytics.getTeaserChi,
  getChiExplainer: analytics.getChiExplainer,
  computeChiCompleteness: analytics.computeChiCompleteness,
  getFunnelAnalytics: analytics.getFunnelAnalytics,

  // ── Shared helpers / compatibility exports ───────────────────
  sanitiseInput: helpers.sanitiseInput,

  // backward compatibility alias
  appendStepHistory: helpers.mergeStepHistory,

  mergeStepHistory: helpers.mergeStepHistory,
  persistCompletionIfReady: helpers.persistCompletionIfReady,
  buildAIContext: helpers.buildAIContext,
  mergeSkills: helpers.mergeSkills,
  CHI_TREND_THRESHOLD: helpers.CHI_TREND_THRESHOLD,
};