'use strict';

/**
 * engines/activityAnalyzer.engine.js
 *
 * Translates extracurricular activities into per-stream influence scores.
 *
 * Each activity is matched against ACTIVITY_MAP (keyword → stream boosts).
 * The activity_level multiplies the boost (national/international = stronger signal).
 *
 * Input (context.activities):
 *   [{ activity_name, activity_level }]
 *
 * Output:
 * {
 *   matched_signals: [
 *     { activity: 'Coding / Programming', stream: 'engineering', boost: 12, level: 'advanced' },
 *     ...
 *   ],
 *   stream_influence: { engineering: 22, medical: 0, commerce: 8, humanities: 5 },
 *   dominant_signal:  'engineering',
 *   activity_count:   4,
 * }
 */

// ─── Activity → stream boost map ─────────────────────────────────────────────
// keyword matching is case-insensitive substring.
// base_boost: base points added to that stream (0–15 scale)
// Multiple matches for the same stream are summed then capped.

const ACTIVITY_MAP = [
  // Engineering / CS
  { keywords: ['coding', 'programming'],          stream: 'engineering', base_boost: 14 },
  { keywords: ['robotics'],                        stream: 'engineering', base_boost: 14 },
  { keywords: ['app development', 'app dev'],      stream: 'engineering', base_boost: 12 },
  { keywords: ['cybersecurity'],                   stream: 'engineering', base_boost: 11 },
  { keywords: ['ai', 'machine learning', 'ml'],    stream: 'engineering', base_boost: 13 },
  { keywords: ['electronics', 'circuits'],         stream: 'engineering', base_boost: 10 },
  { keywords: ['science olympiad', 'science comp'],stream: 'engineering', base_boost:  9 },
  { keywords: ['math competition', 'math olympi'], stream: 'engineering', base_boost:  9 },
  { keywords: ['physics'],                         stream: 'engineering', base_boost:  8 },

  // Medical / Bio
  { keywords: ['biology club', 'bio club'],        stream: 'medical', base_boost: 13 },
  { keywords: ['first aid', 'red cross'],          stream: 'medical', base_boost: 10 },
  { keywords: ['health camp', 'medical camp'],     stream: 'medical', base_boost: 10 },
  { keywords: ['anatomy', 'dissection'],           stream: 'medical', base_boost: 12 },
  { keywords: ['psychology'],                      stream: 'medical', base_boost:  7 },
  { keywords: ['chemistry olymp'],                 stream: 'medical', base_boost:  9 },
  { keywords: ['ngо volunteer', 'community serv'], stream: 'medical', base_boost:  6 },

  // Commerce / Business
  { keywords: ['business club', 'business comp'],  stream: 'commerce', base_boost: 14 },
  { keywords: ['entrepreneurship', 'startup'],     stream: 'commerce', base_boost: 14 },
  { keywords: ['finance', 'investment'],           stream: 'commerce', base_boost: 12 },
  { keywords: ['economics'],                       stream: 'commerce', base_boost: 11 },
  { keywords: ['marketing'],                       stream: 'commerce', base_boost: 11 },
  { keywords: ['student council'],                 stream: 'commerce', base_boost:  8 },
  { keywords: ['sales', 'trading'],                stream: 'commerce', base_boost: 10 },

  // Humanities
  { keywords: ['debate', 'mun', 'model un'],       stream: 'humanities', base_boost: 14 },
  { keywords: ['public speaking'],                 stream: 'humanities', base_boost: 12 },
  { keywords: ['creative writing', 'writing'],     stream: 'humanities', base_boost: 13 },
  { keywords: ['journalism', 'newspaper'],         stream: 'humanities', base_boost: 12 },
  { keywords: ['theatre', 'drama', 'acting'],      stream: 'humanities', base_boost: 10 },
  { keywords: ['philosophy'],                      stream: 'humanities', base_boost: 11 },
  { keywords: ['history', 'geography club'],       stream: 'humanities', base_boost:  9 },
  { keywords: ['teaching', 'tutoring'],            stream: 'humanities', base_boost:  8 },
  { keywords: ['social work'],                     stream: 'humanities', base_boost:  7 },

  // Arts (split signal — humanities primary, small engineering secondary for design)
  { keywords: ['drawing', 'painting', 'fine art'], stream: 'humanities', base_boost:  9 },
  { keywords: ['photography'],                     stream: 'humanities', base_boost:  8 },
  { keywords: ['music'],                           stream: 'humanities', base_boost:  7 },
  { keywords: ['dance'],                           stream: 'humanities', base_boost:  7 },
];

// Activity level multipliers — higher competitive level = stronger signal
const LEVEL_MULTIPLIER = {
  beginner:      0.6,
  intermediate:  0.8,
  advanced:      1.0,
  national:      1.3,
  international: 1.6,
};

// Cap on total influence per stream (prevents one very active student dominating)
const MAX_STREAM_INFLUENCE = 30;

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * @param {object} context  — { activities: [], ... }
 * @returns {Promise<ActivityAnalysisResult>}
 */
async function analyze(context) {
  const { activities = [] } = context;

  if (!activities.length) {
    return _emptyResult();
  }

  const matched_signals  = [];
  const raw_influence    = { engineering: 0, medical: 0, commerce: 0, humanities: 0 };

  for (const activity of activities) {
    const name  = (activity.activity_name  || '').toLowerCase();
    const level = (activity.activity_level || 'beginner').toLowerCase();
    const multiplier = LEVEL_MULTIPLIER[level] ?? 0.6;

    for (const rule of ACTIVITY_MAP) {
      const hit = rule.keywords.some(kw => name.includes(kw));
      if (!hit) continue;

      const boost = _round(rule.base_boost * multiplier, 1);
      raw_influence[rule.stream] = (raw_influence[rule.stream] || 0) + boost;

      matched_signals.push({
        activity: activity.activity_name,
        stream:   rule.stream,
        boost,
        level:    activity.activity_level,
      });

      // Only count the first matching rule per activity to avoid double-counting
      break;
    }
  }

  // Cap each stream influence
  const stream_influence = {};
  for (const [stream, val] of Object.entries(raw_influence)) {
    stream_influence[stream] = _clamp(_round(val, 1), 0, MAX_STREAM_INFLUENCE);
  }

  // Dominant signal = stream with highest influence (null if all zero)
  const dominant_signal = _dominantStream(stream_influence);

  return {
    matched_signals,
    stream_influence,
    dominant_signal,
    activity_count: activities.length,
  };
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function _dominantStream(influence) {
  let best = null;
  let max  = 0;
  for (const [stream, val] of Object.entries(influence)) {
    if (val > max) { max = val; best = stream; }
  }
  return best;
}

function _emptyResult() {
  return {
    matched_signals:  [],
    stream_influence: { engineering: 0, medical: 0, commerce: 0, humanities: 0 },
    dominant_signal:  null,
    activity_count:   0,
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








