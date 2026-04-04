'use strict';

/**
 * src/modules/skill-evolution/engines/skillRecommendation.engine.js
 *
 * Skill Evolution Engine (SEE)
 *
 * Supabase Migration Relevance:
 * - No Firebase dependency existed
 * - Optimized for row-based SQL-fed datasets
 * - Safer null handling for DB-returned arrays/objects
 * - Better performance using Map-based demand lookups
 * - Immutable static matrices for runtime safety
 * - Cleaner modular scoring pipeline
 */

const ENGINE_VERSION = '2.0.0';

// ─────────────────────────────────────────────────────────────────────────────
// Static Skill Matrices
// ─────────────────────────────────────────────────────────────────────────────

const CAREER_SKILL_MATRIX = Object.freeze({
  'Software Engineer': {
    stream: 'engineering',
    skills: [
      { name: 'Python', relevance: 0.97, order: 1, rationale: 'Primary language for backend, ML, and scripting' },
      { name: 'Data Structures', relevance: 0.95, order: 2, rationale: 'Core CS fundamental for technical interviews' },
      { name: 'System Design', relevance: 0.92, order: 4, rationale: 'Required for senior engineering roles' },
      { name: 'SQL', relevance: 0.88, order: 3, rationale: 'Essential for data handling in every application' },
      { name: 'JavaScript', relevance: 0.85, order: 5, rationale: 'Full-stack development capability' },
      { name: 'Docker', relevance: 0.80, order: 6, rationale: 'Modern deployment and containerisation' },
      { name: 'AWS', relevance: 0.78, order: 7, rationale: 'Cloud infrastructure skills in high demand' },
    ],
  },
  'AI / ML Engineer': {
    stream: 'engineering',
    skills: [
      { name: 'Python', relevance: 0.99, order: 1, rationale: 'The language of ML and AI development' },
      { name: 'Machine Learning', relevance: 0.98, order: 3, rationale: 'Core domain expertise for AI engineering' },
      { name: 'Data Structures', relevance: 0.90, order: 2, rationale: 'Foundation required before advanced ML' },
      { name: 'TensorFlow', relevance: 0.88, order: 4, rationale: 'Industry-standard ML framework' },
      { name: 'NLP', relevance: 0.82, order: 5, rationale: 'Fastest growing AI sub-domain' },
      { name: 'SQL', relevance: 0.78, order: 3, rationale: 'Essential for data pipeline work' },
      { name: 'AWS', relevance: 0.75, order: 6, rationale: 'Cloud ML deployment infrastructure' },
    ],
  },
});

const STREAM_SKILLS_FALLBACK = Object.freeze({
  engineering: [
    { name: 'Python', relevance: 0.95, order: 1, rationale: 'Core programming language for engineering' },
    { name: 'Data Structures', relevance: 0.90, order: 2, rationale: 'CS fundamentals' },
    { name: 'SQL', relevance: 0.85, order: 3, rationale: 'Data management' },
    { name: 'System Design', relevance: 0.80, order: 4, rationale: 'Architecture thinking' },
    { name: 'AWS', relevance: 0.75, order: 5, rationale: 'Cloud deployment' },
  ],
  medical: [
    { name: 'Clinical Diagnosis', relevance: 0.95, order: 1, rationale: 'Core clinical skill' },
    { name: 'Patient Care', relevance: 0.90, order: 2, rationale: 'Interpersonal care' },
    { name: 'Data Analysis', relevance: 0.70, order: 3, rationale: 'Evidence-based decisions' },
    { name: 'Communication', relevance: 0.88, order: 2, rationale: 'Patient communication' },
  ],
  commerce: [
    { name: 'Financial Modeling', relevance: 0.90, order: 1, rationale: 'Core finance skill' },
    { name: 'Excel', relevance: 0.85, order: 2, rationale: 'Finance tool proficiency' },
    { name: 'Communication', relevance: 0.80, order: 2, rationale: 'Business communication' },
    { name: 'Data Analysis', relevance: 0.75, order: 3, rationale: 'Market analysis' },
    { name: 'Digital Marketing', relevance: 0.68, order: 4, rationale: 'Digital business skills' },
  ],
  humanities: [
    { name: 'Communication', relevance: 0.95, order: 1, rationale: 'Core humanities skill' },
    { name: 'Digital Marketing', relevance: 0.78, order: 2, rationale: 'Digital presence' },
    { name: 'Data Analysis', relevance: 0.65, order: 3, rationale: 'Research and insight' },
    { name: 'Figma', relevance: 0.60, order: 4, rationale: 'Visual communication' },
  ],
});

