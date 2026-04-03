'use strict';

/**
 * engines/streamIntelligence.engine.js
 *
 * Final stream recommendation intelligence engine.
 * Deterministic, production-hardened.
 */

const { STREAMS } = require('../models/academic.model');

const ENGINE_VERSION = '1.1.0';

const WEIGHT = Object.freeze({
  academic: 0.5,
  cognitive: 0.3,
  activity: 0.1,
  velocity: 0.1
});

const ACTIVITY_MAX = 30;
const VELOCITY_MIN = -10;
const VELOCITY_MAX = 10;

const STREAM_ORDER = Object.freeze([
  STREAMS.ENGINEERING,
  STREAMS.MEDICAL,
  STREAMS.COMMERCE,
  STREAMS.HUMANITIES
]);

const STREAM_LABEL = Object.freeze({
  [STREAMS.ENGINEERING]: 'Computer Science',
  [STREAMS.MEDICAL]: 'Bio-Maths',
  [STREAMS.COMMERCE]: 'Commerce',
  [STREAMS.HUMANITIES]: 'Humanities'
});

async function recommend(
  context,
  academicResult,
  cognitiveResult,
  activityResult
) {
  const rawScores = {};

  for (const stream of STREAM_ORDER) {
    const academicScore =
      Number(
        academicResult?.stream_subject_scores?.[
          stream
        ]
      ) || 0;

    const cognitiveScore =
      Number(
        cognitiveResult?.stream_affinity?.[
          stream
        ]
      ) || 0;

    const activityRaw =
      Number(
        activityResult?.stream_influence?.[
          stream
        ]
      ) || 0;

    const velocity =
      Number(
        academicResult?.overall_learning_velocity
      ) || 0;

    const activityScore = clamp(
      round((activityRaw / ACTIVITY_MAX) * 100, 1),
      0,
      100
    );

    const velocityNorm = clamp(
      round(
        ((velocity - VELOCITY_MIN) /
          (VELOCITY_MAX - VELOCITY_MIN)) *
          100,
        1
      ),
      0,
      100
    );

    rawScores[stream] = round(
      academicScore * WEIGHT.academic +
        cognitiveScore * WEIGHT.cognitive +
        activityScore * WEIGHT.activity +
        velocityNorm * WEIGHT.velocity,
      1
    );
  }

  const stream_scores = {};

  for (const stream of STREAM_ORDER) {
    stream_scores[stream] = clamp(
      round(rawScores[stream], 0),
      0,
      100
    );
  }

  const ranked = [...STREAM_ORDER]
    .map((stream) => [
      stream,
      stream_scores[stream]
    ])
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];

      // deterministic tie-break by stream priority
      return (
        STREAM_ORDER.indexOf(a[0]) -
        STREAM_ORDER.indexOf(b[0])
      );
    });

  const [topStream, topScore] = ranked[0];
  const [altStream, altScore] = ranked[1] || [
    null,
    0
  ];

  const topSafe = Math.max(topScore, 1);
  const gapRatio = (topScore - altScore) / topSafe;

  const confidence = clamp(
    round(gapRatio * 100, 0),
    15,
    99
  );

  const rationale = buildRationale(
    topStream,
    altStream,
    academicResult,
    cognitiveResult,
    activityResult
  );

  return {
    recommended_stream: topStream,
    recommended_label:
      STREAM_LABEL[topStream] || topStream,
    confidence,
    alternative_stream: altStream,
    alternative_label: altStream
      ? STREAM_LABEL[altStream] || altStream
      : null,
    stream_scores,
    rationale,
    engine_version: ENGINE_VERSION
  };
}

function buildRationale(
  topStream,
  altStream,
  academic,
  cognitive,
  activity
) {
  const parts = [];

  const strengths = Object.entries(
    academic?.subject_strengths || {}
  )
    .filter(([, score]) => score >= 70)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([subject, score]) => `${subject} (${score}%)`);

  if (strengths.length) {
    parts.push(
      `strong academic performance in ${strengths.join(
        ' and '
      )}`
    );
  }

  if (cognitive?.profile_label) {
    parts.push(
      `cognitive profile (${cognitive.profile_label})`
    );
  }

  if (
    activity?.dominant_signal === topStream &&
    activity?.activity_count > 0
  ) {
    parts.push(
      `extracurricular alignment with ${
        STREAM_LABEL[topStream]
      }`
    );
  }

  const label =
    STREAM_LABEL[topStream] || topStream;

  const base = parts.length
    ? `${parts.join(
        ', '
      )} suggest a strong fit for ${label}.`
    : `Overall profile best matches ${label}.`;

  if (!altStream) return base;

  return `${base} ${
    STREAM_LABEL[altStream]
  } remains a strong alternative.`;
}

function round(value, decimals = 0) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

module.exports = {
  recommend
};