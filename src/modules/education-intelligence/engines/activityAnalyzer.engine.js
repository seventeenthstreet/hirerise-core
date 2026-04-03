'use strict';

/**
 * engines/activityAnalyzer.engine.js
 *
 * Pure extracurricular signal intelligence engine.
 * Deterministic, side-effect free, production hardened.
 */

const STREAMS = Object.freeze([
  'engineering',
  'medical',
  'commerce',
  'humanities'
]);

const ACTIVITY_MAP = Object.freeze([
  { keywords: ['coding', 'programming'], stream: 'engineering', base_boost: 14 },
  { keywords: ['robotics'], stream: 'engineering', base_boost: 14 },
  { keywords: ['app development', 'app dev'], stream: 'engineering', base_boost: 12 },
  { keywords: ['cybersecurity'], stream: 'engineering', base_boost: 11 },
  { keywords: ['ai', 'machine learning', 'ml'], stream: 'engineering', base_boost: 13 },
  { keywords: ['electronics', 'circuits'], stream: 'engineering', base_boost: 10 },
  { keywords: ['science olympiad', 'science comp'], stream: 'engineering', base_boost: 9 },
  { keywords: ['math competition', 'math olympi'], stream: 'engineering', base_boost: 9 },
  { keywords: ['physics'], stream: 'engineering', base_boost: 8 },

  { keywords: ['biology club', 'bio club'], stream: 'medical', base_boost: 13 },
  { keywords: ['first aid', 'red cross'], stream: 'medical', base_boost: 10 },
  { keywords: ['health camp', 'medical camp'], stream: 'medical', base_boost: 10 },
  { keywords: ['anatomy', 'dissection'], stream: 'medical', base_boost: 12 },
  { keywords: ['psychology'], stream: 'medical', base_boost: 7 },
  { keywords: ['chemistry olymp'], stream: 'medical', base_boost: 9 },
  { keywords: ['ngo volunteer', 'community serv'], stream: 'medical', base_boost: 6 },

  { keywords: ['business club', 'business comp'], stream: 'commerce', base_boost: 14 },
  { keywords: ['entrepreneurship', 'startup'], stream: 'commerce', base_boost: 14 },
  { keywords: ['finance', 'investment'], stream: 'commerce', base_boost: 12 },
  { keywords: ['economics'], stream: 'commerce', base_boost: 11 },
  { keywords: ['marketing'], stream: 'commerce', base_boost: 11 },
  { keywords: ['student council'], stream: 'commerce', base_boost: 8 },
  { keywords: ['sales', 'trading'], stream: 'commerce', base_boost: 10 },

  { keywords: ['debate', 'mun', 'model un'], stream: 'humanities', base_boost: 14 },
  { keywords: ['public speaking'], stream: 'humanities', base_boost: 12 },
  { keywords: ['creative writing', 'writing'], stream: 'humanities', base_boost: 13 },
  { keywords: ['journalism', 'newspaper'], stream: 'humanities', base_boost: 12 },
  { keywords: ['theatre', 'drama', 'acting'], stream: 'humanities', base_boost: 10 },
  { keywords: ['philosophy'], stream: 'humanities', base_boost: 11 },
  { keywords: ['history', 'geography club'], stream: 'humanities', base_boost: 9 },
  { keywords: ['teaching', 'tutoring'], stream: 'humanities', base_boost: 8 },
  { keywords: ['social work'], stream: 'humanities', base_boost: 7 },

  { keywords: ['drawing', 'painting', 'fine art'], stream: 'humanities', base_boost: 9 },
  { keywords: ['photography'], stream: 'humanities', base_boost: 8 },
  { keywords: ['music'], stream: 'humanities', base_boost: 7 },
  { keywords: ['dance'], stream: 'humanities', base_boost: 7 }
]);

const LEVEL_MULTIPLIER = Object.freeze({
  beginner: 0.6,
  intermediate: 0.8,
  advanced: 1.0,
  national: 1.3,
  international: 1.6
});

const MAX_STREAM_INFLUENCE = 30;

async function analyze(context = {}) {
  const activities = Array.isArray(context.activities)
    ? context.activities
    : [];

  if (!activities.length) {
    return createEmptyResult();
  }

  const matched_signals = [];
  const raw_influence = createZeroInfluence();
  const seenActivities = new Set();

  for (const activity of activities) {
    const rawName = String(activity?.activity_name || '').trim();
    if (!rawName) continue;

    const normalizedName = rawName.toLowerCase();

    // prevent duplicate inflation
    if (seenActivities.has(normalizedName)) continue;
    seenActivities.add(normalizedName);

    const level = String(
      activity?.activity_level || 'beginner'
    ).toLowerCase();

    const multiplier =
      LEVEL_MULTIPLIER[level] ?? LEVEL_MULTIPLIER.beginner;

    for (const rule of ACTIVITY_MAP) {
      const hit = rule.keywords.some((keyword) =>
        normalizedName.includes(keyword)
      );

      if (!hit) continue;

      const boost = round(
        rule.base_boost * multiplier,
        1
      );

      raw_influence[rule.stream] += boost;

      matched_signals.push({
        activity: rawName,
        stream: rule.stream,
        boost,
        level: activity?.activity_level || 'beginner'
      });

      break;
    }
  }

  const stream_influence = {};

  for (const stream of STREAMS) {
    stream_influence[stream] = clamp(
      round(raw_influence[stream], 1),
      0,
      MAX_STREAM_INFLUENCE
    );
  }

  return {
    matched_signals,
    stream_influence,
    dominant_signal: getDominantStream(stream_influence),
    activity_count: seenActivities.size
  };
}

function createZeroInfluence() {
  return {
    engineering: 0,
    medical: 0,
    commerce: 0,
    humanities: 0
  };
}

function getDominantStream(influence) {
  let best = null;
  let bestValue = -1;

  for (const stream of STREAMS) {
    const value = influence[stream] || 0;

    // deterministic tie-breaking by STREAMS order
    if (value > bestValue) {
      bestValue = value;
      best = stream;
    }
  }

  return bestValue > 0 ? best : null;
}

function createEmptyResult() {
  return {
    matched_signals: [],
    stream_influence: createZeroInfluence(),
    dominant_signal: null,
    activity_count: 0
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