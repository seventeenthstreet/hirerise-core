'use strict';

/**
 * engines/cognitiveProfile.engine.js
 *
 * Maps the five self-assessment cognitive scores into:
 *   - Dominant learning style (visual / analytical / communicative / creative / balanced)
 *   - Cognitive profile label  (e.g. "Analytical-Logical", "Creative-Communicator")
 *   - Per-stream cognitive affinity scores (weighted sum of dimension × engine_weight)
 *
 * Input (context.cognitive):
 *   { analytical_score, logical_score, memory_score,
 *     communication_score, creativity_score }
 *
 * Output:
 * {
 *   scores: { analytical: 84, logical: 78, ... },   // normalised 0–100
 *   dominant_style:  'analytical',
 *   profile_label:   'Analytical-Logical',
 *   strengths:       ['Analytical Thinking', 'Logical Reasoning'],
 *   weaknesses:      ['Memory & Retention'],
 *   stream_affinity: { engineering: 81, medical: 63, commerce: 70, humanities: 55 },
 * }
 */

const { COGNITIVE_DIMENSIONS } = require('../models/academic.model');

// Strength / weakness threshold
const STRENGTH_THRESHOLD  = 70;  // score ≥ 70 = strength
const WEAKNESS_THRESHOLD  = 40;  // score ≤ 40 = weakness

// ─── Profile label matrix ────────────────────────────────────────────────────
// Ordered by priority — first match wins.
// Each entry: { requires: [dim_keys with score ≥ threshold], label, style }

const PROFILE_RULES = [
  { requires: ['analytical_score', 'logical_score'],       label: 'Analytical-Logical',      style: 'analytical'    },
  { requires: ['analytical_score', 'creativity_score'],    label: 'Analytical-Creative',      style: 'analytical'    },
  { requires: ['logical_score',    'memory_score'],         label: 'Logical-Retentive',        style: 'analytical'    },
  { requires: ['communication_score', 'creativity_score'], label: 'Creative-Communicator',    style: 'communicative' },
  { requires: ['memory_score', 'communication_score'],     label: 'Retentive-Communicator',   style: 'communicative' },
  { requires: ['creativity_score', 'logical_score'],       label: 'Creative-Reasoner',        style: 'creative'      },
  { requires: ['analytical_score'],                        label: 'Analytical Thinker',       style: 'analytical'    },
  { requires: ['communication_score'],                     label: 'Strong Communicator',      style: 'communicative' },
  { requires: ['creativity_score'],                        label: 'Creative Mind',            style: 'creative'      },
  { requires: ['memory_score'],                            label: 'Strong Memoriser',         style: 'retentive'     },
  { requires: ['logical_score'],                           label: 'Logical Reasoner',         style: 'analytical'    },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * @param {object} context  — { cognitive: { analytical_score, ... }, ... }
 * @returns {Promise<CognitiveProfileResult>}
 */
async function analyze(context) {
  const cog = context.cognitive;

  if (!cog) {
    return _emptyResult();
  }

  // ── 1. Normalise scores into a clean map ─────────────────────────────────
  const scores = {};
  for (const dim of COGNITIVE_DIMENSIONS) {
    scores[dim.key] = _clamp(Number(cog[dim.key]) || 0, 0, 100);
  }

  // ── 2. Identify strengths & weaknesses ───────────────────────────────────
  const strengths  = [];
  const weaknesses = [];

  for (const dim of COGNITIVE_DIMENSIONS) {
    const v = scores[dim.key];
    if (v >= STRENGTH_THRESHOLD)  strengths.push(dim.label);
    if (v <= WEAKNESS_THRESHOLD)  weaknesses.push(dim.label);
  }

  // ── 3. Derive dominant style + profile label ─────────────────────────────
  const { dominant_style, profile_label } = _deriveProfile(scores);

  // ── 4. Per-stream cognitive affinity ────────────────────────────────────
  const stream_affinity = _computeStreamAffinity(scores);

  // ── 5. Normalised score map (friendlier keys for downstream engines) ──────
  const normalisedScores = {
    analytical:    scores.analytical_score,
    logical:       scores.logical_score,
    memory:        scores.memory_score,
    communication: scores.communication_score,
    creativity:    scores.creativity_score,
  };

  return {
    scores:         normalisedScores,
    dominant_style,
    profile_label,
    strengths,
    weaknesses,
    stream_affinity,
  };
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Matches against PROFILE_RULES — first rule where ALL required dimensions
 * meet the STRENGTH_THRESHOLD wins.
 */
function _deriveProfile(scores) {
  for (const rule of PROFILE_RULES) {
    const allMet = rule.requires.every(key => scores[key] >= STRENGTH_THRESHOLD);
    if (allMet) {
      return { dominant_style: rule.style, profile_label: rule.label };
    }
  }
  return { dominant_style: 'balanced', profile_label: 'Well-Rounded' };
}

/**
 * Computes stream affinity score per stream by multiplying each cognitive
 * dimension score by its engine_weight for that stream, then averaging.
 *
 * Formula:
 *   stream_affinity[stream] = Σ(score[dim] × engine_weight[stream]) / Σ(engine_weight[stream])
 */
function _computeStreamAffinity(scores) {
  const affinity = {};

  // Build per-stream weighted sum
  const streams = ['engineering', 'medical', 'commerce', 'humanities'];

  for (const stream of streams) {
    let weightedSum = 0;
    let totalWeight = 0;

    for (const dim of COGNITIVE_DIMENSIONS) {
      const weight = dim.engine_weight[stream] || 0;
      const score  = scores[dim.key] || 0;
      weightedSum += score * weight;
      totalWeight += weight;
    }

    affinity[stream] = totalWeight > 0
      ? _clamp(_round(weightedSum / totalWeight, 1), 0, 100)
      : 0;
  }

  return affinity;
}

function _emptyResult() {
  return {
    scores:         { analytical: 0, logical: 0, memory: 0, communication: 0, creativity: 0 },
    dominant_style: 'unknown',
    profile_label:  'Unknown',
    strengths:      [],
    weaknesses:     [],
    stream_affinity:{ engineering: 0, medical: 0, commerce: 0, humanities: 0 },
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








