"use strict";

/**
 * Skill Synergy Model
 *
 * Detects compound intelligence between related high-value skills.
 * Applies controlled boost to priority score.
 */

function applySkillSynergy({
  scoredSkills,
  profile,
  config,
}) {
  if (!scoredSkills.length) return scoredSkills;

  const skillMap = Object.fromEntries(
    scoredSkills.map((s) => [s.skillId, s])
  );

  for (const skill of scoredSkills) {
    const relatedSkills = skill.dependencySkills ?? [];

    let synergyBoost = 0;

    for (const related of relatedSkills) {
      const relatedSkill = skillMap[related];

      if (
        relatedSkill &&
        relatedSkill.currentProficiency >=
          config.synergy.strongProficiencyThreshold
      ) {
        synergyBoost +=
          config.synergy.relatedSkillBoostWeight;
      }
    }

    synergyBoost = Math.min(
      synergyBoost,
      config.synergy.maxSynergyBoost
    );

    skill.priorityScore = parseFloat(
      Math.min(
        100,
        skill.priorityScore * (1 + synergyBoost)
      ).toFixed(2)
    );

    skill.priorityLevel = classifyPriority(
      skill.priorityScore,
      config
    );
  }

  return scoredSkills;
}

function classifyPriority(score, config) {
  const { high, medium } = config.priorityBands;
  if (score >= high.min) return "HIGH";
  if (score >= medium.min) return "MEDIUM";
  return "LOW";
}

module.exports = {
  applySkillSynergy,
};









