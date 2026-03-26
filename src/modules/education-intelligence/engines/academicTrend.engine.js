'use strict';

/**
 * engines/academicTrend.engine.js
 *
 * Analyses academic marks across class levels to produce:
 *   - Per-subject trend direction (improving / stable / declining)
 *   - Learning velocity score per subject (rate of change)
 *   - Overall learning velocity (average across all tracked subjects)
 *   - Subject strength scores (weighted average of available marks)
 *   - Stream-subject affinity scores (used by StreamIntelligenceEngine)
 *
 * Input (context.academics):
 *   [{ subject, class_level, marks }]  — from edu_academic_records
 *
 * Output:
 * {
 *   subject_trends: {
 *     Mathematics: { latest_marks: 88, trend: 'improving', velocity: +6, strength: 85 },
 *     ...
 *   },
 *   overall_learning_velocity: 3.4,   // avg velocity across all subjects
 *   subject_strengths: { Mathematics: 85, Physics: 72, ... },
 *   stream_subject_scores: {          // used directly by StreamIntelligenceEngine
 *     engineering: 82,
 *     medical: 67,
 *     commerce: 54,
 *     humanities: 48,
 *   },
 * }
 */

const { STREAM_SUBJECT_MAP, STREAMS } = require('../models/academic.model');

// Class level → numeric order for trend calculation
const CLASS_ORDER = {
  class_8:  8,
  class_9:  9,
  class_10: 10,
  class_11: 11,
  class_12: 12,
};

// Velocity thresholds for trend labels
const TREND_IMPROVING  = 3;   // >+3 per year = improving
const TREND_DECLINING  = -3;  // <-3 per year = declining

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * @param {object} context  — { studentId, academics: [], ... }
 * @returns {Promise<AcademicTrendResult>}
 */
async function analyze(context) {
  const { academics = [], studentId } = context;

  if (!academics.length) {
    return _emptyResult();
  }

  // ── 1. Group records by subject ──────────────────────────────────────────
  const bySubject = _groupBySubject(academics);

  // ── 2. Compute trend + strength per subject ──────────────────────────────
  const subject_trends    = {};
  const subject_strengths = {};
  const velocities        = [];

  for (const [subject, records] of Object.entries(bySubject)) {
    const sorted = _sortByClassLevel(records);
    const result = _computeSubjectTrend(sorted);

    subject_trends[subject]    = result;
    subject_strengths[subject] = result.strength;

    if (result.velocity !== null) {
      velocities.push(result.velocity);
    }
  }

  // ── 3. Overall learning velocity ─────────────────────────────────────────
  const overall_learning_velocity = velocities.length
    ? _round(velocities.reduce((a, b) => a + b, 0) / velocities.length, 2)
    : 0;

  // ── 4. Stream-subject affinity scores ────────────────────────────────────
  const stream_subject_scores = _computeStreamSubjectScores(subject_strengths);

  return {
    subject_trends,
    overall_learning_velocity,
    subject_strengths,
    stream_subject_scores,
  };
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Groups academic records by subject name.
 * @param {Array} records
 * @returns {{ [subject: string]: Array }}
 */
function _groupBySubject(records) {
  return records.reduce((acc, r) => {
    if (!r.subject) return acc;
    if (!acc[r.subject]) acc[r.subject] = [];
    acc[r.subject].push(r);
    return acc;
  }, {});
}

/**
 * Sorts records by class level (class_8 → class_12).
 */
function _sortByClassLevel(records) {
  return [...records].sort((a, b) =>
    (CLASS_ORDER[a.class_level] ?? 99) - (CLASS_ORDER[b.class_level] ?? 99)
  );
}

/**
 * Computes trend stats for a single subject across all available class levels.
 *
 * Velocity formula:
 *   (latest_marks − earliest_marks) / (class_gap_years)
 *
 * Strength (weighted average, more recent = higher weight):
 *   Σ(marks × weight) / Σ(weight)
 *   where weight = class_order_index + 1  (class_10 gets weight 3 vs class_8 weight 1)
 */
function _computeSubjectTrend(sortedRecords) {
  if (!sortedRecords.length) {
    return { latest_marks: null, trend: 'unknown', velocity: null, strength: 0 };
  }

  const latest   = sortedRecords[sortedRecords.length - 1];
  const earliest = sortedRecords[0];

  // Weighted strength score
  let weightedSum = 0;
  let weightTotal = 0;
  sortedRecords.forEach((r, i) => {
    const w = i + 1;
    weightedSum += (Number(r.marks) || 0) * w;
    weightTotal += w;
  });
  const strength = _round(weightTotal > 0 ? weightedSum / weightTotal : 0, 1);

  // Velocity (only meaningful if we have ≥2 records at different levels)
  let velocity = null;
  let trend    = 'stable';

  if (sortedRecords.length >= 2) {
    const earliestLevel = CLASS_ORDER[earliest.class_level] ?? 8;
    const latestLevel   = CLASS_ORDER[latest.class_level]   ?? 8;
    const yearGap       = latestLevel - earliestLevel || 1;

    velocity = _round(
      (Number(latest.marks) - Number(earliest.marks)) / yearGap,
      2
    );

    if (velocity >  TREND_IMPROVING) trend = 'improving';
    else if (velocity < TREND_DECLINING) trend = 'declining';
    else trend = 'stable';
  }

  return {
    latest_marks: Number(latest.marks) || 0,
    trend,
    velocity,
    strength,
  };
}

/**
 * Multiplies subject strength scores by the STREAM_SUBJECT_MAP weights
 * to produce a composite score for each stream.
 *
 * Formula per stream:
 *   score = Σ( subject_strength × weight )  /  Σ( weight )  × 100
 *   clamped to 0–100
 */
function _computeStreamSubjectScores(subject_strengths) {
  const scores = {};

  for (const [stream, weightMap] of Object.entries(STREAM_SUBJECT_MAP)) {
    let weightedSum = 0;
    let totalWeight = 0;

    for (const [subject, weight] of Object.entries(weightMap)) {
      const strength = subject_strengths[subject];
      if (strength != null) {
        weightedSum += strength * weight;
        totalWeight += weight;
      }
    }

    // If we have no data for this stream's subjects, score = 0
    scores[stream] = totalWeight > 0
      ? _clamp(_round(weightedSum / totalWeight, 1), 0, 100)
      : 0;
  }

  return scores;
}

function _emptyResult() {
  return {
    subject_trends:            {},
    overall_learning_velocity: 0,
    subject_strengths:         {},
    stream_subject_scores: {
      [STREAMS.ENGINEERING]: 0,
      [STREAMS.MEDICAL]:     0,
      [STREAMS.COMMERCE]:    0,
      [STREAMS.HUMANITIES]:  0,
    },
  };
}

function _round(n, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

function _clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

module.exports = { analyze };








