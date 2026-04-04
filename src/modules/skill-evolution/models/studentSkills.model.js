'use strict';

/**
 * src/modules/skill-evolution/models/studentSkills.model.js
 *
 * Supabase row model contracts for Skill Evolution Engine.
 *
 * PostgreSQL tables:
 *   - edu_student_skills
 *   - edu_skill_recommendations
 *
 * This file replaces Firestore document builders with
 * SQL row-safe normalization helpers.
 */

const TABLES = Object.freeze({
  STUDENT_SKILLS: 'edu_student_skills',
  SKILL_RECOMMENDATIONS: 'edu_skill_recommendations',
});

const PROFICIENCY_LEVELS = Object.freeze([
  'beginner',
  'intermediate',
  'advanced',
  'expert',
]);

function normalizeProficiency(level) {
  return PROFICIENCY_LEVELS.includes(level)
    ? level
    : 'beginner';
}

/**
 * Build normalized PostgreSQL row for edu_student_skills
 *
 * @param {string} studentId
 * @param {object} fields
 * @returns {object}
 */
function buildStudentSkillRow(studentId, fields = {}) {
  return {
    student_id: studentId,
    skill_name: fields.skill_name
      ? String(fields.skill_name).trim()
      : null,
    proficiency_level: normalizeProficiency(
      fields.proficiency_level
    ),
    impact_score:
      fields.impact_score != null
        ? Number(fields.impact_score)
        : null,
    career_relevance:
      fields.career_relevance != null
        ? Number(fields.career_relevance)
        : null,
    demand_score:
      fields.demand_score != null
        ? Number(fields.demand_score)
        : null,
  };
}

/**
 * Build normalized PostgreSQL row for edu_skill_recommendations
 *
 * @param {string} studentId
 * @param {object} fields
 * @returns {object}
 */
function buildSkillRecommendationRow(studentId, fields = {}) {
  return {
    student_id: studentId,
    top_career: fields.top_career
      ? String(fields.top_career)
      : null,
    recommended_stream: fields.recommended_stream
      ? String(fields.recommended_stream)
      : null,
    skills: Array.isArray(fields.skills)
      ? fields.skills
      : [],
    roadmap: Array.isArray(fields.roadmap)
      ? fields.roadmap
      : [],
    engine_version: fields.engine_version || '2.0.0',
  };
}

module.exports = {
  TABLES,
  PROFICIENCY_LEVELS,
  buildStudentSkillRow,
  buildSkillRecommendationRow,
};