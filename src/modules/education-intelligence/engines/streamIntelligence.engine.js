'use strict';

/**
 * engines/streamIntelligence.engine.js
 *
 * Combines outputs from all three upstream engines into a final stream
 * recommendation with a confidence score and human-readable rationale.
 *
 * Scoring formula per stream:
 *
 *   raw_score =
 *       (academic_subject_score  × WEIGHT.academic)
 *     + (cognitive_affinity      × WEIGHT.cognitive)
 *     + (activity_influence_norm × WEIGHT.activity)
 *     + (learning_velocity_bonus × WEIGHT.velocity)
 *
 *   confidence = (top_score − second_score) / top_score × 100
 *                clamped to 0–99
 *
 * Weights are tuned so that academic performance is the primary signal
 * (50%), cognitive ability is secondary (30%), and activities + velocity
 * are supporting signals (10% each).
 *
 * Input:
 *   context        — { studentId, student, academics, activities, cognitive }
 *   academicResult — output of AcademicTrendEngine.analyze()
 *   cognitiveResult— output of CognitiveProfileEngine.analyze()
 *   activityResult — output of ActivityAnalyzerEngine.analyze()
 *
 * Output:
 * {
 *   recommended_stream:  'engineering',
 *   recommended_label:   'Computer Science',
 *   confidence:          84,
 *   alternative_stream:  'commerce',
 *   alternative_label:   'Commerce',
 *   stream_scores: {
 *     engineering: 84,
 *     medical:     34,
 *     commerce:    72,
 *     humanities:  55,
 *   },
 *   rationale: 'Strong Mathematics (88%) and analytical thinking (84) align well with Computer Science.',
 *   engine_version: '1.0.0',
 * }
 */

const { STREAMS } = require('../models/academic.model');

const ENGINE_VERSION = '1.0.0';

// ─── Score weights ────────────────────────────────────────────────────────────

const WEIGHT = {
  academic:  0.50,  // academic subject score (0–100)
  cognitive: 0.30,  // cognitive stream affinity (0–100)
  activity:  0.10,  // activity influence normalised (0–100)
  velocity:  0.10,  // learning velocity bonus (0–100, clamped)
};

// Activity influence max (matches activityAnalyzer cap) — used for normalisation
const ACTIVITY_MAX = 30;

// Velocity range for bonus normalisation
const VELOCITY_MIN = -10;   // full decline
const VELOCITY_MAX =  10;   // strong improvement

// Stream display labels
const STREAM_LABEL = {
  [STREAMS.ENGINEERING]: 'Computer Science',
  [STREAMS.MEDICAL]:     'Bio-Maths',
  [STREAMS.COMMERCE]:    'Commerce',
  [STREAMS.HUMANITIES]:  'Humanities',
};

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * @param {object} context
 * @param {object} academicResult   — from AcademicTrendEngine.analyze()
 * @param {object} cognitiveResult  — from CognitiveProfileEngine.analyze()
 * @param {object} activityResult   — from ActivityAnalyzerEngine.analyze()
 * @returns {Promise<StreamRecommendation>}
 */
async function recommend(context, academicResult, cognitiveResult, activityResult) {
  const streams = Object.values(STREAMS);

  // ── 1. Compute raw score for each stream ─────────────────────────────────
  const raw_scores = {};

  for (const stream of streams) {
    const academic_score  = academicResult?.stream_subject_scores?.[stream]   ?? 0;
    const cognitive_score = cognitiveResult?.stream_affinity?.[stream]         ?? 0;
    const activity_raw    = activityResult?.stream_influence?.[stream]         ?? 0;
    const velocity        = academicResult?.overall_learning_velocity           ?? 0;

    // Normalise activity influence to 0–100
    const activity_score = _clamp(_round((activity_raw / ACTIVITY_MAX) * 100, 1), 0, 100);

    // Normalise velocity to 0–100 (mid-point = 50 = neutral)
    const velocity_norm  = _clamp(
      _round(((velocity - VELOCITY_MIN) / (VELOCITY_MAX - VELOCITY_MIN)) * 100, 1),
      0, 100
    );

    raw_scores[stream] = _round(
      academic_score  * WEIGHT.academic  +
      cognitive_score * WEIGHT.cognitive +
      activity_score  * WEIGHT.activity  +
      velocity_norm   * WEIGHT.velocity,
      1
    );
  }

  // ── 2. Clamp final scores to 0–100 ───────────────────────────────────────
  const stream_scores = {};
  for (const [stream, score] of Object.entries(raw_scores)) {
    stream_scores[stream] = _clamp(_round(score, 0), 0, 100);
  }

  // ── 3. Sort streams by score descending ──────────────────────────────────
  const ranked = Object.entries(stream_scores)
    .sort(([, a], [, b]) => b - a);

  const [topStream, topScore]    = ranked[0];
  const [altStream, altScore]    = ranked[1] ?? [null, 0];

  // ── 4. Confidence score ───────────────────────────────────────────────────
  // How decisively does the top stream lead?
  // Gap-based: wider gap = higher confidence, capped at 99
  const gap        = topScore - (altScore ?? 0);
  const confidence = _clamp(_round((gap / Math.max(topScore, 1)) * 100 + 40, 0), 30, 99);
  // +40 baseline so a clear winner still shows a meaningful confidence

  // ── 5. Build rationale ───────────────────────────────────────────────────
  const rationale = _buildRationale(
    topStream, topScore, altStream,
    academicResult, cognitiveResult, activityResult
  );

  return {
    recommended_stream:  topStream,
    recommended_label:   STREAM_LABEL[topStream] ?? topStream,
    confidence,
    alternative_stream:  altStream,
    alternative_label:   STREAM_LABEL[altStream] ?? altStream,
    stream_scores,
    rationale,
    engine_version: ENGINE_VERSION,
  };
}

// ─── Rationale builder ────────────────────────────────────────────────────────

function _buildRationale(topStream, topScore, altStream, academic, cognitive, activity) {
  const parts = [];

  // Academic signal
  const strengths = Object.entries(academic?.subject_strengths ?? {})
    .filter(([, s]) => s >= 70)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 2)
    .map(([subj, s]) => `${subj} (${s}%)`);

  if (strengths.length) {
    parts.push(`Strong academic performance in ${strengths.join(' and ')}`);
  }

  // Cognitive signal
  const profile = cognitive?.profile_label;
  if (profile) {
    parts.push(`cognitive profile (${profile})`);
  }

  // Activity signal
  const domSignal = activity?.dominant_signal;
  if (domSignal === topStream && activity.activity_count > 0) {
    parts.push(`extracurricular activities aligned with ${STREAM_LABEL[topStream]}`);
  }

  const label = STREAM_LABEL[topStream] ?? topStream;
  const base  = parts.length
    ? `${parts.join(', ')} support a strong fit for ${label}.`
    : `Overall profile best matches ${label}.`;

  const altLabel = STREAM_LABEL[altStream] ?? altStream;
  return altLabel
    ? `${base} ${altLabel} is a strong alternative if your interests shift.`
    : base;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _round(n, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

function _clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

module.exports = { recommend };








