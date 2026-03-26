'use strict';

/**
 * engines/careerSuccess.engine.js
 *
 * Career Success Probability Engine (CSPE)
 *
 * Uses the student's five cognitive dimension scores to predict their
 * probability of success in a range of specific careers. Each career
 * has a competency matrix that weights the five dimensions differently.
 *
 * Formula per career:
 *   probability = Σ (student_score[dim] × career_weight[dim])
 *   Result is normalised to 0–100.
 *
 * Input (context):
 *   context.cognitive — { analytical_score, logical_score, memory_score,
 *                         communication_score, creativity_score }
 *   recommendedStream — string  ('engineering' | 'medical' | 'commerce' | 'humanities')
 *                       Used to surface the most relevant careers first.
 *
 * Output:
 * {
 *   top_careers: [
 *     { career: 'Software Engineer', probability: 82 },
 *     { career: 'AI Engineer',       probability: 78 },
 *     ...
 *   ],
 *   all_careers: [ ... ],   // full ranked list
 *   engine_version: '1.0.0',
 * }
 */

const ENGINE_VERSION = '1.0.0';

// ─── Career Competency Matrix ─────────────────────────────────────────────────
//
// Each career defines five weights that sum to 1.0.
// Weights reflect how heavily each cognitive dimension influences success.
//
// Dimensions:
//   analytical_weight    — data analysis, problem decomposition
//   logical_weight       — reasoning, systematic thinking
//   memory_weight        — retention of facts, protocols, code patterns
//   communication_weight — client interaction, collaboration, writing
//   creativity_weight    — design thinking, innovation, novel solutions
//
// stream field: primary stream(s) this career is associated with.
//   Used to surface stream-relevant careers at the top of results.

