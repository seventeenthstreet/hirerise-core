'use strict';

/**
 * career-worker/src/engines/js/career-path-v1.engine.js
 *
 * Career Path Engine — v1.1
 * Production-ready Supabase-native architecture
 *
 * Notes:
 * - Fully Firebase-free
 * - No Firestore assumptions
 * - Pure deterministic engine (safe for worker reuse)
 * - Optimized for hot-path execution
 * - Improved normalization, null safety, and maintainability
 */

const CAREER_LADDERS = Object.freeze({
  engineering: Object.freeze([
    'junior software engineer',
    'software engineer',
    'senior software engineer',
    'staff engineer',
    'principal engineer',
    'distinguished engineer',
  ]),
  management: Object.freeze([
    'software engineer',
    'tech lead',
    'engineering manager',
    'senior engineering manager',
    'director of engineering',
    'vp of engineering',
    'cto',
  ]),
  data: Object.freeze([
    'data analyst',
    'data scientist',
    'senior data scientist',
    'staff data scientist',
    'principal data scientist',
    'head of data science',
  ]),
  product: Object.freeze([
    'associate product manager',
    'product manager',
    'senior product manager',
    'director of product',
    'vp of product',
    'chief product officer',
  ]),
});

const SKILL_REQUIREMENTS = Object.freeze({
  'senior software engineer': Object.freeze([
    'system design',
    'mentorship',
    'code review',
    'architecture',
  ]),
  'staff engineer': Object.freeze([
    'cross-team leadership',
    'technical strategy',
    'org-wide impact',
    'system design',
  ]),
  'engineering manager': Object.freeze([
    'people management',
    'roadmap planning',
    'hiring',
    'performance management',
  ]),
  'data scientist': Object.freeze([
    'python',
    'machine learning',
    'sql',
    'statistics',
  ]),
  'director of engineering': Object.freeze([
    'budget management',
    'org design',
    'executive communication',
  ]),
  default: Object.freeze([
    'communication',
    'project management',
    'leadership',
  ]),
});

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeSkillSet(skills) {
  if (!Array.isArray(skills) || skills.length === 0) {
    return new Set();
  }

  return new Set(
    skills
      .filter(Boolean)
      .map(normalizeText)
      .filter(Boolean)
  );
}

class CareerPathEngineV1 {
  constructor() {
    this._version = 'career_path_v1.1';
  }

  get version() {
    return this._version;
  }

  /**
   * Build a career progression model.
   *
   * @param {Object} input
   * @param {string} input.currentTitle
   * @param {string} input.targetTitle
   * @param {string[]} [input.currentSkills]
   * @returns {Object}
   */
  model({ currentTitle, targetTitle, currentSkills = [] } = {}) {
    const normalizedCurrent = normalizeText(currentTitle);
    const normalizedTarget = normalizeText(targetTitle);

    if (!normalizedCurrent || !normalizedTarget) {
      throw new Error('currentTitle and targetTitle are required');
    }

    const ladder = this._findLadder(normalizedCurrent, normalizedTarget);
    const milestones = this._buildMilestones(
      normalizedCurrent,
      normalizedTarget,
      ladder
    );

    const skillGaps = this._computeSkillGaps(
      normalizedTarget,
      currentSkills
    );

    const estimatedMonths = milestones.length * 12;
    const estimatedYears =
      Math.round((estimatedMonths / 12) * 10) / 10;

    return {
      currentTitle,
      targetTitle,
      feasible: Boolean(ladder || milestones.length),
      milestones,
      skillGaps,
      estimatedMonths,
      estimatedYears,
      recommendedActions: this._buildActions(skillGaps, milestones),
      engineVersion: this.version,
      modeledAt: new Date().toISOString(),
    };
  }

  /**
   * Find the most relevant ladder that supports upward movement.
   *
   * @private
   * @param {string} current
   * @param {string} target
   * @returns {string[]|null}
   */
  _findLadder(current, target) {
    for (const ladder of Object.values(CAREER_LADDERS)) {
      const currentIdx = ladder.indexOf(current);
      const targetIdx = ladder.indexOf(target);

      if (
        currentIdx !== -1 &&
        targetIdx !== -1 &&
        targetIdx > currentIdx
      ) {
        return ladder;
      }
    }

    return null;
  }

  /**
   * Build step-by-step milestone progression.
   *
   * @private
   * @param {string} current
   * @param {string} target
   * @param {string[]|null} ladder
   * @returns {Array}
   */
  _buildMilestones(current, target, ladder) {
    if (!ladder) {
      return [
        {
          title: target,
          description: `Direct transition from ${current} to ${target}`,
          order: 1,
          requiredSkills: this._getRequiredSkills(target),
        },
      ];
    }

    const currentIdx = ladder.indexOf(current);
    const targetIdx = ladder.indexOf(target);

    return ladder
      .slice(currentIdx + 1, targetIdx + 1)
      .map((role, index) => ({
        title: role,
        description: `Advance to ${role}`,
        order: index + 1,
        requiredSkills: this._getRequiredSkills(role),
      }));
  }

  /**
   * Compute missing target-role skills.
   *
   * @private
   * @param {string} targetTitle
   * @param {string[]} currentSkills
   * @returns {string[]}
   */
  _computeSkillGaps(targetTitle, currentSkills) {
    const required = this._getRequiredSkills(targetTitle);
    const normalizedCurrent = normalizeSkillSet(currentSkills);

    return required.filter(
      (skill) => !normalizedCurrent.has(normalizeText(skill))
    );
  }

  /**
   * Build actionable next steps.
   *
   * @private
   * @param {string[]} skillGaps
   * @param {Array} milestones
   * @returns {Array}
   */
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
        description: `Target ${milestones[0].title} as intermediate milestone`,
      });
    }

    actions.push({
      type: 'NETWORKING',
      priority: 'medium',
      description:
        'Build relationships with professionals in target role',
    });

    return actions;
  }

  /**
   * Resolve role skill requirements safely.
   *
   * @private
   * @param {string} role
   * @returns {string[]}
   */
  _getRequiredSkills(role) {
    return SKILL_REQUIREMENTS[role] || SKILL_REQUIREMENTS.default;
  }
}

module.exports = {
  CareerPathEngineV1,
};