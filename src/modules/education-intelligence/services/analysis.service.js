'use strict';

/**
 * services/analysis.service.js
 *
 * Business logic layer for the Education Intelligence analysis endpoint.
 * Sits between analysis.controller.js and education.orchestrator.js.
 *
 * Responsibilities:
 *   - Verify student exists and onboarding is complete before running analysis
 *   - Delegate pipeline execution to the orchestrator
 *   - Shape the API response
 *
 * Does NOT contain engine logic — all AI logic lives in engines/.
 */

const orchestrator = require('../orchestrator/education.orchestrator');
const repository   = require('../repositories/student.repository');
const logger       = require('../../../utils/logger');

// ─── runAnalysis ──────────────────────────────────────────────────────────────

/**
 * Runs the full AI engine pipeline for a student and returns the recommendation.
 *
 * @param {string} studentId — user ID
 * @param {object} options
 * @param {boolean} options.requireComplete — if true, reject if onboarding not done
 * @returns {Promise<AnalysisResponse>}
 */
async function runAnalysis(studentId, { requireComplete = false } = {}) {
  // ── Pre-flight: student must exist ───────────────────────────────────────
  const student = await repository.getStudent(studentId);

  if (!student) {
    const err = new Error(`Student profile not found for ${studentId}. Complete onboarding first.`);
    err.statusCode = 404;
    err.name = 'NotFoundError';
    throw err;
  }

  if (requireComplete && student.onboarding_step !== 'complete') {
    const err = new Error(
      `Onboarding is not complete for ${studentId}. ` +
      `Current step: ${student.onboarding_step}. All steps must be completed before analysis.`
    );
    err.statusCode = 422;
    err.name = 'OnboardingIncompleteError';
    throw err;
  }

  logger.info({ studentId, step: student.onboarding_step }, '[AnalysisService] Starting analysis');

  // ── Run pipeline ─────────────────────────────────────────────────────────
  const result = await orchestrator.run(studentId);

  // ── Shape API response ───────────────────────────────────────────────────
  return _buildResponse(result);
}

// ─── getAnalysisResult ────────────────────────────────────────────────────────

/**
 * Returns the most recently saved stream scores from Firestore
 * without re-running the pipeline.
 *
 * @param {string} studentId
 * @returns {Promise<AnalysisResponse | null>}
 */
async function getAnalysisResult(studentId) {
  const scores = await repository.getStreamScores(studentId);
  if (!scores || scores.recommended_stream === null) return null;

  return {
    recommended_stream:  scores.recommended_stream,
    recommended_label:   scores.recommended_label   ?? scores.recommended_stream,
    confidence:          scores.confidence,
    alternative_stream:  scores.alternative_stream  ?? null,
    alternative_label:   scores.alternative_label   ?? null,
    stream_scores: {
      engineering: scores.engineering_score,
      medical:     scores.medical_score,
      commerce:    scores.commerce_score,
      humanities:  scores.humanities_score,
    },
    rationale:       scores.rationale       ?? null,
    engine_version:  scores.engine_version  ?? null,
    calculated_at:   scores.calculated_at   ?? null,
  };
}

// ─── Private ─────────────────────────────────────────────────────────────────

/**
 * Maps raw orchestrator output to the public API response shape.
 */
function _buildResponse(result) {
  const stream = result.stream;

  return {
    recommended_stream:  stream.recommended_stream,
    recommended_label:   stream.recommended_label,
    confidence:          stream.confidence,
    alternative_stream:  stream.alternative_stream,
    alternative_label:   stream.alternative_label,
    stream_scores: {
      engineering: stream.stream_scores.engineering ?? 0,
      medical:     stream.stream_scores.medical     ?? 0,
      commerce:    stream.stream_scores.commerce    ?? 0,
      humanities:  stream.stream_scores.humanities  ?? 0,
    },
    rationale:      stream.rationale,
    engine_version: stream.engine_version,

    // Career Success Probability Engine output
    top_careers: result.careers?.top_careers ?? [],

    // Education ROI Engine output
    education_options: result.roi?.education_options ?? [],

    // Career Digital Twin Engine output
    simulations: result.twin?.simulations ?? [],

    // Debug / insight data (stripped in production if desired)
    _debug: {
      academic: {
        overall_learning_velocity: result.academic.overall_learning_velocity,
        subject_trends:            result.academic.subject_trends,
      },
      cognitive: {
        profile_label:   result.cognitive.profile_label,
        dominant_style:  result.cognitive.dominant_style,
        strengths:       result.cognitive.strengths,
      },
      activity: {
        dominant_signal: result.activity.dominant_signal,
        activity_count:  result.activity.activity_count,
        matched_signals: result.activity.matched_signals,
      },
    },
  };
}

module.exports = { runAnalysis, getAnalysisResult };