const CAREER_MATRIX = [
  // ── Engineering / Technology ──────────────────────────────────────────────
  {
    career: 'Software Engineer',
    stream: ['engineering'],
    analytical_weight:    0.35,
    logical_weight:       0.35,
    memory_weight:        0.10,
    communication_weight: 0.10,
    creativity_weight:    0.10,
  },
  {
    career: 'AI / ML Engineer',
    stream: ['engineering'],
    analytical_weight:    0.40,
    logical_weight:       0.30,
    memory_weight:        0.10,
    communication_weight: 0.05,
    creativity_weight:    0.15,
  },
  {
    career: 'Data Scientist',
    stream: ['engineering', 'commerce'],
    analytical_weight:    0.40,
    logical_weight:       0.25,
    memory_weight:        0.15,
    communication_weight: 0.10,
    creativity_weight:    0.10,
  },
  {
    career: 'Cybersecurity Specialist',
    stream: ['engineering'],
    analytical_weight:    0.30,
    logical_weight:       0.35,
    memory_weight:        0.20,
    communication_weight: 0.05,
    creativity_weight:    0.10,
  },
  {
    career: 'Systems Architect',
    stream: ['engineering'],
    analytical_weight:    0.30,
    logical_weight:       0.35,
    memory_weight:        0.10,
    communication_weight: 0.15,
    creativity_weight:    0.10,
  },

  // ── Medical / Science ─────────────────────────────────────────────────────
  {
    career: 'Doctor (MBBS / MD)',
    stream: ['medical'],
    analytical_weight:    0.20,
    logical_weight:       0.20,
    memory_weight:        0.35,
    communication_weight: 0.15,
    creativity_weight:    0.10,
  },
  {
    career: 'Biomedical Researcher',
    stream: ['medical'],
    analytical_weight:    0.35,
    logical_weight:       0.25,
    memory_weight:        0.20,
    communication_weight: 0.10,
    creativity_weight:    0.10,
  },
  {
    career: 'Pharmacist',
    stream: ['medical'],
    analytical_weight:    0.20,
    logical_weight:       0.20,
    memory_weight:        0.40,
    communication_weight: 0.15,
    creativity_weight:    0.05,
  },

  // ── Commerce / Business ────────────────────────────────────────────────────
  {
    career: 'Chartered Accountant',
    stream: ['commerce'],
    analytical_weight:    0.30,
    logical_weight:       0.30,
    memory_weight:        0.25,
    communication_weight: 0.10,
    creativity_weight:    0.05,
  },
  {
    career: 'Investment Banker',
    stream: ['commerce'],
    analytical_weight:    0.35,
    logical_weight:       0.25,
    memory_weight:        0.15,
    communication_weight: 0.20,
    creativity_weight:    0.05,
  },
  {
    career: 'Entrepreneur',
    stream: ['commerce', 'engineering', 'humanities'],
    analytical_weight:    0.20,
    logical_weight:       0.15,
    memory_weight:        0.10,
    communication_weight: 0.25,
    creativity_weight:    0.30,
  },
  {
    career: 'Marketing Manager',
    stream: ['commerce'],
    analytical_weight:    0.20,
    logical_weight:       0.15,
    memory_weight:        0.10,
    communication_weight: 0.30,
    creativity_weight:    0.25,
  },

  // ── Law / Humanities ──────────────────────────────────────────────────────
  {
    career: 'Lawyer',
    stream: ['humanities'],
    analytical_weight:    0.25,
    logical_weight:       0.30,
    memory_weight:        0.20,
    communication_weight: 0.20,
    creativity_weight:    0.05,
  },
  {
    career: 'Journalist / Writer',
    stream: ['humanities'],
    analytical_weight:    0.15,
    logical_weight:       0.10,
    memory_weight:        0.15,
    communication_weight: 0.30,
    creativity_weight:    0.30,
  },
  {
    career: 'UX Designer',
    stream: ['humanities', 'engineering'],
    analytical_weight:    0.15,
    logical_weight:       0.15,
    memory_weight:        0.10,
    communication_weight: 0.25,
    creativity_weight:    0.35,
  },
  {
    career: 'Civil Services (IAS/IPS)',
    stream: ['humanities', 'commerce'],
    analytical_weight:    0.25,
    logical_weight:       0.25,
    memory_weight:        0.25,
    communication_weight: 0.20,
    creativity_weight:    0.05,
  },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Compute career success probabilities for a student.
 *
 * @param {object} context          — full orchestrator context
 * @param {string} recommendedStream — output of StreamIntelligenceEngine
 * @returns {CareerSuccessResult}
 */
async function analyze(context, recommendedStream) {
  const cog = context.cognitive;

  if (!cog) {
    return _emptyResult();
  }

  // ── 1. Extract and normalise student cognitive scores ─────────────────────
  const student = {
    analytical:    _clamp(Number(cog.analytical_score)    || 0, 0, 100),
    logical:       _clamp(Number(cog.logical_score)       || 0, 0, 100),
    memory:        _clamp(Number(cog.memory_score)        || 0, 0, 100),
    communication: _clamp(Number(cog.communication_score) || 0, 0, 100),
    creativity:    _clamp(Number(cog.creativity_score)    || 0, 0, 100),
  };

  // ── 2. Score each career ──────────────────────────────────────────────────
  const scored = CAREER_MATRIX.map(career => {
    const raw =
      (student.analytical    * career.analytical_weight)    +
      (student.logical       * career.logical_weight)       +
      (student.memory        * career.memory_weight)        +
      (student.communication * career.communication_weight) +
      (student.creativity    * career.creativity_weight);

    // raw is already 0–100 because student scores are 0–100 and weights sum to 1
    const probability = _round(_clamp(raw, 0, 100), 0);

    return {
      career:      career.career,
      probability,
      stream:      career.stream,
    };
  });

  // ── 3. Sort by probability descending ────────────────────────────────────
  const allCareers = scored.sort((a, b) => b.probability - a.probability);

  // ── 4. Surface stream-relevant careers first ─────────────────────────────
  //    Top 5 from the recommended stream, then fill with top overall.
  const streamCareers  = allCareers.filter(c => c.stream.includes(recommendedStream));
  const otherCareers   = allCareers.filter(c => !c.stream.includes(recommendedStream));

  // Merge: stream careers first, then others, deduplicate by career name
  const merged = [...streamCareers, ...otherCareers];
  const seen   = new Set();
  const ranked = [];
  for (const c of merged) {
    if (!seen.has(c.career)) {
      seen.add(c.career);
      ranked.push({ career: c.career, probability: c.probability });
    }
  }

  const topCareers = ranked.slice(0, 5);

  return {
    top_careers:    topCareers,
    all_careers:    allCareers.map(c => ({ career: c.career, probability: c.probability })),
    engine_version: ENGINE_VERSION,
  };
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function _emptyResult() {
  return {
    top_careers:    [],
    all_careers:    [],
    engine_version: ENGINE_VERSION,
  };
}

function _clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function _round(n, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

module.exports = { analyze, CAREER_MATRIX };









