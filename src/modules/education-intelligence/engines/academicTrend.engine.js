'use strict';

/**
 * engines/academicTrend.engine.js
 *
 * Pure academic trend intelligence engine.
 * Fully deterministic, side-effect free, and production hardened.
 */

const {
  STREAM_SUBJECT_MAP,
  STREAMS
} = require('../models/academic.model');

const CLASS_ORDER = Object.freeze({
  class_8: 8,
  class_9: 9,
  class_10: 10,
  class_11: 11,
  class_12: 12
});

const TREND_IMPROVING = 3;
const TREND_DECLINING = -3;

async function analyze(context = {}) {
  const academics = Array.isArray(context.academics)
    ? context.academics
    : [];

  if (!academics.length) {
    return createEmptyResult();
  }

  const bySubject = groupBySubject(academics);

  const subject_trends = {};
  const subject_strengths = {};
  const velocities = [];

  for (const [subject, records] of Object.entries(bySubject)) {
    const normalized = dedupeAndNormalizeRecords(records);

    if (!normalized.length) continue;

    const result = computeSubjectTrend(normalized);

    subject_trends[subject] = result;
    subject_strengths[subject] = result.strength;

    if (typeof result.velocity === 'number') {
      velocities.push(result.velocity);
    }
  }

  const overall_learning_velocity = velocities.length
    ? round(
        velocities.reduce((sum, value) => sum + value, 0) /
          velocities.length,
        2
      )
    : 0;

  const stream_subject_scores =
    computeStreamSubjectScores(subject_strengths);

  return {
    subject_trends,
    overall_learning_velocity,
    subject_strengths,
    stream_subject_scores
  };
}

function groupBySubject(records) {
  return records.reduce((acc, record) => {
    if (!record?.subject) return acc;

    const subject = String(record.subject).trim();
    if (!subject) return acc;

    if (!acc[subject]) acc[subject] = [];
    acc[subject].push(record);

    return acc;
  }, {});
}

function dedupeAndNormalizeRecords(records) {
  const bestByClass = new Map();

  for (const record of records) {
    const classLevel = record?.class_level;
    const marks = Number(record?.marks);

    if (!CLASS_ORDER[classLevel]) continue;
    if (!Number.isFinite(marks)) continue;

    const existing = bestByClass.get(classLevel);

    // keep highest mark if duplicate class rows exist
    if (!existing || marks > existing.marks) {
      bestByClass.set(classLevel, {
        class_level: classLevel,
        marks
      });
    }
  }

  return [...bestByClass.values()].sort(
    (a, b) =>
      CLASS_ORDER[a.class_level] -
      CLASS_ORDER[b.class_level]
  );
}

function computeSubjectTrend(sortedRecords) {
  if (!sortedRecords.length) {
    return {
      latest_marks: null,
      trend: 'unknown',
      velocity: null,
      strength: 0
    };
  }

  const latest = sortedRecords[sortedRecords.length - 1];
  const earliest = sortedRecords[0];

  let weightedSum = 0;
  let weightTotal = 0;

  sortedRecords.forEach((record, index) => {
    const weight = index + 1;
    weightedSum += record.marks * weight;
    weightTotal += weight;
  });

  const strength = round(
    weightTotal ? weightedSum / weightTotal : 0,
    1
  );

  let velocity = null;
  let trend = 'stable';

  if (sortedRecords.length >= 2) {
    const earliestLevel = CLASS_ORDER[earliest.class_level];
    const latestLevel = CLASS_ORDER[latest.class_level];
    const yearGap = Math.max(1, latestLevel - earliestLevel);

    velocity = round(
      (latest.marks - earliest.marks) / yearGap,
      2
    );

    if (velocity > TREND_IMPROVING) {
      trend = 'improving';
    } else if (velocity < TREND_DECLINING) {
      trend = 'declining';
    }
  }

  return {
    latest_marks: latest.marks,
    trend,
    velocity,
    strength
  };
}

function computeStreamSubjectScores(subject_strengths) {
  const scores = {};

  for (const [stream, weightMap] of Object.entries(
    STREAM_SUBJECT_MAP
  )) {
    let weightedSum = 0;
    let totalWeight = 0;

    for (const [subject, weight] of Object.entries(weightMap)) {
      const strength = subject_strengths[subject];

      if (typeof strength === 'number') {
        weightedSum += strength * weight;
        totalWeight += weight;
      }
    }

    scores[stream] = totalWeight
      ? clamp(round(weightedSum / totalWeight, 1), 0, 100)
      : 0;
  }

  return scores;
}

function createEmptyResult() {
  return {
    subject_trends: {},
    overall_learning_velocity: 0,
    subject_strengths: {},
    stream_subject_scores: {
      [STREAMS.ENGINEERING]: 0,
      [STREAMS.MEDICAL]: 0,
      [STREAMS.COMMERCE]: 0,
      [STREAMS.HUMANITIES]: 0
    }
  };
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

module.exports = {
  analyze
};