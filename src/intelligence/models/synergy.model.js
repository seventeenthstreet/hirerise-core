'use strict';

/**
 * Skill Synergy Model (Production Optimized)
 */

function applySkillSynergy({
  scoredSkills = [],
  profile = {},
  config = {},
}) {
  if (!scoredSkills.length) return [];

  const synergyConfig = config.synergy || {};
  const priorityBands = config.priorityBands || {};

  const strongThreshold =
    synergyConfig.strongProficiencyThreshold ?? 70;

  const weight =
    synergyConfig.relatedSkillBoostWeight ?? 0.02;

  const maxBoost =
    synergyConfig.maxSynergyBoost ?? 0.1;

  const skillMap = Object.fromEntries(
    scoredSkills.map((s) => [s.skillId, s])
  );

  return scoredSkills.map((skill) => {
    const relatedSkills = skill.dependencySkills ?? [];

    let synergyBoost = 0;

    for (const related of relatedSkills) {
      const relatedSkill = skillMap[related];

      if (
        relatedSkill &&
        safe(relatedSkill.currentProficiency) >= strongThreshold
      ) {
        synergyBoost += weight;
      }
    }

    synergyBoost = clamp(synergyBoost, 0, maxBoost);

    // 🔥 Controlled additive boost (instead of multiplicative distortion)
    const boostedScore = clamp(
      safe(skill.priorityScore) + synergyBoost * 100,
      0,
      100
    );

    return {
      ...skill,
      priorityScore: round(boostedScore),
      priorityLevel: classifyPriority(boostedScore, priorityBands),

      meta: {
        synergyBoost: round(synergyBoost * 100),
        relatedSkillsCount: relatedSkills.length,
      },
    };
  });
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function classifyPriority(score, bands) {
  const high = bands.high?.min ?? 75;
  const medium = bands.medium?.min ?? 50;

  if (score >= high) return 'HIGH';
  if (score >= medium) return 'MEDIUM';
  return 'LOW';
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function round(val) {
  return parseFloat(val.toFixed(2));
}

function safe(val) {
  return typeof val === 'number' && !isNaN(val) ? val : 0;
}

module.exports = {
  applySkillSynergy,
};