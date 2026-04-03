'use strict';

/**
 * src/modules/education-intelligence/services/analysis.service.js
 *
 * Business logic layer for Education Intelligence analysis.
 *
 * Responsibilities:
 * - validate student readiness
 * - enforce onboarding completion rules
 * - run orchestration pipeline
 * - normalize public API response shape
 */

const orchestrator = require('../orchestrator/education.orchestrator');
const repository = require('../repositories/student.repository');
const logger = require('../../../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

async function runAnalysis(studentId, { requireComplete = false } = {}) {
  const student = await repository.getStudent(studentId);

  if (!student) {
    const error = new Error(
      `Student profile not found for ${studentId}. Complete onboarding first.`
    );
    error.statusCode = 404;
    error.name = 'NotFoundError';
    throw error;
  }

  if (requireComplete && student.onboarding_step !== 'complete') {
    const error = new Error(
      `Onboarding is not complete for ${studentId}. Current step: ${student.onboarding_step}.`
    );
    error.statusCode = 422;
    error.name = 'OnboardingIncompleteError';
    throw error;
  }

  logger.info(
    { studentId, step: student.onboarding_step },
    '[AnalysisService] Starting analysis'
  );

  const result = await orchestrator.run(studentId);

  return buildResponse(result);
}

async function getAnalysisResult(studentId) {
  const scores = await repository.getStreamScores(studentId);

  if (!scores || scores.recommended_stream == null) {
    return null;
  }

  return {
    recommended_stream: scores.recommended_stream,
    recommended_label:
      scores.recommended_label ?? scores.recommended_stream,
    confidence: scores.confidence,
    alternative_stream: scores.alternative_stream ?? null,
    alternative_label: scores.alternative_label ?? null,
    stream_scores: {
      engineering: scores.engineering_score ?? 0,
      medical: scores.medical_score ?? 0,
      commerce: scores.commerce_score ?? 0,
      humanities: scores.humanities_score ?? 0,
    },
    rationale: scores.rationale ?? null,
    engine_version: scores.engine_version ?? null,
    calculated_at: scores.calculated_at ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildResponse(result = {}) {
  const stream = result.stream ?? {};
  const academic = result.academic ?? {};
  const cognitive = result.cognitive ?? {};
  const activity = result.activity ?? {};
  const careers = result.careers ?? {};
  const roi = result.roi ?? {};
  const twin = result.twin ?? {};

  return {
    recommended_stream: stream.recommended_stream ?? null,
    recommended_label: stream.recommended_label ?? null,
    confidence: stream.confidence ?? null,
    alternative_stream: stream.alternative_stream ?? null,
    alternative_label: stream.alternative_label ?? null,

    stream_scores: {
      engineering: stream.stream_scores?.engineering ?? 0,
      medical: stream.stream_scores?.medical ?? 0,
      commerce: stream.stream_scores?.commerce ?? 0,
      humanities: stream.stream_scores?.humanities ?? 0,
    },

    rationale: stream.rationale ?? null,
    engine_version: stream.engine_version ?? null,

    // Career Success Probability Engine
    top_careers: careers.top_careers ?? [],

    // Education ROI Engine
    education_options: roi.education_options ?? [],

    // Career Digital Twin Engine
    simulations: twin.simulations ?? [],

    // Optional debug payload
    _debug: {
      academic: {
        overall_learning_velocity:
          academic.overall_learning_velocity ?? null,
        subject_trends: academic.subject_trends ?? [],
      },
      cognitive: {
        profile_label: cognitive.profile_label ?? null,
        dominant_style: cognitive.dominant_style ?? null,
        strengths: cognitive.strengths ?? [],
      },
      activity: {
        dominant_signal: activity.dominant_signal ?? null,
        activity_count: activity.activity_count ?? 0,
        matched_signals: activity.matched_signals ?? [],
      },
    },
  };
}

module.exports = {
  runAnalysis,
  getAnalysisResult,
};