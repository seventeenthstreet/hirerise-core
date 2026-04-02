'use strict';

const logger = require('../../utils/logger');

const SKILL_DEFINITIONS = [
  { keyword: 'python', weight: 3 },
  { keyword: 'javascript', weight: 3 },
  { keyword: 'typescript', weight: 3 },
  { keyword: 'java', weight: 3 },
  { keyword: 'react', weight: 3 },
  { keyword: 'node', weight: 3 },
  { keyword: 'sql', weight: 3 },
  { keyword: 'postgresql', weight: 3, aliases: ['postgres'] },
  { keyword: 'mongodb', weight: 3 },
  { keyword: 'docker', weight: 3 },
  { keyword: 'kubernetes', weight: 4 },
  { keyword: 'aws', weight: 4 },
  { keyword: 'graphql', weight: 3 },
  { keyword: 'machine learning', weight: 4 },
  { keyword: 'power bi', weight: 2 },
  { keyword: 'tableau', weight: 2 },
  { keyword: 'communication', weight: 1 },
  { keyword: 'leadership', weight: 1 },
  { keyword: 'problem solving', weight: 1 },
];

function normalizeText(text) {
  return String(text || '').toLowerCase();
}

function extractKeywords(text) {
  const lower = normalizeText(text);
  const matched = [];

  for (const skill of SKILL_DEFINITIONS) {
    const variants = [skill.keyword, ...(skill.aliases || [])];

    const hasMatch = variants.some((variant) =>
      lower.includes(variant.toLowerCase())
    );

    if (hasMatch) matched.push(skill);
  }

  return matched;
}

function scoreMatch(resumeSkills, jdSkills) {
  if (!jdSkills.length) return 50;

  const totalWeight = jdSkills.reduce(
    (sum, skill) => sum + skill.weight,
    0
  );

  const matchedWeight = jdSkills
    .filter((jdSkill) =>
      resumeSkills.some((r) => r.keyword === jdSkill.keyword)
    )
    .reduce((sum, skill) => sum + skill.weight, 0);

  return Math.round((matchedWeight / totalWeight) * 100);
}

function runJobMatchFree({ resumeText, jobDescription }) {
  logger.debug('[JobMatchFreeEngine] Running weighted keyword match');

  const resumeSkills = extractKeywords(resumeText);
  const jdSkills = extractKeywords(jobDescription);

  const matchScore = scoreMatch(resumeSkills, jdSkills);

  const presentKeywords = jdSkills
    .filter((jdSkill) =>
      resumeSkills.some((r) => r.keyword === jdSkill.keyword)
    )
    .map((skill) => skill.keyword);

  const missingKeywords = jdSkills
    .filter(
      (jdSkill) =>
        !resumeSkills.some((r) => r.keyword === jdSkill.keyword)
    )
    .map((skill) => skill.keyword)
    .slice(0, 5);

  return {
    engine: 'free',
    matchScore,
    presentKeywords,
    missingKeywords,
    alignmentSummary: null,
    improvementSuggestions: null,
    tailoredCV: null,
    analysedAt: new Date().toISOString(),
  };
}

module.exports = { runJobMatchFree };