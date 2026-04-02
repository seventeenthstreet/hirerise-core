'use strict';

/**
 * Career Path Engine — v1.0 (Supabase-ready, Firebase-free)
 */

const CAREER_LADDERS = {
  engineering: [
    'junior software engineer', 'software engineer', 'senior software engineer',
    'staff engineer', 'principal engineer', 'distinguished engineer',
  ],
  management: [
    'software engineer', 'tech lead', 'engineering manager',
    'senior engineering manager', 'director of engineering', 'vp of engineering', 'cto',
  ],
  data: [
    'data analyst', 'data scientist', 'senior data scientist',
    'staff data scientist', 'principal data scientist', 'head of data science',
  ],
  product: [
    'associate product manager', 'product manager', 'senior product manager',
    'director of product', 'vp of product', 'chief product officer',
  ],
};

const SKILL_REQUIREMENTS = {
  'senior software engineer': ['system design', 'mentorship', 'code review', 'architecture'],
  'staff engineer': ['cross-team leadership', 'technical strategy', 'org-wide impact', 'system design'],
  'engineering manager': ['people management', 'roadmap planning', 'hiring', 'performance management'],
  'data scientist': ['python', 'machine learning', 'sql', 'statistics'],
  'director of engineering': ['budget management', 'org design', 'executive communication'],
  default: ['communication', 'project management', 'leadership'],
};

class CareerPathEngineV1 {
  get version() {
    return 'career_path_v1.0';
  }

  model({ currentTitle, targetTitle, currentSkills = [] }) {
    if (!currentTitle || !targetTitle) {
      throw new Error('currentTitle and targetTitle are required');
    }

    const normalizedCurrent = currentTitle.toLowerCase().trim();
    const normalizedTarget = targetTitle.toLowerCase().trim();

    const ladder = this._findLadder(normalizedCurrent, normalizedTarget);
    const milestones = this._buildMilestones(normalizedCurrent, normalizedTarget, ladder);
    const skillGaps = this._computeSkillGaps(normalizedTarget, currentSkills);
    const estimatedMonths = milestones.length * 12;

    return {
      currentTitle,
      targetTitle,
      feasible: !!ladder || milestones.length > 0,
      milestones,
      skillGaps,
      estimatedMonths,
      estimatedYears: Math.round((estimatedMonths / 12) * 10) / 10,
      recommendedActions: this._buildActions(skillGaps, milestones),
      engineVersion: this.version,
      modeledAt: new Date().toISOString(),
    };
  }

  _findLadder(current, target) {
    for (const ladder of Object.values(CAREER_LADDERS)) {
      const currentIdx = ladder.indexOf(current);
      const targetIdx = ladder.indexOf(target);

      if (currentIdx !== -1 && targetIdx !== -1 && targetIdx > currentIdx) {
        return ladder;
      }
    }
    return null;
  }

  _buildMilestones(current, target, ladder) {
    if (!ladder) {
      return [{
        title: target,
        description: `Direct transition from ${current} to ${target}`,
        order: 1,
      }];
    }

    const currentIdx = ladder.indexOf(current);
    const targetIdx = ladder.indexOf(target);

    return ladder
      .slice(currentIdx + 1, targetIdx + 1)
      .map((role, i) => ({
        title: role,
        description: `Advance to ${role}`,
        order: i + 1,
        requiredSkills: SKILL_REQUIREMENTS[role] || SKILL_REQUIREMENTS.default,
      }));
  }

  _computeSkillGaps(targetTitle, currentSkills) {
    const required = SKILL_REQUIREMENTS[targetTitle] || SKILL_REQUIREMENTS.default;

    const normalizedCurrent = new Set(
      currentSkills.map((s) => s.toLowerCase().trim())
    );

    return required.filter(
      (skill) => !normalizedCurrent.has(skill.toLowerCase())
    );
  }

  _buildActions(skillGaps, milestones) {
    const actions = skillGaps.map((skill) => ({
      type: 'SKILL_ACQUISITION',
      priority: 'high',
      description: `Develop proficiency in: ${skill}`,
    }));

    if (milestones.length > 1) {
      actions.push({
        type: 'EXPERIENCE',
        priority: 'medium',
        description: `Target ${milestones[0]?.title} as intermediate milestone`,
      });
    }

    actions.push({
      type: 'NETWORKING',
      priority: 'medium',
      description: 'Build relationships with professionals in target role',
    });

    return actions;
  }
}

module.exports = { CareerPathEngineV1 };