const COGNITIVE_SKILL_AFFINITY = Object.freeze({
  analytical: ['Python', 'Data Analysis', 'Machine Learning', 'SQL', 'Financial Modeling'],
  logical: ['Data Structures', 'System Design', 'Python', 'Network Security', 'SQL'],
  memory: ['Clinical Diagnosis', 'Medical Research', 'Patient Care', 'Excel'],
  communication: ['Communication', 'Digital Marketing', 'Figma', 'Agile'],
  creativity: ['Figma', 'Digital Marketing', 'NLP', 'Machine Learning', 'JavaScript'],
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getOrderFactor(order) {
  if (order === 1) return 1.06;
  if (order === 2) return 1.03;
  return 1.0;
}

function buildDemandMap(marketDemand) {
  const demandMap = new Map();

  for (const row of Array.isArray(marketDemand) ? marketDemand : []) {
    if (!row?.skill_name) continue;

    demandMap.set(row.skill_name, {
      demand_score: Number(row.demand_score) || 70,
      growth_rate: Number(row.growth_rate) || 0.10,
    });
  }

  return demandMap;
}

function computeCognitiveBoost(skillName, cognitiveScores, strengths) {
  let boost = 0;

  for (const [dimension, skillList] of Object.entries(COGNITIVE_SKILL_AFFINITY)) {
    if (!skillList.includes(skillName)) continue;

    const scoreKey = `${dimension}_score`;
    const score = Number(cognitiveScores?.[scoreKey]) || 50;

    boost += (score / 100) * 4;
  }

  const normalizedStrengths = new Set(
    Array.isArray(strengths)
      ? strengths.map((s) => String(s).toLowerCase())
      : []
  );

  for (const strength of normalizedStrengths) {
    if (COGNITIVE_SKILL_AFFINITY[strength]?.includes(skillName)) {
      boost += 3;
      break;
    }
  }

  return boost;
}

function selectSkillSet(topCareer, recommendedStream) {
  const careerEntry = CAREER_SKILL_MATRIX[topCareer];

  if (careerEntry?.skills?.length) {
    return {
      careerEntry,
      skills: careerEntry.skills,
    };
  }

  return {
    careerEntry: null,
    skills:
      STREAM_SKILLS_FALLBACK[recommendedStream] ||
      STREAM_SKILLS_FALLBACK.engineering,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Engine
// ─────────────────────────────────────────────────────────────────────────────

function recommend({
  careerResult = {},
  streamResult = {},
  cognitiveResult = {},
  marketDemand = [],
}) {
  const topCareer =
    careerResult?.top_careers?.[0]?.career || 'Software Engineer';

  const recommendedStream =
    streamResult?.recommended_stream || 'engineering';

  const cognitiveScores = cognitiveResult?.scores || {};
  const strengths = cognitiveResult?.strengths || [];

  const demandMap = buildDemandMap(marketDemand);

  const { careerEntry, skills } = selectSkillSet(
    topCareer,
    recommendedStream
  );

  const graphPathStrength = careerEntry ? 0.9 : 0.75;

  const scored = skills.map((skill) => {
    const lmi =
      demandMap.get(skill.name) || {
        demand_score: 70,
        growth_rate: 0.1,
      };

    const rawImpact =
      (lmi.demand_score / 100) *
      skill.relevance *
      graphPathStrength *
      100;

    const orderedImpact = rawImpact * getOrderFactor(skill.order);

    const cognitiveBoost = computeCognitiveBoost(
      skill.name,
      cognitiveScores,
      strengths
    );

    const impact = Math.min(
      100,
      Math.round(orderedImpact + cognitiveBoost)
    );

    return {
      skill: skill.name,
      impact,
      demand_score: lmi.demand_score,
      career_relevance: skill.relevance,
      growth_rate: lmi.growth_rate,
      learning_order: skill.order,
      rationale: skill.rationale,
    };
  });

  const deduped = [];
  const seen = new Set();

  for (const row of scored.sort((a, b) => b.impact - a.impact)) {
    if (seen.has(row.skill)) continue;
    seen.add(row.skill);
    deduped.push(row);
  }

  const roadmap = [...deduped]
    .sort((a, b) => {
      const diff = a.learning_order - b.learning_order;
      return diff !== 0 ? diff : b.impact - a.impact;
    })
    .slice(0, 5)
    .map((row, index) => ({
      step: index + 1,
      skill: row.skill,
      impact: row.impact,
      rationale: row.rationale,
    }));

  return {
    top_career: topCareer,
    recommended_stream: recommendedStream,
    skills: deduped.slice(0, 8),
    roadmap,
    engine_version: ENGINE_VERSION,
  };
}

module.exports = {
  recommend,
};