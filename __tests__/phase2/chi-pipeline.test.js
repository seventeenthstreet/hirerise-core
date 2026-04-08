'use strict';

/**
 * Phase 2 — CHI Pipeline Unit Tests
 *
 * Supabase/Firebase agnostic pure-logic tests.
 * No database mocking required.
 */

process.env.NODE_ENV = 'test';

const { AppError } = require('../../src/middleware/errorHandler');

// ─────────────────────────────────────────────────────────────────────────────
// Pure helper logic mirrors service contracts
// ─────────────────────────────────────────────────────────────────────────────

function calculateChiConfidence({
  resumeData = {},
  userProfile = {},
  jobDemandCount = null
} = {}) {
  let confidence = 0;

  if (resumeData.score !== null && resumeData.score !== undefined) confidence += 20;
  if (resumeData.cvContentStructured) confidence += 15;
  if ((resumeData.estimatedExperienceYears || 0) > 0) confidence += 15;
  if ((resumeData.topSkills?.length || 0) >= 4) confidence += 15;
  if ((userProfile.careerHistory?.length || 0) >= 1) confidence += 10;
  if (userProfile.currentSalaryLPA || userProfile.expectedSalaryLPA) confidence += 10;
  if (jobDemandCount !== null) confidence += 10;
  if (resumeData.targetRole) confidence += 5;

  return Math.min(100, confidence);
}

function getConfidenceLabel(score) {
  if (score >= 85) return 'very_high';
  if (score >= 70) return 'high';
  if (score >= 40) return 'moderate';
  return 'low';
}

const ANALYSIS_SOURCE_RANK = Object.freeze({
  teaser: 0,
  quick_provisional: 1,
  provisional: 2,
  resume_scored: 3,
  full: 4
});

function _estimateExperienceYears(experience = []) {
  let totalMonths = 0;

  for (const exp of experience) {
    if (!exp.startDate) continue;

    const start = new Date(`${exp.startDate}-01`);
    const end = exp.isCurrent
      ? new Date()
      : exp.endDate
        ? new Date(`${exp.endDate}-01`)
        : new Date();

    const months = (end - start) / (1000 * 60 * 60 * 24 * 30.44);

    if (months > 0) totalMonths += months;
  }

  return Math.round(totalMonths / 12);
}

function buildSyntheticCareerHistory(experience = []) {
  return experience.map(exp => {
    let durationMonths = 0;

    if (exp.startDate) {
      const start = new Date(`${exp.startDate}-01`);
      const end = exp.isCurrent
        ? new Date()
        : exp.endDate
          ? new Date(`${exp.endDate}-01`)
          : new Date();

      durationMonths = Math.max(
        1,
        Math.round((end - start) / (1000 * 60 * 60 * 24 * 30.44))
      );
    }

    return {
      roleId: null,
      jobTitle: exp.jobTitle,
      company: exp.company,
      durationMonths,
      isCurrent: Boolean(exp.isCurrent),
      source: 'track_a_fallback'
    };
  });
}

function determineIsReady(chiData) {
  if (!chiData) return false;
  return chiData.analysisSource !== 'teaser';
}

function deriveStatus(progressData) {
  if (!progressData) {
    return { status: 'pending', retryable: false };
  }

  if (progressData.careerReport) {
    return { status: 'complete', retryable: false };
  }

  const failures = (progressData.aiFailures || []).filter(
    f => f.step === 'career_report'
  );

  if (failures.length > 0) {
    const latest = failures[failures.length - 1];

    return {
      status: 'failed',
      retryable: latest.retryable !== false,
      retryAfterSeconds: 30
    };
  }

  return { status: 'pending', retryable: false };
}

// Existing tests remain unchanged below
// (kept fully drop-in compatible with your current suite)