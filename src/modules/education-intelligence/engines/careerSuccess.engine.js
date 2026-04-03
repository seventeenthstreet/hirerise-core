'use strict';

/**
 * engines/careerSuccess.engine.js
 *
 * Career Success Probability Engine (CSPE)
 * Deterministic, production-hardened ranking engine.
 */

const ENGINE_VERSION = '1.1.0';

const VALID_STREAMS = new Set([
  'engineering',
  'medical',
  'commerce',
  'humanities'
]);

const CAREER_MATRIX = [
  {
    career: 'Software Engineer',
    stream: ['engineering'],
    analytical_weight: 0.35,
    logical_weight: 0.35,
    memory_weight: 0.10,
    communication_weight: 0.10,
    creativity_weight: 0.10
  },
  {
    career: 'AI / ML Engineer',
    stream: ['engineering'],
    analytical_weight: 0.40,
    logical_weight: 0.30,
    memory_weight: 0.10,
    communication_weight: 0.05,
    creativity_weight: 0.15
  },
  {
    career: 'Data Scientist',
    stream: ['engineering', 'commerce'],
    analytical_weight: 0.40,
    logical_weight: 0.25,
    memory_weight: 0.15,
    communication_weight: 0.10,
    creativity_weight: 0.10
  },
  {
    career: 'Cybersecurity Specialist',
    stream: ['engineering'],
    analytical_weight: 0.30,
    logical_weight: 0.35,
    memory_weight: 0.20,
    communication_weight: 0.05,
    creativity_weight: 0.10
  },
  {
    career: 'Systems Architect',
    stream: ['engineering'],
    analytical_weight: 0.30,
    logical_weight: 0.35,
    memory_weight: 0.10,
    communication_weight: 0.15,
    creativity_weight: 0.10
  },
  {
    career: 'Doctor (MBBS / MD)',
    stream: ['medical'],
    analytical_weight: 0.20,
    logical_weight: 0.20,
    memory_weight: 0.35,
    communication_weight: 0.15,
    creativity_weight: 0.10
  },
  {
    career: 'Biomedical Researcher',
    stream: ['medical'],
    analytical_weight: 0.35,
    logical_weight: 0.25,
    memory_weight: 0.20,
    communication_weight: 0.10,
    creativity_weight: 0.10
  },
  {
    career: 'Pharmacist',
    stream: ['medical'],
    analytical_weight: 0.20,
    logical_weight: 0.20,
    memory_weight: 0.40,
    communication_weight: 0.15,
    creativity_weight: 0.05
  },
  {
    career: 'Chartered Accountant',
    stream: ['commerce'],
    analytical_weight: 0.30,
    logical_weight: 0.30,
    memory_weight: 0.25,
    communication_weight: 0.10,
    creativity_weight: 0.05
  },
  {
    career: 'Investment Banker',
    stream: ['commerce'],
    analytical_weight: 0.35,
    logical_weight: 0.25,
    memory_weight: 0.15,
    communication_weight: 0.20,
    creativity_weight: 0.05
  },
  {
    career: 'Entrepreneur',
    stream: ['commerce', 'engineering', 'humanities'],
    analytical_weight: 0.20,
    logical_weight: 0.15,
    memory_weight: 0.10,
    communication_weight: 0.25,
    creativity_weight: 0.30
  },
  {
    career: 'Marketing Manager',
    stream: ['commerce'],
    analytical_weight: 0.20,
    logical_weight: 0.15,
    memory_weight: 0.10,
    communication_weight: 0.30,
    creativity_weight: 0.25
  },
  {
    career: 'Lawyer',
    stream: ['humanities'],
    analytical_weight: 0.25,
    logical_weight: 0.30,
    memory_weight: 0.20,
    communication_weight: 0.20,
    creativity_weight: 0.05
  },
  {
    career: 'Journalist / Writer',
    stream: ['humanities'],
    analytical_weight: 0.15,
    logical_weight: 0.10,
    memory_weight: 0.15,
    communication_weight: 0.30,
    creativity_weight: 0.30
  },
  {
    career: 'UX Designer',
    stream: ['humanities', 'engineering'],
    analytical_weight: 0.15,
    logical_weight: 0.15,
    memory_weight: 0.10,
    communication_weight: 0.25,
    creativity_weight: 0.35
  },
  {
    career: 'Civil Services (IAS/IPS)',
    stream: ['humanities', 'commerce'],
    analytical_weight: 0.25,
    logical_weight: 0.25,
    memory_weight: 0.25,
    communication_weight: 0.20,
    creativity_weight: 0.05
  }
];

function toScore(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? clamp(numeric, 0, 100)
    : 0;
}

async function analyze(context = {}, recommendedStream) {
  const cognitive = context?.cognitive;

  if (!cognitive) {
    return emptyResult();
  }

  const normalizedStream = VALID_STREAMS.has(
    recommendedStream
  )
    ? recommendedStream
    : null;

  const student = {
    analytical: toScore(cognitive.analytical_score),
    logical: toScore(cognitive.logical_score),
    memory: toScore(cognitive.memory_score),
    communication: toScore(
      cognitive.communication_score
    ),
    creativity: toScore(cognitive.creativity_score)
  };

  const scored = CAREER_MATRIX.map((career) => {
    const raw =
      student.analytical *
        career.analytical_weight +
      student.logical *
        career.logical_weight +
      student.memory * career.memory_weight +
      student.communication *
        career.communication_weight +
      student.creativity *
        career.creativity_weight;

    return {
      career: career.career,
      probability: round(clamp(raw, 0, 100), 0),
      stream: career.stream
    };
  }).sort((a, b) => {
    if (b.probability !== a.probability) {
      return b.probability - a.probability;
    }

    return a.career.localeCompare(b.career);
  });

  const streamCareers = normalizedStream
    ? scored.filter((c) =>
        c.stream.includes(normalizedStream)
      )
    : [];

  const otherCareers = normalizedStream
    ? scored.filter(
        (c) => !c.stream.includes(normalizedStream)
      )
    : scored;

  const seen = new Set();
  const ranked = [];

  for (const career of [
    ...streamCareers,
    ...otherCareers
  ]) {
    if (seen.has(career.career)) continue;

    seen.add(career.career);
    ranked.push({
      career: career.career,
      probability: career.probability
    });
  }

  return {
    top_careers: ranked.slice(0, 5),
    all_careers: scored.map((c) => ({
      career: c.career,
      probability: c.probability
    })),
    engine_version: ENGINE_VERSION
  };
}

function emptyResult() {
  return {
    top_careers: [],
    all_careers: [],
    engine_version: ENGINE_VERSION
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, decimals = 0) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

module.exports = {
  analyze,
  CAREER_MATRIX
};