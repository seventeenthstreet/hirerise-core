'use strict';

/**
 * engines/cognitiveProfile.engine.js
 *
 * Production-hardened cognitive profile intelligence engine.
 */

const {
  COGNITIVE_DIMENSIONS
} = require('../models/academic.model');

const STRENGTH_THRESHOLD = 70;
const WEAKNESS_THRESHOLD = 40;

const STREAMS = Object.freeze([
  'engineering',
  'medical',
  'commerce',
  'humanities'
]);

const EMPTY_SCORES = Object.freeze({
  analytical: 0,
  logical: 0,
  memory: 0,
  communication: 0,
  creativity: 0
});

const EMPTY_AFFINITY = Object.freeze({
  engineering: 0,
  medical: 0,
  commerce: 0,
  humanities: 0
});

const PROFILE_RULES = [
  {
    requires: ['analytical_score', 'logical_score'],
    label: 'Analytical-Logical',
    style: 'analytical'
  },
  {
    requires: ['analytical_score', 'creativity_score'],
    label: 'Analytical-Creative',
    style: 'analytical'
  },
  {
    requires: ['logical_score', 'memory_score'],
    label: 'Logical-Retentive',
    style: 'analytical'
  },
  {
    requires: ['communication_score', 'creativity_score'],
    label: 'Creative-Communicator',
    style: 'communicative'
  },
  {
    requires: ['memory_score', 'communication_score'],
    label: 'Retentive-Communicator',
    style: 'communicative'
  },
  {
    requires: ['creativity_score', 'logical_score'],
    label: 'Creative-Reasoner',
    style: 'creative'
  },
  {
    requires: ['analytical_score'],
    label: 'Analytical Thinker',
    style: 'analytical'
  },
  {
    requires: ['communication_score'],
    label: 'Strong Communicator',
    style: 'communicative'
  },
  {
    requires: ['creativity_score'],
    label: 'Creative Mind',
    style: 'creative'
  },
  {
    requires: ['memory_score'],
    label: 'Strong Memoriser',
    style: 'retentive'
  },
  {
    requires: ['logical_score'],
    label: 'Logical Reasoner',
    style: 'analytical'
  }
];

function toScore(value) {
  const numeric = Number(value);

  return Number.isFinite(numeric)
    ? clamp(numeric, 0, 100)
    : 0;
}

async function analyze(context = {}) {
  const cognitive = context?.cognitive;

  if (!cognitive) {
    return emptyResult();
  }

  const rawScores = {};

  for (const dimension of COGNITIVE_DIMENSIONS) {
    rawScores[dimension.key] = toScore(
      cognitive[dimension.key]
    );
  }

  const strengths = [];
  const weaknesses = [];

  for (const dimension of COGNITIVE_DIMENSIONS) {
    const score = rawScores[dimension.key];

    if (score >= STRENGTH_THRESHOLD) {
      strengths.push(dimension.label);
    } else if (score <= WEAKNESS_THRESHOLD) {
      weaknesses.push(dimension.label);
    }
  }

  const {
    dominant_style,
    profile_label
  } = deriveProfile(rawScores);

  const stream_affinity =
    computeStreamAffinity(rawScores);

  return {
    scores: {
      analytical: rawScores.analytical_score,
      logical: rawScores.logical_score,
      memory: rawScores.memory_score,
      communication:
        rawScores.communication_score,
      creativity: rawScores.creativity_score
    },
    dominant_style,
    profile_label,
    strengths,
    weaknesses,
    stream_affinity
  };
}

function deriveProfile(scores) {
  for (const rule of PROFILE_RULES) {
    const matches = rule.requires.every(
      (key) => scores[key] >= STRENGTH_THRESHOLD
    );

    if (matches) {
      return {
        dominant_style: rule.style,
        profile_label: rule.label
      };
    }
  }

  return {
    dominant_style: 'balanced',
    profile_label: 'Well-Rounded'
  };
}

function computeStreamAffinity(scores) {
  const affinity = {};

  for (const stream of STREAMS) {
    let weightedSum = 0;
    let totalWeight = 0;

    for (const dimension of COGNITIVE_DIMENSIONS) {
      const weight =
        dimension.engine_weight?.[stream] || 0;

      weightedSum +=
        scores[dimension.key] * weight;

      totalWeight += weight;
    }

    affinity[stream] =
      totalWeight > 0
        ? clamp(
            round(weightedSum / totalWeight, 1),
            0,
            100
          )
        : 0;
  }

  return affinity;
}

function emptyResult() {
  return {
    scores: { ...EMPTY_SCORES },
    dominant_style: 'unknown',
    profile_label: 'Unknown',
    strengths: [],
    weaknesses: [],
    stream_affinity: { ...EMPTY_AFFINITY }
  };
}

function round(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

module.exports = {
  analyze
};